/**
 * OPC-UA Connection Manager and Session Handling
 *
 * Issue #11 child: 6.1.1 - OPC-UA Connection Manager
 * Epic 6.1: OPC-UA Protocol Driver
 *
 * Features:
 * - OPC-UA client connection management
 * - Session lifecycle: connect, reconnect, disconnect
 * - Connection pooling for multiple OPC-UA endpoints
 * - Auto-reconnect on session drops
 * - Health checking / heartbeat for connections
 */

import { EventEmitter } from "events";
import {
  OPCUAClient,
  SecurityPolicy,
  MessageSecurityMode,
} from "node-opcua-client";

// =============================================================================
// TYPES
// =============================================================================

export interface OpcUaEndpointConfig {
  /** OPC-UA endpoint URL, e.g. opc.tcp://localhost:4840 */
  endpointUrl: string;
  /** Unique name for this connection */
  name: string;
  /** Security policy (default: None) */
  securityPolicy?: string;
  /** Security mode (default: None) */
  securityMode?: string;
  /** Username for UserName authentication */
  username?: string;
  /** Password for UserName authentication */
  password?: string;
  /** Certificate path for certificate-based auth */
  certificatePath?: string;
  /** Private key path */
  privateKeyPath?: string;
}

export interface OpcUaManagerConfig {
  /** Interval between reconnect attempts in ms (default: 5000) */
  reconnectInterval: number;
  /** Max reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts: number;
  /** Interval for health check pings in ms (default: 10000) */
  healthCheckInterval: number;
  /** Session timeout in ms (default: 60000) */
  sessionTimeout: number;
}

export interface ConnectionState {
  name: string;
  endpointUrl: string;
  status: "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
  connectedAt: Date | null;
  lastHealthCheck: Date | null;
  reconnectCount: number;
  lastError: string | null;
}

export interface HealthReport {
  name: string;
  endpointUrl: string;
  healthy: boolean;
  status: string;
  lastHealthCheck: Date | null;
  reconnectCount: number;
}

// =============================================================================
// INTERNAL CONNECTION ENTRY
// =============================================================================

interface ConnectionEntry {
  config: OpcUaEndpointConfig;
  client: any; // OPCUAClient instance
  session: any; // ClientSession instance
  state: ConnectionState;
  healthTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
}

// =============================================================================
// CONNECTION MANAGER
// =============================================================================

const DEFAULT_CONFIG: OpcUaManagerConfig = {
  reconnectInterval: 5000,
  maxReconnectAttempts: 10,
  healthCheckInterval: 10000,
  sessionTimeout: 60000,
};

export class OpcUaConnectionManager extends EventEmitter {
  private connections = new Map<string, ConnectionEntry>();
  private config: OpcUaManagerConfig;

  constructor(config?: Partial<OpcUaManagerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Prevent Node from crashing on unhandled "error" events.
    // Consumers should attach their own "error" listener for proper handling.
    this.on("error", () => {});
  }

  // ---------------------------------------------------------------------------
  // CONNECT
  // ---------------------------------------------------------------------------

  async connect(endpoint: OpcUaEndpointConfig): Promise<void> {
    if (this.connections.has(endpoint.name)) {
      const existing = this.connections.get(endpoint.name)!;
      if (existing.state.status === "connected" || existing.state.status === "connecting") {
        throw new Error(`Connection '${endpoint.name}' already exists`);
      }
    }

    const securityPolicy =
      endpoint.securityPolicy
        ? (SecurityPolicy as any)[endpoint.securityPolicy] ?? SecurityPolicy.None
        : SecurityPolicy.None;

    const securityMode =
      endpoint.securityMode
        ? (MessageSecurityMode as any)[endpoint.securityMode] ?? MessageSecurityMode.None
        : MessageSecurityMode.None;

    const client = OPCUAClient.create({
      securityPolicy,
      securityMode,
      endpointMustExist: false,
      requestedSessionTimeout: this.config.sessionTimeout,
    } as any);

    const entry: ConnectionEntry = {
      config: endpoint,
      client,
      session: null,
      state: {
        name: endpoint.name,
        endpointUrl: endpoint.endpointUrl,
        status: "connecting",
        connectedAt: null,
        lastHealthCheck: null,
        reconnectCount: 0,
        lastError: null,
      },
      healthTimer: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
    };

    this.connections.set(endpoint.name, entry);

    try {
      await client.connect(endpoint.endpointUrl);

      const session = endpoint.username
        ? await client.createSession({
            userName: endpoint.username,
            password: endpoint.password,
          } as any)
        : await client.createSession();

      entry.session = session;
      entry.state.status = "connected";
      entry.state.connectedAt = new Date();
      entry.state.lastError = null;

      this.startHealthCheck(endpoint.name);
      this.emit("connected", { name: endpoint.name, endpointUrl: endpoint.endpointUrl });
    } catch (err: any) {
      entry.state.status = "error";
      entry.state.lastError = err.message;
      this.emit("error", { name: endpoint.name, endpointUrl: endpoint.endpointUrl }, err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // DISCONNECT
  // ---------------------------------------------------------------------------

  async disconnect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    this.stopTimers(entry);

    try {
      if (entry.session) {
        await entry.session.close();
      }
      if (entry.client) {
        await entry.client.disconnect();
      }
    } catch {
      // Best-effort cleanup
    }

    entry.session = null;
    entry.state.status = "disconnected";
    this.emit("disconnected", { name, endpointUrl: entry.config.endpointUrl });
  }

  // ---------------------------------------------------------------------------
  // SHUTDOWN
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((n) => this.disconnect(n)));
  }

