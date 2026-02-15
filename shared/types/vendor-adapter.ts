/**
 * Vendor Adapter Type Definitions
 *
 * 0xSCADA is vendor ADAPTABLE — vendors can plug in and extend,
 * expose vendor-specific capabilities via adapters, and differentiate
 * on quality rather than proprietary walls.
 *
 * Three adapter types:
 *   - ProtocolAdapter: Communication protocol (Modbus, S7, CIP, OPC-UA)
 *   - DeviceAdapter: Device-specific features (diagnostics, firmware, config)
 *   - FeatureAdapter: Cross-cutting capabilities (historian, alarming, analytics)
 */

// =============================================================================
// ADAPTER IDENTITY & METADATA
// =============================================================================

export interface AdapterManifest {
  /** Unique adapter identifier, e.g. "siemens-s7" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Vendor name */
  vendor: string;
  /** SemVer version string */
  version: string;
  /** Adapter type */
  type: AdapterType;
  /** Optional description */
  description?: string;
  /** Minimum 0xSCADA platform version required */
  platformVersion?: string;
  /** License identifier (SPDX) */
  license?: string;
  /** Adapter homepage/docs URL */
  homepage?: string;
  /** Declared capabilities */
  capabilities: AdapterCapability[];
  /** Adapter dependencies (other adapter IDs) */
  dependencies?: string[];
}

export type AdapterType = "protocol" | "device" | "feature";

// =============================================================================
// CAPABILITY DECLARATION SYSTEM
// =============================================================================

export interface AdapterCapability {
  /** Capability identifier, e.g. "read-tags", "firmware-update" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Category for grouping */
  category: CapabilityCategory;
  /** Description of what this capability provides */
  description?: string;
  /** Whether this capability is optional or required for the adapter */
  required: boolean;
  /** Configuration schema (JSON Schema subset) */
  configSchema?: Record<string, unknown>;
}

export type CapabilityCategory =
  | "communication"
  | "diagnostics"
  | "firmware"
  | "configuration"
  | "alarming"
  | "historian"
  | "analytics"
  | "security"
  | "discovery"
  | "simulation"
  | "custom";

// =============================================================================
// ADAPTER LIFECYCLE
// =============================================================================

export type AdapterState =
  | "registered"
  | "initializing"
  | "ready"
  | "connected"
  | "error"
  | "disconnecting"
  | "disposed";

export interface AdapterHealthStatus {
  adapterId: string;
  state: AdapterState;
  healthy: boolean;
  lastHealthCheck: Date;
  uptime: number;
  errorCount: number;
  lastError?: string;
  metrics?: Record<string, number>;
}

export interface AdapterContext {
  /** Platform logger */
  log: AdapterLogger;
  /** Platform configuration for this adapter */
  config: Record<string, unknown>;
  /** Event emitter for adapter events */
  emit: (event: string, data: unknown) => void;
  /** Access to platform services */
  platform: PlatformServices;
}

export interface AdapterLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface PlatformServices {
  /** Get another registered adapter by ID */
  getAdapter(id: string): BaseAdapter | undefined;
  /** Get all adapters of a type */
  getAdaptersByType(type: AdapterType): BaseAdapter[];
  /** Storage service for adapter state */
  getStorage(namespace: string): AdapterStorage;
}

export interface AdapterStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

// =============================================================================
// BASE ADAPTER INTERFACE
// =============================================================================

export interface BaseAdapter {
  /** Adapter manifest / identity */
  readonly manifest: AdapterManifest;
  /** Current state */
  readonly state: AdapterState;

  /**
   * Initialize the adapter with platform context.
   * Called once after registration.
   */
  initialize(context: AdapterContext): Promise<void>;

  /**
   * Check if a specific capability is supported.
   */
  hasCapability(capabilityId: string): boolean;

  /**
   * Health check — called periodically by the platform.
   */
  healthCheck(): Promise<AdapterHealthStatus>;

  /**
   * Graceful shutdown.
   */
  dispose(): Promise<void>;
}

// =============================================================================
// PROTOCOL ADAPTER
// =============================================================================

export interface ProtocolAdapter extends BaseAdapter {
  readonly manifest: AdapterManifest & { type: "protocol" };

  /** Supported protocol identifiers */
  readonly protocols: string[];

  /** Connect to a device/endpoint */
  connect(endpoint: ProtocolEndpoint): Promise<ProtocolConnection>;

  /** Discover devices on the network */
  discover?(options?: DiscoveryOptions): Promise<DiscoveredDevice[]>;
}

