/**
 * Consolidated Types Index
 * 
 * Main barrel export for all 0xSCADA types. This file consolidates
 * the "types explosion" by providing a single import point with
 * organized, documented type definitions.
 * 
 * Issue #284: Shared types explosion — dependency audit and consolidation
 * 
 * Organization:
 * - core/: Foundation types (common, industrial, pid)  
 * - services/: Service-specific types with common patterns
 * - api/: API communication types (REST, WebSocket, events)
 */

// ─── Core Types ─────────────────────────────────────────────────────────────
// Foundation types with no dependencies

// Export from common (preferred for conflicts)
export * from './core/common';

// Export from industrial (excluding conflicts)
export type {
  Site,
  Asset, 
  ProcessVariable,
  Alarm,
  Driver,
  Recipe,
  MaintenanceRecord,
  IndustrialEvent,
  ControlLoop,
  Sequence
} from './core/industrial';

// Export from PID (explicit to avoid conflicts)
export type {
  PIDElement,
  PIDConnection,
  PIDDiagram,
  PIDElementType as PIDElementTypePID,
  PIDConnectionType as PIDConnectionTypePID
} from './core/pid';

// ─── Service Types ──────────────────────────────────────────────────────────
// Service-specific types built on core types

// Explicit export to avoid conflicts (cast as any to bypass compilation issues)
export type {
  IService,
  ServiceConfig,
  ServiceMetrics,
  AsyncOperation,
  BatchOperation,
  DataProcessor,
  StorageProvider,
  ValidationRule,
  AdapterType,
  AdapterState,
  IAdapter,
  ProtocolAdapter,
  DeviceAdapter,
  BaseAdapter
} from './services';

// ─── API Types ──────────────────────────────────────────────────────────────
// Client-server communication types

export * from './api';

// ─── Database Schema Types ──────────────────────────────────────────────────
// Database schema types (re-exported for convenience)

export * from '../schema';

// ─── Type Utilities ─────────────────────────────────────────────────────────

export type { Partial, Required, Omit, DeepPartial } from './core/common';

// ─── Backward Compatibility Aliases ────────────────────────────────────────
// Maintain compatibility with existing imports

/** @deprecated Use core/common Point2D instead */
export type { Point2D as PIDPoint } from './core/common';

/** @deprecated Use core/common Size instead */
export type { Size as PIDSize } from './core/common';

// Note: AdapterType, AdapterState, IAdapter already exported above

/** @deprecated Use api/websocket instead */
export type { ClientMessage, ServerMessage } from './api/websocket';

// ─── Type Registry ──────────────────────────────────────────────────────────
// Runtime type information for dynamic type checking

export const TYPE_REGISTRY = {
  core: {
    common: [
      'Point2D', 'Point3D', 'Size', 'BoundingBox', 'DataValue', 'TagValue',
      'Quality', 'ConnectionStatus', 'ServiceStatus', 'OperationalState',
      'SystemError', 'HealthStatus', 'OperationResult', 'Metadata'
    ],
    industrial: [
      'Site', 'Asset', 'ProcessVariable', 'Alarm', 'Driver', 'Recipe', 
      'MaintenanceRecord', 'IndustrialEvent', 'ControlLoop', 'Sequence'
    ],
    pid: [
      'PIDElement', 'PIDConnection', 'PIDDiagram', 'PIDElementType'
    ]
  },
  services: {
    common: [
      'IService', 'ServiceConfig', 'ServiceMetrics', 'AsyncOperation',
      'BatchOperation', 'DataProcessor', 'StorageProvider', 'ValidationRule'
    ],
    adapters: [
      'AdapterType', 'AdapterState', 'IAdapter', 'ProtocolAdapter', 
      'DeviceAdapter', 'BaseAdapter'
    ]
  },
  api: {
    websocket: [
      'ClientMessage', 'ServerMessage', 'WebSocketClient', 'Subscription',
      'EventFilters', 'WebSocketMetrics'
    ]
  }
} as const;

// ─── Version Information ────────────────────────────────────────────────────

export const TYPES_VERSION = '1.0.0';
export const CONSOLIDATION_DATE = '2026-03-03';
export const ISSUE_REFERENCE = '#284';

/**
 * Type consolidation metadata
 */
export const CONSOLIDATION_INFO = {
  version: TYPES_VERSION,
  consolidationDate: CONSOLIDATION_DATE,
  issueReference: ISSUE_REFERENCE,
  previousFileCount: 6, // Original scattered files
  currentFileCount: 12, // Organized files
  dependencyDepth: 3, // Maximum dependency levels (core -> services -> specific)
  description: 'Consolidated shared types with proper dependency management',
  migration: {
    breaking: false, // All previous imports should still work via re-exports
    deprecated: [
      'PIDPoint -> Point2D',
      'PIDSize -> Size',
      'Various service types now organized under services/*'
    ],
    newFeatures: [
      'Unified type registry',
      'Consistent service patterns',
      'Proper dependency hierarchy',
      'Type guards and validation utilities'
    ]
  }
} as const;