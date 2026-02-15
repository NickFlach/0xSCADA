/**
 * Validator Node Health Monitoring & Alerting
 * 
 * Issue #57 — Monitor validator node status, block production,
 * peer connections, sync status. Alert on degraded performance.
 */

import { EventEmitter } from 'events';

// =============================================================================
// TYPES
// =============================================================================

export interface ValidatorNodeConfig {
  /** Node RPC endpoint */
  rpcUrl: string;
  /** Node name for display */
  name: string;
  /** Check interval in ms */
  checkIntervalMs?: number;
  /** Alert thresholds */
  thresholds?: AlertThresholds;
}

export interface AlertThresholds {
  /** Min peer count before alerting */
  minPeers: number;
  /** Max blocks behind before alerting */
  maxBlocksBehind: number;
  /** Max seconds since last block before alerting */
  maxBlockAgeSec: number;
  /** Min uptime percentage */
  minUptimePercent: number;
}

export interface ValidatorStatus {
  name: string;
  rpcUrl: string;
  healthy: boolean;
  lastChecked: Date;
  blockHeight: number;
  latestBlockTime: Date | null;
  peerCount: number;
  isSyncing: boolean;
  uptimePercent: number;
  alerts: ValidatorAlert[];
}

export interface ValidatorAlert {
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: Date;
  metric: string;
  value: number | string;
  threshold: number | string;
}

export type AlertCallback = (alert: ValidatorAlert, node: string) => void;

// =============================================================================
// HEALTH MONITOR
// =============================================================================

export class ValidatorHealthMonitor extends EventEmitter {
  private nodes: Map<string, ValidatorNodeConfig> = new Map();
  private statuses: Map<string, ValidatorStatus> = new Map();
  private checkTimers: Map<string, NodeJS.Timeout> = new Map();
  private alertCallbacks: AlertCallback[] = [];
  private checkCounts: Map<string, { total: number; healthy: number }> = new Map();

  private defaultThresholds: AlertThresholds = {
    minPeers: 3,
    maxBlocksBehind: 10,
    maxBlockAgeSec: 120,
    minUptimePercent: 95,
  };

  // ===========================================================================
  // NODE MANAGEMENT
  // ===========================================================================

  addNode(config: ValidatorNodeConfig): void {
    this.nodes.set(config.name, config);
    this.checkCounts.set(config.name, { total: 0, healthy: 0 });
    console.log(`[ValidatorHealth] Added node: ${config.name} (${config.rpcUrl})`);
  }

  removeNode(name: string): void {
    this.stopMonitoring(name);
    this.nodes.delete(name);
    this.statuses.delete(name);
    this.checkCounts.delete(name);
  }

  // ===========================================================================
  // MONITORING
  // ===========================================================================

  startMonitoring(name?: string): void {
    const targets = name ? [name] : Array.from(this.nodes.keys());

    for (const nodeName of targets) {
      const config = this.nodes.get(nodeName);
      if (!config) continue;

      // Stop existing timer
      this.stopMonitoring(nodeName);

      const intervalMs = config.checkIntervalMs || 30000;
      
      // Immediate check
      this.checkNode(nodeName);

      // Periodic checks
      const timer = setInterval(() => this.checkNode(nodeName), intervalMs);
      this.checkTimers.set(nodeName, timer);

      console.log(`[ValidatorHealth] Monitoring ${nodeName} every ${intervalMs / 1000}s`);
    }
  }

  stopMonitoring(name?: string): void {
    const targets = name ? [name] : Array.from(this.checkTimers.keys());
    for (const nodeName of targets) {
      const timer = this.checkTimers.get(nodeName);
      if (timer) {
        clearInterval(timer);
        this.checkTimers.delete(nodeName);
      }
    }
  }

  // ===========================================================================
  // HEALTH CHECKS
  // ===========================================================================

