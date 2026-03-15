/**
 * Verification Pipeline Types
 * Issue #344: Build 5-layer verification pipeline framework
 * 
 * Defines the type system for the 5-layer verification pipeline:
 *   L1: Schema validation
 *   L2: Range/bounds checking
 *   L3: Cross-reference validation
 *   L4: Temporal validation
 *   L5: Semantic validation
 */

import type { EntityId, Timestamp, Metadata } from '../../../shared/types';

// ─── Severity & Result Types ────────────────────────────────────────────────

export type VerificationSeverity = 'info' | 'warning' | 'error' | 'critical';

export type VerificationStatus = 'pass' | 'fail' | 'skip' | 'error';

export type VerificationLayer = 1 | 2 | 3 | 4 | 5;

export const LAYER_NAMES: Record<VerificationLayer, string> = {
  1: 'schema',
  2: 'range',
  3: 'cross-reference',
  4: 'temporal',
  5: 'semantic',
};

/** Single finding from a verification check */
export interface VerificationFinding {
  layer: VerificationLayer;
  ruleId: string;
  severity: VerificationSeverity;
  status: VerificationStatus;
  message: string;
  path?: string;          // JSONPath or tag path to the offending field
  expected?: unknown;
  actual?: unknown;
  timestamp: Timestamp;
  metadata?: Metadata;
}

/** Aggregated result from one layer */
export interface LayerResult {
  layer: VerificationLayer;
  layerName: string;
  status: VerificationStatus;
  findings: VerificationFinding[];
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
}

/** Full pipeline result across all layers */
export interface PipelineResult {
  id: EntityId;
  inputId: EntityId;
  status: VerificationStatus;
  layers: LayerResult[];
  totalDurationMs: number;
  timestamp: Timestamp;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    errors: number;
    highestSeverity: VerificationSeverity | null;
  };
}

// ─── Rule & Layer Configuration ─────────────────────────────────────────────

export interface VerificationRule<TCtx = unknown> {
  id: string;
  name: string;
  description?: string;
  severity: VerificationSeverity;
  enabled: boolean;
  /** Check function — returns findings (empty = pass) */
  check(input: VerificationInput, ctx: TCtx): Promise<VerificationFinding[]> | VerificationFinding[];
}

export interface VerificationLayerConfig {
  layer: VerificationLayer;
  enabled: boolean;
  /** Stop pipeline if this layer fails */
  haltOnFailure: boolean;
  /** Maximum time for layer execution */
  timeoutMs: number;
  /** Minimum severity that counts as failure */
  failureSeverity: VerificationSeverity;
}

export interface VerificationPipelineConfig {
  id: EntityId;
  name: string;
  layers: VerificationLayerConfig[];
  /** Continue running subsequent layers even if earlier ones fail */
  continueOnFailure: boolean;
  metadata?: Metadata;
}

// ─── Input ──────────────────────────────────────────────────────────────────

export interface VerificationInput {
  id: EntityId;
  /** The data payload to verify */
  data: Record<string, unknown>;
  /** Schema/type hint for layer 1 */
  schemaId?: string;
  /** Tag references for cross-ref (layer 3) */
  relatedTags?: string[];
  /** Historical values for temporal checks (layer 4) */
  history?: Array<{ value: unknown; timestamp: Timestamp }>;
  /** Extra context for semantic rules (layer 5) */
  processContext?: Record<string, unknown>;
  metadata?: Metadata;
}

// ─── Layer Interface ────────────────────────────────────────────────────────

export interface IVerificationLayer<TCtx = unknown> {
  readonly layer: VerificationLayer;
  readonly name: string;
  rules: VerificationRule<TCtx>[];
  addRule(rule: VerificationRule<TCtx>): void;
  removeRule(ruleId: string): void;
  execute(input: VerificationInput, config: VerificationLayerConfig, ctx?: TCtx): Promise<LayerResult>;
}

export interface IVerificationPipeline {
  readonly config: VerificationPipelineConfig;
  execute(input: VerificationInput): Promise<PipelineResult>;
  getLayer(layer: VerificationLayer): IVerificationLayer | undefined;
  setLayerEnabled(layer: VerificationLayer, enabled: boolean): void;
}
