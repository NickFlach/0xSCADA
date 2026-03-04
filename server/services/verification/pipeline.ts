/**
 * Verification Pipeline
 * Issue #344: Build 5-layer verification pipeline framework
 * 
 * Orchestrates the 5-layer verification pipeline.
 * Each input flows through layers 1→5 in sequence.
 * Layers can halt the pipeline or allow continuation on failure.
 */

import pino from 'pino';
import crypto from 'crypto';
const uuid = () => crypto.randomUUID();
import type {
  IVerificationPipeline,
  IVerificationLayer,
  VerificationLayer,
  VerificationPipelineConfig,
  VerificationInput,
  VerificationSeverity,
  PipelineResult,
  LayerResult,
} from './types';
import {
  SchemaValidationLayer,
  RangeBoundsLayer,
  CrossReferenceLayer,
  TemporalValidationLayer,
  SemanticValidationLayer,
} from './layers';

const logger = pino({ name: 'verification-pipeline' });

// ─── Default Configuration ──────────────────────────────────────────────────

export function defaultPipelineConfig(id?: string): VerificationPipelineConfig {
  return {
    id: id ?? uuid(),
    name: 'default',
    continueOnFailure: false,
    layers: [
      { layer: 1, enabled: true, haltOnFailure: true, timeoutMs: 5000, failureSeverity: 'error' },
      { layer: 2, enabled: true, haltOnFailure: true, timeoutMs: 5000, failureSeverity: 'error' },
      { layer: 3, enabled: true, haltOnFailure: false, timeoutMs: 10000, failureSeverity: 'error' },
      { layer: 4, enabled: true, haltOnFailure: false, timeoutMs: 10000, failureSeverity: 'warning' },
      { layer: 5, enabled: true, haltOnFailure: false, timeoutMs: 15000, failureSeverity: 'warning' },
    ],
  };
}

// ─── Pipeline Implementation ────────────────────────────────────────────────

export class VerificationPipeline implements IVerificationPipeline {
  readonly config: VerificationPipelineConfig;
  private layers: Map<VerificationLayer, IVerificationLayer> = new Map();

  constructor(config?: Partial<VerificationPipelineConfig>) {
    this.config = { ...defaultPipelineConfig(), ...config };
    // Initialize default layers
    this.layers.set(1, new SchemaValidationLayer());
    this.layers.set(2, new RangeBoundsLayer());
    this.layers.set(3, new CrossReferenceLayer());
    this.layers.set(4, new TemporalValidationLayer());
    this.layers.set(5, new SemanticValidationLayer());
  }

  getLayer(layer: VerificationLayer): IVerificationLayer | undefined {
    return this.layers.get(layer);
  }

  setLayer(layer: VerificationLayer, impl: IVerificationLayer): void {
    this.layers.set(layer, impl);
  }

  setLayerEnabled(layer: VerificationLayer, enabled: boolean): void {
    const cfg = this.config.layers.find(l => l.layer === layer);
    if (cfg) cfg.enabled = enabled;
  }

  async execute(input: VerificationInput): Promise<PipelineResult> {
    const pipelineId = uuid();
    const start = Date.now();
    const layerResults: LayerResult[] = [];
    let pipelineStatus: 'pass' | 'fail' | 'skip' | 'error' = 'pass';

    logger.info({ pipelineId, inputId: input.id }, 'Starting verification pipeline');

    // Sort layer configs by layer number
    const sortedConfigs = [...this.config.layers].sort((a, b) => a.layer - b.layer);

    for (const layerConfig of sortedConfigs) {
      const layerImpl = this.layers.get(layerConfig.layer);
      if (!layerImpl) {
        layerResults.push({
          layer: layerConfig.layer,
          layerName: `layer-${layerConfig.layer}`,
          status: 'skip',
          findings: [],
          durationMs: 0,
          skipped: true,
          skipReason: 'No implementation registered',
        });
        continue;
      }

      const result = await layerImpl.execute(input, layerConfig);
      layerResults.push(result);

      if (result.status === 'fail' || result.status === 'error') {
        pipelineStatus = result.status === 'error' ? 'error' : 'fail';

        if (layerConfig.haltOnFailure && !this.config.continueOnFailure) {
          logger.warn(
            { pipelineId, layer: layerConfig.layer, status: result.status },
            'Pipeline halted by layer failure'
          );
          // Mark remaining layers as skipped
          for (const remaining of sortedConfigs) {
            if (remaining.layer > layerConfig.layer) {
              layerResults.push({
                layer: remaining.layer,
                layerName: `layer-${remaining.layer}`,
                status: 'skip',
                findings: [],
                durationMs: 0,
                skipped: true,
                skipReason: `Skipped — layer ${layerConfig.layer} halted pipeline`,
              });
            }
          }
          break;
        }
      }
    }

    // Build summary
    const allFindings = layerResults.flatMap(l => l.findings);
    const severities = allFindings.map(f => f.severity);
    const severityOrder: VerificationSeverity[] = ['critical', 'error', 'warning', 'info'];
    const highestSeverity = severityOrder.find(s => severities.includes(s)) ?? null;

    const result: PipelineResult = {
      id: pipelineId,
      inputId: input.id,
      status: pipelineStatus,
      layers: layerResults,
      totalDurationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
      summary: {
        passed: layerResults.filter(l => l.status === 'pass').length,
        failed: layerResults.filter(l => l.status === 'fail').length,
        skipped: layerResults.filter(l => l.status === 'skip').length,
        errors: layerResults.filter(l => l.status === 'error').length,
        highestSeverity,
      },
    };

    logger.info(
      { pipelineId, status: result.status, durationMs: result.totalDurationMs, summary: result.summary },
      'Verification pipeline complete'
    );

    return result;
  }
}
