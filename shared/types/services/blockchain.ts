/**
 * Blockchain Service Types
 * 
 * Types for blockchain integration, Layer 2 rollups, and event anchoring.
 * 
 * Dependencies: ./common.ts, ../core/common.ts
 */

import { EntityId, Timestamp, Hash, Address } from '../core/common';
import { ServiceConfig, AsyncOperation } from './common';

// ─── Layer 2 Rollup Types ───────────────────────────────────────────────────

export type L2TransactionType = 'data-anchor' | 'state-update' | 'event-log' | 'audit-trail';

export interface L2Transaction {
  id: EntityId;
  type: L2TransactionType;
  payload: Record<string, unknown>;
  sender: Address;
  timestamp: Timestamp;
  nonce: number;
  gasLimit: number;
  gasPrice: number;
  signature?: string;
}

export interface L2Block {
  number: number;
  hash: Hash;
  parentHash: Hash;
  merkleRoot: Hash;
  stateRoot: Hash;
  transactions: L2Transaction[];
  timestamp: Timestamp;
  gasUsed: number;
  gasLimit: number;
  sequencer: Address;
  status: 'pending' | 'finalized' | 'disputed';
}

// ─── Event Anchoring Types ──────────────────────────────────────────────────

export interface AnchorableEvent {
  id: EntityId;
  timestamp: Timestamp;
  eventType: string;
  siteId: string;
  severity: 'info' | 'warning' | 'alarm' | 'critical';
  message: string;
  data?: Record<string, unknown>;
  hash?: Hash;
}

export interface AnchorBatch {
  id: EntityId;
  events: AnchorableEvent[];
  merkleRoot: Hash;
  timestamp: Timestamp;
  blockchainTx?: Hash;
  status: 'pending' | 'anchored' | 'failed';
}

// ─── Smart Contract Types ───────────────────────────────────────────────────

export interface ContractConfig {
  address: Address;
  abi: any[];
  network: string;
  deploymentBlock?: number;
}

export interface ContractEvent {
  eventName: string;
  blockNumber: number;
  transactionHash: Hash;
  args: Record<string, unknown>;
  timestamp: Timestamp;
}

// ─── Blockchain Service Configuration ───────────────────────────────────────

export interface BlockchainServiceConfig extends ServiceConfig {
  networkUrl: string;
  chainId: number;
  privateKey?: string;
  contracts: Record<string, ContractConfig>;
  confirmationBlocks: number;
  gasPrice?: number;
  gasLimit?: number;
}

// ─── Operation Types ────────────────────────────────────────────────────────

export interface BlockchainOperation extends AsyncOperation {
  transactionHash?: Hash;
  blockNumber?: number;
  gasUsed?: number;
  confirmations?: number;
}