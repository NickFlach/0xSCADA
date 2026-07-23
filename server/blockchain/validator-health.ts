/**
 * Validator Node Health Monitoring
 *
 * Polls oxscada validator nodes (0xSCADA-node) over their HTTP JSON-RPC
 * surface — `GET /status`, `GET /health` on port 9090 by default — and
 * raises alerts on degraded validators.
 *
 * Note this is NOT a Tendermint RPC (:26657) client: oxscada nodes expose a
 * purpose-built status shape (Kuramoto phase data, mempool, uptime ticks).
 * See 0xSCADA-node/src/rpc.rs for the authoritative response schema.
 */

import { registry } from '../metrics/prometheus';

// ============================================================================
// oxscada RPC response shapes (mirror 0xSCADA-node/src/rpc.rs)
// ============================================================================

export interface OxscadaPeerPhase {
  node_id: string;
  phase: number;
  natural_freq: number;
  last_updated: number;
}

export interface OxscadaStatus {
  node_id: string;
  height: number;
  role: string;
  /** Kuramoto order parameter r ∈ [0, 1]; 1 = fully phase-coherent validator set */
  order_parameter: number;
  mean_phase: number;
  local_phase: number;
  peer_phases: OxscadaPeerPhase[];
  peers: number;
  mempool: number;
  uptime_ticks: number;
}

/**
 * Strict parse of an oxscada `/status` payload. Throws with a field-specific
 * message on any shape mismatch so schema drift surfaces immediately instead
 * of as NaN gauges.
 */
export function parseOxscadaStatus(raw: unknown): OxscadaStatus {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('status payload is not an object');
  }
  const obj = raw as Record<string, unknown>;

  const str = (field: string): string => {
    if (typeof obj[field] !== 'string') {
      throw new Error(`status field "${field}" is not a string`);
    }
    return obj[field] as string;
  };
  const num = (field: string): number => {
    if (typeof obj[field] !== 'number' || Number.isNaN(obj[field] as number)) {
      throw new Error(`status field "${field}" is not a number`);
    }
    return obj[field] as number;
  };

  if (!Array.isArray(obj.peer_phases)) {
    throw new Error('status field "peer_phases" is not an array');
  }
  const peerPhases: OxscadaPeerPhase[] = (obj.peer_phases as unknown[]).map((p, i) => {
    if (typeof p !== 'object' || p === null) {
      throw new Error(`peer_phases[${i}] is not an object`);
    }
    const pp = p as Record<string, unknown>;
    for (const f of ['phase', 'natural_freq', 'last_updated'] as const) {
      if (typeof pp[f] !== 'number') {
        throw new Error(`peer_phases[${i}].${f} is not a number`);
      }
    }
    if (typeof pp.node_id !== 'string') {
      throw new Error(`peer_phases[${i}].node_id is not a string`);
    }
    return {
      node_id: pp.node_id,
      phase: pp.phase as number,
      natural_freq: pp.natural_freq as number,
      last_updated: pp.last_updated as number,
    };
  });

  return {
    node_id: str('node_id'),
    height: num('height'),
    role: str('role'),
    order_parameter: num('order_parameter'),
    mean_phase: num('mean_phase'),
    local_phase: num('local_phase'),
    peer_phases: peerPhases,
    peers: num('peers'),
    mempool: num('mempool'),
    uptime_ticks: num('uptime_ticks'),
  };
}

// ============================================================================
// Monitor configuration
// ============================================================================

export interface ValidatorThresholds {
  /** Minimum connected peers before warning (0 peers is always critical) */
  minPeers: number;
  /** Minimum Kuramoto order parameter before the validator set counts as decoherent */
  minOrderParameter: number;
  /** Blocks a node may trail the highest observed height before warning */
  maxHeightLag: number;
  /** Consecutive checks without height progress before warning */
  maxStalledChecks: number;
}

export const DEFAULT_THRESHOLDS: ValidatorThresholds = {
  minPeers: 1,
  minOrderParameter: 0.8,
  maxHeightLag: 10,
  maxStalledChecks: 3,
};

