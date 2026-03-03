/**
 * Ubiquity Service Types
 */

import { EntityId, Timestamp, ConnectionStatus } from '../core/common';

export interface UniversalDevice {
  id: EntityId;
  name: string;
  type: string;
  protocol: string;
  endpoint: string;
  capabilities: DeviceCapability[];
  status: ConnectionStatus | 'discovering';
  metadata: Record<string, unknown>;
  lastSeen: Timestamp;
  discoveredBy: string;
}

export interface DeviceCapability {
  name: string;
  type: 'read' | 'write' | 'subscribe' | 'execute' | 'discover';
  dataType: 'boolean' | 'number' | 'string' | 'object' | 'array';
  description?: string;
  parameters?: Record<string, unknown>;
}