export interface ProtocolEndpoint {
  /** Connection string or host:port */
  address: string;
  /** Protocol-specific options */
  options?: Record<string, unknown>;
  /** Authentication credentials */
  credentials?: {
    username?: string;
    password?: string;
    certificate?: string;
  };
}

export interface ProtocolConnection {
  id: string;
  endpoint: ProtocolEndpoint;
  connected: boolean;

  /** Read a tag/register value */
  read(address: string): Promise<TagReadResult>;
  /** Read multiple tags */
  readBatch(addresses: string[]): Promise<TagReadResult[]>;
  /** Write a value */
  write(address: string, value: unknown): Promise<void>;
  /** Subscribe to value changes */
  subscribe(
    addresses: string[],
    callback: (values: TagReadResult[]) => void,
    intervalMs?: number
  ): SubscriptionHandle;
  /** Disconnect */
  disconnect(): Promise<void>;
}

export interface TagReadResult {
  address: string;
  value: unknown;
  quality: "GOOD" | "BAD" | "UNCERTAIN";
  timestamp: Date;
  dataType?: string;
  error?: string;
}

export interface SubscriptionHandle {
  id: string;
  unsubscribe(): void;
}

export interface DiscoveryOptions {
  /** Network range, e.g. "192.168.1.0/24" */
  networkRange?: string;
  /** Timeout per device in ms */
  timeoutMs?: number;
  /** Protocol-specific discovery params */
  params?: Record<string, unknown>;
}

export interface DiscoveredDevice {
  address: string;
  name?: string;
  vendor?: string;
  model?: string;
  firmware?: string;
  protocols: string[];
  metadata?: Record<string, unknown>;
}

// =============================================================================
// DEVICE ADAPTER
// =============================================================================

export interface DeviceAdapter extends BaseAdapter {
  readonly manifest: AdapterManifest & { type: "device" };

  /** Supported device families/models */
  readonly deviceFamilies: string[];

  /** Check if this adapter supports a specific device */
  supportsDevice(device: DiscoveredDevice): boolean;

  /** Get device-specific diagnostics */
  getDiagnostics?(connectionId: string): Promise<DeviceDiagnostics>;

  /** Get device configuration */
  getConfiguration?(connectionId: string): Promise<DeviceConfiguration>;

  /** Apply device configuration */
  setConfiguration?(
    connectionId: string,
    config: Partial<DeviceConfiguration>
  ): Promise<void>;

  /** Firmware management */
  getFirmwareInfo?(connectionId: string): Promise<FirmwareInfo>;
  updateFirmware?(connectionId: string, firmware: FirmwarePackage): Promise<FirmwareUpdateStatus>;
}

export interface DeviceDiagnostics {
  deviceId: string;
  status: "ok" | "warning" | "fault";
  cpuLoad?: number;
  memoryUsage?: number;
  temperature?: number;
  uptime?: number;
  faultCodes?: string[];
  vendorSpecific?: Record<string, unknown>;
}

export interface DeviceConfiguration {
  deviceId: string;
  parameters: Record<string, unknown>;
  lastModified?: Date;
}

export interface FirmwareInfo {
  currentVersion: string;
  availableVersions?: string[];
  lastUpdated?: Date;
}

export interface FirmwarePackage {
  version: string;
  data: Buffer | Uint8Array;
  checksum?: string;
}

export interface FirmwareUpdateStatus {
  state: "pending" | "downloading" | "installing" | "rebooting" | "complete" | "failed";
  progress: number;
  error?: string;
}

// =============================================================================
// FEATURE ADAPTER
// =============================================================================

export interface FeatureAdapter extends BaseAdapter {
  readonly manifest: AdapterManifest & { type: "feature" };

  /** Feature-specific API — each feature adapter defines its own interface */
  getFeatureAPI<T = unknown>(): T;
}

// =============================================================================
// ADAPTER EVENTS
// =============================================================================

export type AdapterEvent =
  | { type: "adapter:registered"; adapterId: string }
  | { type: "adapter:initialized"; adapterId: string }
  | { type: "adapter:connected"; adapterId: string; connectionId: string }
  | { type: "adapter:disconnected"; adapterId: string; connectionId: string }
  | { type: "adapter:error"; adapterId: string; error: string }
  | { type: "adapter:health"; adapterId: string; status: AdapterHealthStatus }
  | { type: "adapter:disposed"; adapterId: string };

// =============================================================================
// CERTIFICATION
// =============================================================================

export interface CertificationResult {
  adapterId: string;
  passed: boolean;
  timestamp: Date;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  results: CertificationTestResult[];
}

export interface CertificationTestResult {
  testId: string;
  name: string;
  passed: boolean;
  message?: string;
  durationMs: number;
}
