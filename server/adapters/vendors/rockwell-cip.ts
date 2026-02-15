/**
 * Rockwell CIP/EtherNet-IP Reference Adapter
 *
 * Protocol + Device adapter for Allen-Bradley/Rockwell PLCs
 * (ControlLogix, CompactLogix, Micro800 series).
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
// CAPABILITIES
// =============================================================================

const CIP_CAPABILITIES: AdapterCapability[] = [
  {
    id: "read-tags",
    name: "Tag Reading",
    category: "communication",
    description: "Read CIP symbolic tags via EtherNet/IP",
    required: true,
  },
  {
    id: "write-tags",
    name: "Tag Writing",
    category: "communication",
    description: "Write CIP symbolic tags",
    required: true,
  },
  {
    id: "device-discovery",
    name: "Device Discovery",
    category: "discovery",
    description: "Discover EtherNet/IP devices via ListIdentity broadcast",
    required: false,
  },
  {
    id: "diagnostics",
    name: "Controller Diagnostics",
    category: "diagnostics",
    description: "Read controller fault log, keyswitch state, I/O status",
    required: false,
  },
  {
    id: "tag-browsing",
    name: "Tag Browsing",
    category: "configuration",
    description: "Browse controller tag database (vendor-specific)",
    required: false,
  },
];

// =============================================================================
// ROCKWELL CIP ADAPTER
// =============================================================================

export class RockwellCIPAdapter implements ProtocolAdapter, DeviceAdapter {
  readonly manifest: AdapterManifest & { type: "protocol" } = {
    id: "rockwell-cip",
    name: "Rockwell CIP/EtherNet-IP Adapter",
    vendor: "Rockwell Automation",
    version: "1.0.0",
    type: "protocol" as const,
    description: "Protocol and device adapter for Allen-Bradley PLCs via CIP/EtherNet-IP",
    capabilities: CIP_CAPABILITIES,
    license: "Apache-2.0",
  };

  readonly protocols = ["cip", "ethernet-ip", "pccc"];
  readonly deviceFamilies = ["ControlLogix", "CompactLogix", "Micro800", "PLC-5", "SLC-500"];

  private _state: AdapterState = "registered";
  private context: AdapterContext | null = null;
  private connections = new Map<string, CIPSimulatedConnection>();
  private startTime = Date.now();
  private errorCount = 0;

  get state(): AdapterState {
    return this._state;
  }

  async initialize(context: AdapterContext): Promise<void> {
    this.context = context;
    this._state = "initializing";
    context.log.info("Initializing Rockwell CIP adapter");
    this._state = "ready";
    this.startTime = Date.now();
    context.log.info("Rockwell CIP adapter ready");
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
    this.context?.log.info(`Connecting to CIP device at ${endpoint.address}`);
    const connId = `cip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conn = new CIPSimulatedConnection(connId, endpoint);
    await conn.connectInternal();
    this.connections.set(connId, conn);
    this._state = "connected";
    return conn;
  }

  async discover(options?: DiscoveryOptions): Promise<DiscoveredDevice[]> {
    return [
      {
        address: "192.168.1.100",
        name: "1756-L83E ControlLogix",
        vendor: "Rockwell Automation",
        model: "1756-L83E/B",
        firmware: "V33.011",
        protocols: ["cip", "ethernet-ip"],
      },
      {
        address: "192.168.1.101",
        name: "5069-L320ER CompactLogix",
        vendor: "Rockwell Automation",
        model: "5069-L320ER",
        firmware: "V34.012",
        protocols: ["cip", "ethernet-ip"],
      },
    ];
  }

  supportsDevice(device: DiscoveredDevice): boolean {
    return (
      device.vendor === "Rockwell Automation" &&
      device.protocols.some((p) => this.protocols.includes(p))
    );
  }

  async getDiagnostics(connectionId: string): Promise<DeviceDiagnostics> {
    return {
      deviceId: connectionId,
      status: "ok",
      cpuLoad: 28,
      memoryUsage: 55,
      temperature: 48,
      uptime: 172800000,
      vendorSpecific: {
        keySwitchPosition: "REMOTE_RUN",
        majorFaults: 0,
        minorFaults: 2,
        ioTreeStatus: "OK",
        lastFault: { code: 4, type: 20, description: "Watchdog expired" },
      },
    };
  }

  async getConfiguration(connectionId: string): Promise<DeviceConfiguration> {
    return {
      deviceId: connectionId,
      parameters: {
        ipAddress: "192.168.1.100",
        slotNumber: 0,
        chassisSize: 10,
        revision: "33.011",
      },
    };
  }

  async getFirmwareInfo(connectionId: string): Promise<FirmwareInfo> {
    return {
      currentVersion: "V33.011",
      lastUpdated: new Date("2025-09-01"),
    };
  }
}

// =============================================================================
// SIMULATED CIP CONNECTION
// =============================================================================

class CIPSimulatedConnection implements ProtocolConnection {
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
    // CIP uses symbolic tag names like "Program:MainProgram.Temperature"
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
    // Simulated
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