export interface ValidatorNodeConfig {
  name: string;
  /** Base URL of the oxscada RPC server, e.g. http://localhost:9090 */
  rpcUrl: string;
  checkIntervalMs?: number;
  thresholds?: Partial<ValidatorThresholds>;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface ValidatorAlert {
  severity: AlertSeverity;
  code:
    | 'unreachable'
    | 'bad-status-shape'
    | 'no-peers'
    | 'low-peers'
    | 'decoherent'
    | 'height-lag'
    | 'height-stalled'
    | 'recovered';
  message: string;
  at: number;
}

export interface ValidatorNodeStatus {
  name: string;
  rpcUrl: string;
  healthy: boolean;
  reachable: boolean;
  lastChecked: number | null;
  lastSeenHealthy: number | null;
  consecutiveFailures: number;
  stalledChecks: number;
  status: OxscadaStatus | null;
  alerts: ValidatorAlert[];
}

export type AlertHandler = (alert: ValidatorAlert, nodeName: string) => void;

/** Injectable for tests; defaults to global fetch (Node 18+). */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

// ============================================================================
// Prometheus gauges (label: validator name)
// ============================================================================

const validatorUp = registry.gauge(
  'blockchain_validator_up',
  'Whether the oxscada validator RPC is reachable and parseable (1/0)',
  ['validator']
);
const validatorHeight = registry.gauge(
  'blockchain_validator_height',
  'Latest ledger height reported by the validator',
  ['validator']
);
const validatorPeers = registry.gauge(
  'blockchain_validator_peers',
  'Connected peer count reported by the validator',
  ['validator']
);
const validatorMempool = registry.gauge(
  'blockchain_validator_mempool_size',
  'Mempool size reported by the validator',
  ['validator']
);
const validatorOrderParameter = registry.gauge(
  'blockchain_validator_order_parameter',
  'Kuramoto order parameter (phase coherence, 0-1) reported by the validator',
  ['validator']
);
const validatorLastSeen = registry.gauge(
  'blockchain_validator_last_seen_timestamp_seconds',
  'Unix time of the last successful status poll for the validator',
  ['validator']
);

// ============================================================================
// Monitor
// ============================================================================

interface NodeState {
  config: ValidatorNodeConfig;
  thresholds: ValidatorThresholds;
  status: ValidatorNodeStatus;
  lastHeight: number | null;
  timer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

export class ValidatorHealthMonitor {
  private nodes = new Map<string, NodeState>();
  private alertHandlers: AlertHandler[] = [];
  private fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? (fetch as unknown as FetchLike);
  }

  addNode(config: ValidatorNodeConfig): void {
    if (this.nodes.has(config.name)) {
      throw new Error(`validator "${config.name}" is already registered`);
    }
    this.nodes.set(config.name, {
      config,
      thresholds: { ...DEFAULT_THRESHOLDS, ...config.thresholds },
      status: {
        name: config.name,
        rpcUrl: config.rpcUrl,
        healthy: false,
        reachable: false,
        lastChecked: null,
        lastSeenHealthy: null,
        consecutiveFailures: 0,
        stalledChecks: 0,
        status: null,
        alerts: [],
      },
      lastHeight: null,
      timer: null,
    });
  }

  removeNode(name: string): void {
    this.stopMonitoring(name);
    this.nodes.delete(name);
  }

  onAlert(handler: AlertHandler): void {
    this.alertHandlers.push(handler);
  }

  startMonitoring(name?: string): void {
    for (const node of this.selectNodes(name)) {
      if (node.timer) continue;
      const interval = node.config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
      node.timer = setInterval(() => {
        void this.checkNode(node.config.name);
      }, interval);
      // Never keep the process alive just for monitoring
      node.timer.unref?.();
      void this.checkNode(node.config.name);
    }
  }

  stopMonitoring(name?: string): void {
    for (const node of this.selectNodes(name)) {
      if (node.timer) {
        clearInterval(node.timer);
        node.timer = null;
      }
    }
  }

  async checkNode(name: string): Promise<ValidatorNodeStatus> {
    const node = this.nodes.get(name);
    if (!node) {
      throw new Error(`unknown validator "${name}"`);
    }

    const now = Date.now();
    node.status.lastChecked = now;
    const alerts: ValidatorAlert[] = [];

    let parsed: OxscadaStatus | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(`${node.config.rpcUrl.replace(/\/$/, '')}/status`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`/status returned HTTP ${res.status}`);
        }
        parsed = parseOxscadaStatus(await res.json());
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const shapeError = message.startsWith('status field') || message.startsWith('peer_phases');
      node.status.reachable = false;
      node.status.consecutiveFailures++;
      alerts.push({
        severity: 'critical',
        code: shapeError ? 'bad-status-shape' : 'unreachable',
        message: `${name}: ${shapeError ? 'unexpected /status shape' : 'status poll failed'} (${message})`,
        at: now,
      });
    }