  async checkNode(name: string): Promise<ValidatorStatus> {
    const config = this.nodes.get(name);
    if (!config) throw new Error(`Unknown node: ${name}`);

    const thresholds = config.thresholds || this.defaultThresholds;
    const alerts: ValidatorAlert[] = [];
    let healthy = true;

    let blockHeight = 0;
    let latestBlockTime: Date | null = null;
    let peerCount = 0;
    let isSyncing = false;

    try {
      // Fetch node status via JSON-RPC
      const status = await this.fetchNodeStatus(config.rpcUrl);
      blockHeight = status.blockHeight;
      latestBlockTime = status.latestBlockTime;
      peerCount = status.peerCount;
      isSyncing = status.isSyncing;

      // Check peer count
      if (peerCount < thresholds.minPeers) {
        healthy = false;
        alerts.push({
          severity: peerCount === 0 ? 'critical' : 'warning',
          message: `Low peer count: ${peerCount} (min: ${thresholds.minPeers})`,
          timestamp: new Date(),
          metric: 'peerCount',
          value: peerCount,
          threshold: thresholds.minPeers,
        });
      }

      // Check block age
      if (latestBlockTime) {
        const ageSec = (Date.now() - latestBlockTime.getTime()) / 1000;
        if (ageSec > thresholds.maxBlockAgeSec) {
          healthy = false;
          alerts.push({
            severity: ageSec > thresholds.maxBlockAgeSec * 3 ? 'critical' : 'warning',
            message: `Stale block: ${ageSec.toFixed(0)}s old (max: ${thresholds.maxBlockAgeSec}s)`,
            timestamp: new Date(),
            metric: 'blockAge',
            value: ageSec,
            threshold: thresholds.maxBlockAgeSec,
          });
        }
      }

      // Check syncing
      if (isSyncing) {
        alerts.push({
          severity: 'info',
          message: 'Node is syncing',
          timestamp: new Date(),
          metric: 'syncing',
          value: 'true',
          threshold: 'false',
        });
      }
    } catch (err: any) {
      healthy = false;
      alerts.push({
        severity: 'critical',
        message: `Node unreachable: ${err.message}`,
        timestamp: new Date(),
        metric: 'reachability',
        value: 'unreachable',
        threshold: 'reachable',
      });
    }

    // Update uptime tracking
    const counts = this.checkCounts.get(name) || { total: 0, healthy: 0 };
    counts.total++;
    if (healthy) counts.healthy++;
    this.checkCounts.set(name, counts);

    const uptimePercent = counts.total > 0 ? (counts.healthy / counts.total) * 100 : 100;

    // Check uptime
    if (uptimePercent < thresholds.minUptimePercent && counts.total > 10) {
      alerts.push({
        severity: 'warning',
        message: `Low uptime: ${uptimePercent.toFixed(1)}% (min: ${thresholds.minUptimePercent}%)`,
        timestamp: new Date(),
        metric: 'uptime',
        value: uptimePercent,
        threshold: thresholds.minUptimePercent,
      });
    }

    const status: ValidatorStatus = {
      name,
      rpcUrl: config.rpcUrl,
      healthy,
      lastChecked: new Date(),
      blockHeight,
      latestBlockTime,
      peerCount,
      isSyncing,
      uptimePercent,
      alerts,
    };

    this.statuses.set(name, status);

    // Emit alerts
    for (const alert of alerts) {
      this.emit('alert', alert, name);
      for (const cb of this.alertCallbacks) {
        cb(alert, name);
      }
    }

    if (!healthy) {
      this.emit('unhealthy', status);
    }

    return status;
  }

  // ===========================================================================
  // RPC INTERFACE (override for real implementations)
  // ===========================================================================

  protected async fetchNodeStatus(rpcUrl: string): Promise<{
    blockHeight: number;
    latestBlockTime: Date | null;
    peerCount: number;
    isSyncing: boolean;
  }> {
    // Default: HTTP JSON-RPC call
    const response = await fetch(`${rpcUrl}/status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as any;

    return {
      blockHeight: data.result?.sync_info?.latest_block_height || data.blockHeight || 0,
      latestBlockTime: data.result?.sync_info?.latest_block_time
        ? new Date(data.result.sync_info.latest_block_time)
        : null,
      peerCount: data.result?.n_peers || data.peerCount || 0,
      isSyncing: data.result?.sync_info?.catching_up || data.syncing || false,
    };
  }

  // ===========================================================================
  // ALERT MANAGEMENT
  // ===========================================================================

  onAlert(callback: AlertCallback): void {
    this.alertCallbacks.push(callback);
  }

  // ===========================================================================
  // STATUS QUERIES
  // ===========================================================================

  getStatus(name: string): ValidatorStatus | undefined {
    return this.statuses.get(name);
  }

  getAllStatuses(): ValidatorStatus[] {
    return Array.from(this.statuses.values());
  }

  getUnhealthyNodes(): ValidatorStatus[] {
    return this.getAllStatuses().filter((s) => !s.healthy);
  }

  getSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    nodes: Array<{ name: string; healthy: boolean; blockHeight: number; peerCount: number }>;
  } {
    const all = this.getAllStatuses();
    return {
      total: all.length,
      healthy: all.filter((s) => s.healthy).length,
      unhealthy: all.filter((s) => !s.healthy).length,
      nodes: all.map((s) => ({
        name: s.name,
        healthy: s.healthy,
        blockHeight: s.blockHeight,
        peerCount: s.peerCount,
      })),
    };
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  dispose(): void {
    this.stopMonitoring();
    this.removeAllListeners();
    this.alertCallbacks = [];
  }
}
