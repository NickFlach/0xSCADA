/**
 * Built-in plugin: tag threshold monitor.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 *
 * This is a real, first-party marketplace plugin, not a demo stub. It reads a
 * configured tag through the capability-gated host context, classifies the
 * latest sample against configured limits and a staleness bound, and emits a
 * host event when the tag is out of band. It is what makes the marketplace
 * demonstrably able to invoke something end to end.
 *
 * It is also the reference for how a plugin is supposed to behave: it asks
 * `host.capabilities` before reaching for an optional capability, and it
 * reaches for `host.tags` unconditionally because `tags:read` is not optional
 * for this plugin — if that capability was not granted, the host context
 * throws `capability-denied` and the invocation fails loudly.
 */

import { z } from 'zod';
import type { PluginManifest } from '@shared/types/marketplace';
import type { PluginHandler, PluginHostContext } from '../engine';

export const TAG_THRESHOLD_MONITOR_ID = 'tag-threshold-monitor';

export const tagThresholdMonitorManifest: PluginManifest = {
  id: TAG_THRESHOLD_MONITOR_ID,
  name: 'Tag Threshold Monitor',
  version: '1.0.0',
  description:
    'Classifies the latest value of a tag against high/low limits and a staleness '
    + 'bound, and emits a host event when the tag is out of band.',
  author: '0xSCADA (first-party)',
  category: 'safety',
  requiredCapabilities: ['tags:read', 'events:emit', 'log'],
  configSchema: {
    tagId: {
      type: 'string',
      description: 'Tag evaluated when the invocation does not name one.',
      required: true,
    },
    highLimit: {
      type: 'number',
      description: 'Value at or above which the tag is reported as high.',
      required: true,
    },
    lowLimit: {
      type: 'number',
      description: 'Value at or below which the tag is reported as low.',
      required: true,
    },
    maxAgeSeconds: {
      type: 'number',
      description: 'Samples older than this are reported as stale.',
      default: 60,
      required: false,
    },
    severity: {
      type: 'select',
      description: 'Severity attached to an emitted breach event.',
      options: ['info', 'warning', 'critical'],
      default: 'warning',
      required: false,
    },
  },
  dependencies: {},
  tags: ['tags', 'threshold', 'monitoring'],
};

const InputSchema = z.object({
  /** Evaluate a different tag than the configured one. */
  tagId: z.string().min(1).max(256).optional(),
  /** Reference time for the staleness check; defaults to now. */
  nowMs: z.number().int().nonnegative().optional(),
}).strict();

export type ThresholdState =
  | 'normal'
  | 'high'
  | 'low'
  | 'stale'
  | 'unavailable'
  | 'non-numeric';

export interface ThresholdEvaluation {
  tagId: string;
  state: ThresholdState;
  value: number | string | null;
  sampledAt: number | null;
  ageSeconds: number | null;
  highLimit: number;
  lowLimit: number;
  severity: string;
  evaluatedAt: number;
}

function requireNumber(config: PluginHostContext['config'], key: string): number {
  const value = config[key];
  if (typeof value !== 'number') {
    // The engine validates config against the manifest schema before an
    // install is accepted, so this only fires if the two ever disagree.
    throw new Error(`Config "${key}" must be a number`);
  }
  return value;
}

export const tagThresholdMonitorHandler: PluginHandler = (
  input: unknown,
  host: PluginHostContext,
): ThresholdEvaluation => {
  const parsed = InputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid invocation input: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }

  const configuredTag = host.config.tagId;
  const tagId = parsed.data.tagId ?? (typeof configuredTag === 'string' ? configuredTag : '');
  if (tagId.length === 0) throw new Error('No tag configured for this installation');

  const highLimit = requireNumber(host.config, 'highLimit');
  const lowLimit = requireNumber(host.config, 'lowLimit');
  const maxAgeSeconds = typeof host.config.maxAgeSeconds === 'number'
    ? host.config.maxAgeSeconds
    : 60;
  const severity = typeof host.config.severity === 'string' ? host.config.severity : 'warning';
  const evaluatedAt = parsed.data.nowMs ?? Date.now();

  // `tags:read` is mandatory for this plugin: if it was not granted, this
  // access throws `capability-denied` and the invocation fails.
  const sample = host.tags.readLatest(tagId);

  let state: ThresholdState;
  let ageSeconds: number | null = null;
  if (sample === null) {
    state = 'unavailable';
  } else {
    ageSeconds = Math.max(0, Math.round((evaluatedAt - sample.timestamp) / 1000));
    if (ageSeconds > maxAgeSeconds) {
      state = 'stale';
    } else if (typeof sample.value !== 'number') {
      state = 'non-numeric';
    } else if (sample.value >= highLimit) {
      state = 'high';
    } else if (sample.value <= lowLimit) {
      state = 'low';
    } else {
      state = 'normal';
    }
  }

  const evaluation: ThresholdEvaluation = {
    tagId,
    state,
    value: sample?.value ?? null,
    sampledAt: sample?.timestamp ?? null,
    ageSeconds,
    highLimit,
    lowLimit,
    severity,
    evaluatedAt,
  };

  if (state !== 'normal' && host.capabilities.includes('events:emit')) {
    host.emitEvent('tag-threshold-breach', { ...evaluation });
  }
  if (state !== 'normal' && host.capabilities.includes('log')) {
    host.log(`${tagId} is ${state} (limits ${lowLimit}..${highLimit})`);
  }

  return evaluation;
};
