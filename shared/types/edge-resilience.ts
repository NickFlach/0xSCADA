/**
 * Offline/Edge Resilience Types — ADR-0014
 */

export interface StoreAndForwardConfig {
  maxQueueSize: number;
  maxQueueBytes: number;
  persistPath: string;
  syncIntervalMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  integrityCheckIntervalMs: number;
}

export interface QueuedEvent {
  id: string;
  timestamp: number;
  type: string;
  payload: unknown;
  retryCount: number;
  firstQueued: number;
  merkleHash: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
}

export type ConflictStrategy = 'last-writer-wins' | 'merge' | 'alert' | 'manual';

export interface ConflictResolution {
  dataType: string;
  strategy: ConflictStrategy;
  mergeFunction?: string;
}

export interface SyncState {
  status: 'online' | 'offline' | 'syncing' | 'error';
  queueDepth: number;
  queueBytes: number;
  oldestEvent: number | null;
  lastSyncAttempt: number | null;
  lastSuccessfulSync: number | null;
  consecutiveFailures: number;
  currentBackoffMs: number;
  merkleRoot: string | null;
  remoteMerkleRoot: string | null;
  integrityVerified: boolean;
}

export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: string;
}

export interface EdgeHealthReport {
  siteId: string;
  syncState: SyncState;
  localAlarmCount: number;
  localTagCount: number;
  uptimeSeconds: number;
  lastCloudContact: number | null;
  storageUsedBytes: number;
  storageCapacityBytes: number;
}
