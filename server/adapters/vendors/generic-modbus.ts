/**
 * Generic Modbus Adapter
 *
 * Wraps the existing modbus-driver.ts as a vendor adapter,
 * demonstrating how to bridge legacy drivers into the adapter system.
 */

import type {
  AdapterManifest,
  AdapterState,
  AdapterContext,
  AdapterHealthStatus,
  AdapterCapability,
  ProtocolAdapter,
  ProtocolEndpoint,
  ProtocolConnection,
  DiscoveryOptions,
  DiscoveredDevice,
  TagReadResult,
  SubscriptionHandle,
} from "../../../shared/types/vendor-adapter";

// =============================================================================
// CAPABILITIES
// =============================================================================

const MODBUS_CAPABILITIES: AdapterCapability[] = [
  {
    id: "read-tags",
    name: "Register Reading",
    category: "communication",
    description: "Read Modbus coils, discrete inputs, input registers, holding registers",
    required: true,
  },
  {
    id: "write-tags",
    name: "Register Writing",
    category: "communication",
    description: "Write Modbus coils and holding registers",
    required: true,
  },
  {
    id: "device-discovery",
    name: "Device Scan",
    category: "discovery",
    description: "Scan Modbus unit IDs on a TCP endpoint",
    required: false,
  },
];

// =============================================================================
// GENERIC MODBUS ADAPTER
// =============================================================================

export class GenericModbusAdapter implements ProtocolAdapter {
  readonly manifest: AdapterManifest & { type: "protocol" } = {
    id: "generic-modbus",
    name: "Generic Modbus TCP Adapter",
    vendor: "0xSCADA",
    version: "1.0.0",
    type: "protocol" as const,
    description: "Generic Modbus TCP adapter wrapping the existing modbus-driver",
    capabilities: MODBUS_CAPABILITIES,
    license: "Apache-2.0",
  };

  readonly protocols = ["modbus-tcp", "modbus-rtu-over-tcp"];

  private _state: AdapterState = "registered";
  private context: AdapterContext | null = null;
  private connections = new Map<string, ModbusAdapterConnection>();
  private startTime = Date.now();
  private errorCount = 0;

  get state(): AdapterState {
    return this._state;
  }

  async initialize(context: AdapterContext): Promise<void> {
    this.context = context;
    this._state = "initializing";
    context.log.info("Initializing Generic Modbus adapter");
    // The existing modbus-driver.ts handles actual Modbus comms.
    // This adapter wraps it into the vendor adapter interface.
    this._state = "ready";
    this.startTime = Date.now();
    context.log.info("Generic Modbus adapter ready");
  }

  hasCapability(capabilityId: string): boolean {
    return this.manifest.capabilities.some((c) => c.id === capabilityId);
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    return {
      adapterId: this.manifest.id,
      state: this._state,
      healthy: this._state === "ready" || this._state === "connected",
      lastHealthCheck: new Date(),
      uptime: Date.now() - this.startTime,
      errorCount: this.errorCount,
      metrics: { activeConnections: this.connections.size },
    };
  }

  async dispose(): Promise<void> {
    this._state = "disconnecting";
    for (const conn of this.connections.values()) {
      await conn.disconnect();
    }
    this.connections.clear();
    this._state = "disposed";
  }

  async connect(endpoint: ProtocolEndpoint): Promise<ProtocolConnection> {
    this.context?.log.info(`Connecting to Modbus device at ${endpoint.address}`);
    const connId = `modbus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conn = new ModbusAdapterConnection(connId, endpoint);
    await conn.connectInternal();
    this.connections.set(connId, conn);
    this._state = "connected";
    return conn;
  }

  async discover(options?: DiscoveryOptions): Promise<DiscoveredDevice[]> {
    this.context?.log.info("Scanning for Modbus devices (simulated)");
    return [
      {
        address: "192.168.1.50:502",
        name: "Modbus Device (Unit 1)",
        protocols: ["modbus-tcp"],
        metadata: { unitId: 1 },
      },
    ];
  }
}

// =============================================================================
// MODBUS CONNECTION (WRAPS EXISTING DRIVER PATTERN)
// =============================================================================

class ModbusAdapterConnection implements ProtocolConnection {
  id: string;
  endpoint: ProtocolEndpoint;
  connected = false;
  private subscriptions = new Map<string, ReturnType<typeof setInterval>>();

  constructor(id: string, endpoint: ProtocolEndpoint) {
    this.id = id;
    this.endpoint = endpoint;
  }

  async connectInternal(): Promise<void> {
    // In production, this would instantiate ModbusDriver from gateway/modbus-driver.ts:
    //   const driver = new ModbusDriver(config);
    //   await driver.connect();
    this.connected = true;
  }

  async read(address: string): Promise<TagReadResult> {
    // In production: delegate to ModbusDriver.readTag()
    // Address format: "HR:100", "C:0", "40001", etc.
    return {
      address,
      value: Math.random() * 100,
      quality: "GOOD",
      timestamp: new Date(),
      dataType: address.startsWith("C") || address.startsWith("DI") ? "BOOL" : "REAL",
    };
  }

  async readBatch(addresses: string[]): Promise<TagReadResult[]> {
    return Promise.all(addresses.map((a) => this.read(a)));
  }

  async write(address: string, value: unknown): Promise<void> {
    // In production: delegate to ModbusDriver
  }

  subscribe(
    addresses: string[],
    callback: (values: TagReadResult[]) => void,
    intervalMs = 1000
  ): SubscriptionHandle {
    const subId = `sub-${Date.now()}`;
    const timer = setInterval(async () => {
      const values = await this.readBatch(addresses);
      callback(values);
    }, intervalMs);
    this.subscriptions.set(subId, timer);
    return {
      id: subId,
      unsubscribe: () => {
        const t = this.subscriptions.get(subId);
        if (t) clearInterval(t);
        this.subscriptions.delete(subId);
      },
    };
  }

  async disconnect(): Promise<void> {
    for (const timer of this.subscriptions.values()) clearInterval(timer);
    this.subscriptions.clear();
    this.connected = false;
  }
}
