/**
 * Siemens S7 Reference Adapter
 *
 * Protocol + Device adapter for Siemens S7 PLCs (S7-300/400/1200/1500).
 * This is a reference implementation showing vendor-specific capabilities.
 */

import type {
  AdapterManifest,
  AdapterState,
  AdapterContext,
  AdapterHealthStatus,
  AdapterCapability,
  ProtocolAdapter,
  DeviceAdapter,
  ProtocolEndpoint,
  ProtocolConnection,
  DiscoveryOptions,
  DiscoveredDevice,
  DeviceDiagnostics,
  DeviceConfiguration,
  FirmwareInfo,
  TagReadResult,
  SubscriptionHandle,
} from "../../../shared/types/vendor-adapter";

// =============================================================================
// S7-SPECIFIC TYPES
// =============================================================================

export interface S7ConnectionOptions {
  rack?: number;
  slot?: number;
  localTSAP?: number;
  remoteTSAP?: number;
}

// =============================================================================
// CAPABILITIES
// =============================================================================

const S7_CAPABILITIES: AdapterCapability[] = [
  {
    id: "read-tags",
    name: "Tag Reading",
    category: "communication",
    description: "Read S7 data blocks, inputs, outputs, markers, timers, counters",
    required: true,
  },
  {
    id: "write-tags",
    name: "Tag Writing",
    category: "communication",
    description: "Write to S7 data areas",
    required: true,
  },
  {
    id: "device-discovery",
    name: "Network Discovery",
    category: "discovery",
    description: "Discover S7 devices via PROFINET DCP",
    required: false,
  },
  {
    id: "diagnostics",
    name: "PLC Diagnostics",
    category: "diagnostics",
    description: "Read CPU state, diagnostic buffer, LED status",
    required: false,
  },
  {
    id: "firmware-info",
    name: "Firmware Information",
    category: "firmware",
    description: "Read firmware version and module information",
    required: false,
  },
  {
    id: "block-transfer",
    name: "Block Transfer",
    category: "configuration",
    description: "Upload/download S7 program blocks (vendor-specific)",
    required: false,
  },
];

// =============================================================================
// S7 PROTOCOL + DEVICE ADAPTER
// =============================================================================

export class SiemensS7Adapter implements ProtocolAdapter, DeviceAdapter {
  readonly manifest: AdapterManifest & { type: "protocol" } = {
    id: "siemens-s7",
    name: "Siemens S7 Protocol Adapter",
    vendor: "Siemens",
    version: "1.0.0",
    type: "protocol" as const,
    description: "Protocol and device adapter for Siemens S7 PLCs",
    capabilities: S7_CAPABILITIES,
    license: "Apache-2.0",
  };

  readonly protocols = ["s7", "s7comm", "s7comm-plus"];
  readonly deviceFamilies = ["S7-300", "S7-400", "S7-1200", "S7-1500"];

  private _state: AdapterState = "registered";
  private context: AdapterContext | null = null;
  private connections = new Map<string, S7SimulatedConnection>();
  private startTime = Date.now();
  private errorCount = 0;

  get state(): AdapterState {
    return this._state;
  }

  async initialize(context: AdapterContext): Promise<void> {
    this.context = context;
    this._state = "initializing";
    context.log.info("Initializing Siemens S7 adapter");
    // In a real implementation: load snap7 native bindings, etc.
    this._state = "ready";
    this.startTime = Date.now();
    context.log.info("Siemens S7 adapter ready");
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
      metrics: {
        activeConnections: this.connections.size,
      },
    };
  }

  async dispose(): Promise<void> {
    this._state = "disconnecting";
    for (const [id, conn] of this.connections) {
      await conn.disconnect();
    }
    this.connections.clear();
    this._state = "disposed";
    this.context?.log.info("Siemens S7 adapter disposed");
  }

  // ProtocolAdapter
  async connect(endpoint: ProtocolEndpoint): Promise<ProtocolConnection> {
    this.context?.log.info(`Connecting to S7 device at ${endpoint.address}`);
    const connId = `s7-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conn = new S7SimulatedConnection(connId, endpoint);
    await conn.connectInternal();
    this.connections.set(connId, conn);
    this._state = "connected";
    return conn;
  }

  async discover(options?: DiscoveryOptions): Promise<DiscoveredDevice[]> {
    this.context?.log.info("Discovering S7 devices (simulated)");
    // Simulated discovery
    return [
      {
        address: "192.168.1.10",
        name: "S7-1500 CPU 1516",
        vendor: "Siemens",
        model: "6ES7 516-3AN02-0AB0",
        firmware: "V2.9.4",
        protocols: ["s7comm-plus"],
      },
      {
        address: "192.168.1.20",
        name: "S7-1200 CPU 1214C",
        vendor: "Siemens",
        model: "6ES7 214-1AG40-0XB0",
        firmware: "V4.5.2",
        protocols: ["s7comm"],
      },
    ];
  }

  // DeviceAdapter
  supportsDevice(device: DiscoveredDevice): boolean {
    return device.vendor === "Siemens" && device.protocols.some((p) => this.protocols.includes(p));
  }

  async getDiagnostics(connectionId: string): Promise<DeviceDiagnostics> {
    return {
      deviceId: connectionId,
      status: "ok",
      cpuLoad: 35,
      memoryUsage: 42,
      temperature: 55,
      uptime: 86400000,
      vendorSpecific: {
        cpuState: "RUN",
        ledStatus: { run: "green", stop: "off", error: "off" },
        diagnosticBufferEntries: 12,
      },
    };
  }

  async getConfiguration(connectionId: string): Promise<DeviceConfiguration> {
    return {
      deviceId: connectionId,
      parameters: {
        rack: 0,
        slot: 1,
        ipAddress: "192.168.1.10",
        subnetMask: "255.255.255.0",
      },
    };
  }

  async getFirmwareInfo(connectionId: string): Promise<FirmwareInfo> {
    return {
      currentVersion: "V2.9.4",
      availableVersions: ["V2.9.5", "V3.0.0"],
      lastUpdated: new Date("2025-06-15"),
    };
  }
}

// =============================================================================
// SIMULATED S7 CONNECTION
// =============================================================================

class S7SimulatedConnection implements ProtocolConnection {
  id: string;
  endpoint: ProtocolEndpoint;
  connected = false;
  private subscriptions = new Map<string, ReturnType<typeof setInterval>>();

  constructor(id: string, endpoint: ProtocolEndpoint) {
    this.id = id;
    this.endpoint = endpoint;
  }

  async connectInternal(): Promise<void> {
    this.connected = true;
  }

  async read(address: string): Promise<TagReadResult> {
    return {
      address,
      value: Math.random() * 100,
      quality: "GOOD",
      timestamp: new Date(),
      dataType: "REAL",
    };
  }

  async readBatch(addresses: string[]): Promise<TagReadResult[]> {
    return Promise.all(addresses.map((a) => this.read(a)));
  }

  async write(address: string, value: unknown): Promise<void> {
    // Simulated write
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
    for (const timer of this.subscriptions.values()) {
      clearInterval(timer);
    }
    this.subscriptions.clear();
    this.connected = false;
  }
}