    if (parsed) {
      const wasUnhealthy = !node.status.healthy && node.status.lastSeenHealthy !== null;
      node.status.reachable = true;
      node.status.consecutiveFailures = 0;
      node.status.status = parsed;

      // Height progress tracking
      if (node.lastHeight !== null && parsed.height <= node.lastHeight) {
        node.status.stalledChecks++;
      } else {
        node.status.stalledChecks = 0;
      }
      node.lastHeight = parsed.height;

      alerts.push(...this.evaluate(node, parsed, now));

      const healthyNow = alerts.every(a => a.severity === 'info');
      if (healthyNow) {
        node.status.lastSeenHealthy = now;
        if (wasUnhealthy) {
          alerts.push({
            severity: 'info',
            code: 'recovered',
            message: `${name}: validator healthy again`,
            at: now,
          });
        }
      }

      validatorUp.set(1, { validator: name });
      validatorHeight.set(parsed.height, { validator: name });
      validatorPeers.set(parsed.peers, { validator: name });
      validatorMempool.set(parsed.mempool, { validator: name });
      validatorOrderParameter.set(parsed.order_parameter, { validator: name });
      validatorLastSeen.set(now / 1000, { validator: name });
    } else {
      validatorUp.set(0, { validator: name });
    }

    node.status.healthy =
      node.status.reachable && alerts.every(a => a.severity === 'info');
    node.status.alerts = alerts;

    for (const alert of alerts) {
      for (const handler of this.alertHandlers) {
        handler(alert, name);
      }
    }

    return { ...node.status };
  }

  private evaluate(node: NodeState, status: OxscadaStatus, now: number): ValidatorAlert[] {
    const t = node.thresholds;
    const alerts: ValidatorAlert[] = [];

    if (status.peers === 0) {
      alerts.push({
        severity: 'critical',
        code: 'no-peers',
        message: `${node.config.name}: validator has no connected peers`,
        at: now,
      });
    } else if (status.peers < t.minPeers) {
      alerts.push({
        severity: 'warning',
        code: 'low-peers',
        message: `${node.config.name}: ${status.peers} peers (minimum ${t.minPeers})`,
        at: now,
      });
    }

    if (status.order_parameter < t.minOrderParameter) {
      alerts.push({
        severity: 'warning',
        code: 'decoherent',
        message: `${node.config.name}: Kuramoto order parameter ${status.order_parameter.toFixed(3)} below ${t.minOrderParameter}`,
        at: now,
      });
    }

    const maxHeight = this.highestKnownHeight();
    if (maxHeight !== null && maxHeight - status.height > t.maxHeightLag) {
      alerts.push({
        severity: 'warning',
        code: 'height-lag',
        message: `${node.config.name}: height ${status.height} trails cluster max ${maxHeight} by more than ${t.maxHeightLag}`,
        at: now,
      });
    }

    if (node.status.stalledChecks >= t.maxStalledChecks) {
      alerts.push({
        severity: 'warning',
        code: 'height-stalled',
        message: `${node.config.name}: height ${status.height} unchanged for ${node.status.stalledChecks} checks`,
        at: now,
      });
    }

    return alerts;
  }

  private highestKnownHeight(): number | null {
    let max: number | null = null;
    for (const node of this.nodes.values()) {
      const h = node.status.status?.height;
      if (typeof h === 'number' && (max === null || h > max)) {
        max = h;
      }
    }
    return max;
  }

  getStatus(name: string): ValidatorNodeStatus | undefined {
    const node = this.nodes.get(name);
    return node ? { ...node.status } : undefined;
  }

  getAllStatuses(): ValidatorNodeStatus[] {
    return Array.from(this.nodes.values(), n => ({ ...n.status }));
  }

  getUnhealthyNodes(): ValidatorNodeStatus[] {
    return this.getAllStatuses().filter(s => !s.healthy);
  }

  getSummary(): { total: number; healthy: number; unhealthy: number } {
    const all = this.getAllStatuses();
    const healthy = all.filter(s => s.healthy).length;
    return { total: all.length, healthy, unhealthy: all.length - healthy };
  }

  private selectNodes(name?: string): NodeState[] {
    if (name === undefined) {
      return Array.from(this.nodes.values());
    }
    const node = this.nodes.get(name);
    if (!node) {
      throw new Error(`unknown validator "${name}"`);
    }
    return [node];
  }
}
