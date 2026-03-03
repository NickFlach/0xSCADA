/**
 * Core Common Types
 * 
 * Fundamental types used across the entire 0xSCADA system.
 * These types should remain stable and have minimal dependencies.
 * 
 * Dependencies: None (foundation types)
 */

// ─── Basic Primitives ───────────────────────────────────────────────────────

export type UUID = string; // TODO: Consider using branded type
export type Timestamp = Date | string;
export type Hash = string; // SHA-256 hash as hex string
export type Address = string; // Ethereum address
export type EntityId = string; // Generic entity identifier

// ─── Geometric Types ─────────────────────────────────────────────────────────

export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D extends Point2D {
  z: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface BoundingBox {
  min: Point2D;
  max: Point2D;
}

export interface Region {
  id: EntityId;
  name: string;
  coordinates: Point2D[];
  metadata?: Record<string, unknown>;
}

// ─── Quality & Status Types ──────────────────────────────────────────────────

export type Quality = 'good' | 'bad' | 'uncertain';
export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'connecting';
export type ServiceStatus = 'healthy' | 'degraded' | 'failed' | 'initializing';
export type OperationalState = 'normal' | 'alarm' | 'warning' | 'offline';

// ─── Data Types ─────────────────────────────────────────────────────────────

export type DataType = 'boolean' | 'number' | 'string' | 'object' | 'array';

export interface DataValue {
  value: unknown;
  dataType: DataType;
  quality: Quality;
  timestamp: Timestamp;
}

export interface TagValue extends DataValue {
  tagId: string;
  address?: string;
}

// ─── Temporal Types ──────────────────────────────────────────────────────────

export interface TimeRange {
  start: Timestamp;
  end: Timestamp;
}

export interface TimeSeries {
  timestamps: Timestamp[];
  values: unknown[];
  quality?: Quality[];
}

// ─── Error & Result Types ────────────────────────────────────────────────────

export interface SystemError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: Timestamp;
  source?: string;
}

export interface HealthStatus {
  healthy: boolean;
  message: string;
  details?: Record<string, unknown>;
  lastCheck?: Timestamp;
}

export interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: SystemError;
  timestamp: Timestamp;
}

// ─── Metadata & Configuration ───────────────────────────────────────────────

export interface Metadata {
  version?: string;
  author?: string;
  description?: string;
  tags?: string[];
  properties?: Record<string, unknown>;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ConfigurationItem {
  key: string;
  value: unknown;
  dataType: DataType;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    enum?: unknown[];
  };
}

// ─── Authentication & Authorization ─────────────────────────────────────────

export interface Credentials {
  type: 'none' | 'basic' | 'bearer' | 'certificate' | 'apikey';
  username?: string;
  password?: string;
  token?: string;
  certificate?: string;
  apikey?: string;
}

export interface Permission {
  resource: string;
  action: string;
  conditions?: Record<string, unknown>;
}

// ─── Utility Types ──────────────────────────────────────────────────────────

export type Partial<T> = {
  [P in keyof T]?: T[P];
};

export type Required<T> = {
  [P in keyof T]-?: T[P];
};

export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ─── Event Types ────────────────────────────────────────────────────────────

export type EventSeverity = 'info' | 'warning' | 'alarm' | 'critical';
export type EventType = 'system' | 'process' | 'security' | 'maintenance' | 'audit';

export interface BaseEvent {
  id: EntityId;
  type: EventType;
  severity: EventSeverity;
  message: string;
  timestamp: Timestamp;
  source: string;
  metadata?: Metadata;
}

// ─── Version Info ───────────────────────────────────────────────────────────

export interface VersionInfo {
  version: string;
  buildDate: Timestamp;
  commitHash?: string;
  branch?: string;
  environment: 'development' | 'staging' | 'production';
}

// ─── Pagination ─────────────────────────────────────────────────────────────

export interface PaginationOptions {
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

// ─── Type Guards ────────────────────────────────────────────────────────────

export const isPoint2D = (obj: unknown): obj is Point2D => {
  return typeof obj === 'object' && obj !== null && 
         'x' in obj && 'y' in obj && 
         typeof (obj as any).x === 'number' && 
         typeof (obj as any).y === 'number';
};

export const isPoint3D = (obj: unknown): obj is Point3D => {
  return isPoint2D(obj) && 'z' in obj && typeof (obj as any).z === 'number';
};

export const isValidQuality = (value: string): value is Quality => {
  return ['good', 'bad', 'uncertain'].includes(value);
};

export const isValidDataType = (value: string): value is DataType => {
  return ['boolean', 'number', 'string', 'object', 'array'].includes(value);
};