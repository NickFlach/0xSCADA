/**
 * Ubiquity Service Types
 * TypeScript interfaces for Ubiquity IOT integration
 */

// =============================================================================
// CONNECTION & DOMAIN TYPES
// =============================================================================

export type ConnectionStatus = "OFFLINE" | "CONNECTING" | "ONLINE" | "ERROR" | "MAINTENANCE";

export interface UbiquityDomainConfig {
  cloudEndpoint: string;
  username: string;
  password: string;
  apiKey?: string;
  tenantId?: string;
}

export interface UbiquityDomain {
  id: string;
  name: string;
  cloudEndpoint: string;
  tenantId?: string;
  status: ConnectionStatus;
  lastConnected?: Date;
  errorMessage?: string;
}

export interface ConnectDomainResponse {
  domainId: string;
  name: string;
  status: ConnectionStatus;
  connectedAt: Date;
  deviceCount: number;
}

// =============================================================================
// DEVICE TYPES
// =============================================================================

export interface UbiquityDevice {
  id: string;
  domainId: string;
  ubiquityDeviceId: string;
  name: string;
  displayName?: string;
  description?: string;

  // Device metadata
  deviceType?: string;
  model?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  osVersion?: string;
  macAddress?: string;
  ipAddress?: string;

  // Connectivity
  connectionStatus: ConnectionStatus;
  lastSeen?: Date;
  signalStrength?: number;

  // Capabilities
  supportsRemoteDesktop: boolean;
  supportsFileTransfer: boolean;
  supportsProcessMonitor: boolean;

  // Metadata
  metadata?: Record<string, unknown>;
}

export interface DeviceDiscoveryResult {
  totalDevices: number;
  newDevices: number;
  updatedDevices: number;
  removedDevices: number;
  devices: UbiquityDevice[];
  discoveredAt: Date;
}

export interface DeviceStatus {
  deviceId: string;
  status: ConnectionStatus;
  lastSeen: Date;
  signalStrength?: number;
  systemMetrics?: SystemMetrics;
  errorMessage?: string;
}

export interface SystemMetrics {
  cpuUsage: number;
  memoryUsage: number;
  memoryTotalMb: number;
  memoryAvailableMb: number;
  diskUsage: number;
  networkUploadBytesPerSec: number;
  networkDownloadBytesPerSec: number;
  capturedAt: Date;
}

// =============================================================================
// FILE TRANSFER TYPES
// =============================================================================

export type TransferDirection = "UPLOAD" | "DOWNLOAD";
export type TransferStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface FileTransferRequest {
  deviceId: string;
  localPath: string;
  remotePath: string;
  direction: TransferDirection;
  overwrite?: boolean;
}

export interface FileTransfer {
  id: string;
  deviceId: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  fileName: string;
  fileSize?: number;
  fileHash?: string;
  contentType?: string;

  // Progress
  status: TransferStatus;
  progress: number;
  bytesTransferred: number;
  transferRateBytesPerSec?: number;
  estimatedTimeRemaining?: number;

  // Error
  errorMessage?: string;

  // Timing
  startedAt?: Date;
  completedAt?: Date;
}

export interface FirmwareDeploymentRequest {
  deviceId: string;
  firmwarePath: string;
  version: string;
  forceUpdate?: boolean;
  rebootAfterInstall?: boolean;
}

export type DeploymentStatus =
  | "PENDING"
  | "UPLOADING"
  | "INSTALLING"
  | "REBOOTING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "ROLLED_BACK";

export interface FirmwareDeployment {
  id: string;
  deviceId: string;
  version: string;
  previousVersion: string;
  status: DeploymentStatus;
  progress: number;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface RemoteFile {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: Date;
  permissions?: string;
}

// =============================================================================
// SESSION TYPES
// =============================================================================

export type SessionType = "REMOTE_DESKTOP" | "PROCESS_MONITOR";
export type SessionStatus = "PENDING" | "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "ERROR";

export interface StartSessionRequest {
  deviceId: string;
  sessionType?: SessionType;
  width?: number;
  height?: number;
  colorDepth?: number;
  frameRate?: number;
  permissions?: string[];
}

export interface RemoteSession {
  id: string;
  deviceId: string;
  sessionType: SessionType;
  ubiquitySessionId?: string;

  // Status
  status: SessionStatus;

  // Configuration
  resolution?: string;
  colorDepth?: number;
  frameRate?: number;
  permissions: string[];

  // Streaming
  streamUrl?: string;
  webSocketUrl?: string;

  // Timing
  connectedAt?: Date;
  disconnectedAt?: Date;
  durationSeconds?: number;

  // Error
  disconnectReason?: string;
  errorMessage?: string;
}

export type InputEventType =
  | "KeyDown"
  | "KeyUp"
  | "KeyPress"
  | "MouseMove"
  | "MouseDown"
  | "MouseUp"
  | "MouseClick"
  | "MouseDoubleClick"
  | "MouseWheel";

export interface InputEvent {
  sessionId: string;
  eventType: InputEventType;
  key?: string;
  keyCode?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  x?: number;
  y?: number;
  button?: number;
  wheelDelta?: number;
}

// =============================================================================
// PROCESS TYPES
// =============================================================================

export type ProcessStatus = "RUNNING" | "SLEEPING" | "STOPPED" | "ZOMBIE" | "UNKNOWN";
export type ProcessAction = "START" | "STOP" | "RESTART" | "KILL";

export interface ProcessInfo {
  pid: number;
  name: string;
  commandLine?: string;
  user?: string;
  cpuPercent: number;
  memoryBytes: number;
  status: ProcessStatus;
  startedAt: Date;
  parentPid?: number;
}

export interface ProcessActionRequest {
  deviceId: string;
  pid?: number;
  processName?: string;
  action: ProcessAction;
  arguments?: string[];
}

export interface ProcessActionResult {
  success: boolean;
  pid?: number;
  processName?: string;
  action: ProcessAction;
  errorMessage?: string;
  executedAt: Date;
}

export interface ProcessSnapshot {
  id: string;
  deviceId: string;
  processes: ProcessInfo[];
  systemMetrics: SystemMetrics;
  capturedAt: Date;
}

// =============================================================================
// SERVICE CONFIGURATION
// =============================================================================

export interface UbiquityServiceConfig {
  bridgeBaseUrl: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface UbiquityBridgeHealthStatus {
  healthy: boolean;
  status: string;
  version?: string;
  uptime?: number;
  connectedDomains?: number;
  trackedDevices?: number;
}