  // ---------------------------------------------------------------------------
  // SESSION ACCESS
  // ---------------------------------------------------------------------------

  getSession(name: string): any | null {
    return this.connections.get(name)?.session ?? null;
  }

  getConnectionState(name: string): ConnectionState | undefined {
    return this.connections.get(name)?.state;
  }

  getAllConnections(): ConnectionState[] {
    return [...this.connections.values()].map((e) => ({ ...e.state }));
  }

  // ---------------------------------------------------------------------------
  // HEALTH CHECK
  // ---------------------------------------------------------------------------

  private startHealthCheck(name: string): void {
    const entry = this.connections.get(name);
    if (!entry) return;

    entry.healthTimer = setInterval(async () => {
      await this.performHealthCheck(name);
    }, this.config.healthCheckInterval);
  }

  private async performHealthCheck(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry || !entry.session) return;

    try {
      // Read server status node as heartbeat
      await entry.session.read({ nodeId: "ns=0;i=2258", attributeId: 13 } as any);
      entry.state.lastHealthCheck = new Date();
      this.emit("healthCheck", { name, healthy: true });
    } catch {
      // Health check failed - trigger reconnect
      entry.state.lastHealthCheck = new Date();
      this.emit("healthCheck", { name, healthy: false });
      this.triggerReconnect(name);
    }
  }

  getHealthReport(): HealthReport[] {
    return [...this.connections.values()].map((e) => ({
      name: e.state.name,
      endpointUrl: e.state.endpointUrl,
      healthy: e.state.status === "connected",
      status: e.state.status,
      lastHealthCheck: e.state.lastHealthCheck,
      reconnectCount: e.state.reconnectCount,
    }));
  }

  // ---------------------------------------------------------------------------
  // AUTO-RECONNECT
  // ---------------------------------------------------------------------------

  /** Simulate a session drop for testing purposes */
  simulateSessionDrop(name: string): void {
    this.triggerReconnect(name);
  }

  private triggerReconnect(name: string): void {
    const entry = this.connections.get(name);
    if (!entry || entry.state.status === "reconnecting") return;

    this.stopTimers(entry);
    entry.state.status = "reconnecting";
    entry.reconnectAttempts = 0;
    entry.session = null;

    this.scheduleReconnect(name);
  }

  private scheduleReconnect(name: string): void {
    const entry = this.connections.get(name);
    if (!entry) return;

    entry.reconnectTimer = setTimeout(async () => {
      await this.attemptReconnect(name);
    }, this.config.reconnectInterval);
  }

  private async attemptReconnect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry || entry.state.status === "disconnected") return;

    entry.reconnectAttempts++;
    entry.state.reconnectCount++;

    try {
      // Create fresh client
      const client = OPCUAClient.create({
        securityPolicy: SecurityPolicy.None,
        securityMode: MessageSecurityMode.None,
        endpointMustExist: false,
      } as any);

      await client.connect(entry.config.endpointUrl);
      const session = await client.createSession();

      entry.client = client;
      entry.session = session;
      entry.state.status = "connected";
      entry.state.connectedAt = new Date();
      entry.state.lastError = null;
      entry.reconnectAttempts = 0;

      this.startHealthCheck(name);
      this.emit("reconnected", { name, endpointUrl: entry.config.endpointUrl });
    } catch (err: any) {
      if (entry.reconnectAttempts >= this.config.maxReconnectAttempts) {
        entry.state.status = "error";
        entry.state.lastError = `Max reconnect attempts reached: ${err.message}`;
        this.emit("error", { name, endpointUrl: entry.config.endpointUrl }, err);
      } else {
        this.scheduleReconnect(name);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  private stopTimers(entry: ConnectionEntry): void {
    if (entry.healthTimer) {
      clearInterval(entry.healthTimer);
      entry.healthTimer = null;
    }
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }
}
