/**
 * NL Query Service
 * ADR-0013 [13.5] — Issue #216
 *
 * Wires the query engine to live data: an in-memory tag store fed by the
 * tag-stream hook provides current values and a rolling history buffer
 * (there is no historian read path in this codebase yet). Read-only over
 * process data.
 */

import { EventEmitter } from 'events';

export * from './parser';
export * from './resolver';
export * from './engine';

import type { TagDataSource, TagReading } from '@shared/types/nl-query';
import { NLQueryEngine } from './engine';

export interface NLTagUpdateInput {
  tagName: string;
  value: number | string | boolean;
  timestamp: string | number;
  quality?: string;
}

/** Rolling in-memory tag store — current values plus bounded history */
export class InMemoryTagStore implements TagDataSource {
  private readonly maxTags: number;
  private readonly maxPointsPerTag: number;
  /** Insertion order doubles as recency order — refreshed on ingest */
  private series: Map<string, TagReading[]> = new Map();

  constructor(options: { maxTags?: number; maxPointsPerTag?: number } = {}) {
    this.maxTags = options.maxTags ?? 500;
    this.maxPointsPerTag = options.maxPointsPerTag ?? 500;
  }

  ingest(reading: TagReading): void {
    let points = this.series.get(reading.tagId);
    if (points) {
      this.series.delete(reading.tagId); // refresh recency
    } else {
      points = [];
    }
    this.series.set(reading.tagId, points);
    points.push(reading);
    if (points.length > this.maxPointsPerTag) {
      points.splice(0, points.length - this.maxPointsPerTag);
    }
    while (this.series.size > this.maxTags) {
      const oldest = this.series.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.series.delete(oldest);
    }
  }

  listTags(): string[] {
    return Array.from(this.series.keys());
  }

  readLatest(tagId: string): TagReading | null {
    const points = this.series.get(tagId);
    return points && points.length > 0 ? points[points.length - 1] : null;
  }

  readHistory(tagId: string, startMs: number, endMs: number): TagReading[] {
    const points = this.series.get(tagId) ?? [];
    return points.filter((p) => p.timestamp >= startMs && p.timestamp <= endMs);
  }
}

export class NLQueryService extends EventEmitter {
  readonly store = new InMemoryTagStore();
  readonly engine: NLQueryEngine;

  private initialized = false;

  constructor() {
    super();
    this.engine = new NLQueryEngine({ dataSource: this.store });
    this.engine.on('backend-error', (e) => this.emit('backend-error', e));
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  /** Feed a live tag update into the store (numeric or string values) */
  ingestTagUpdate(update: NLTagUpdateInput): void {
    if (typeof update.value === 'boolean') return;
    const timestamp =
      typeof update.timestamp === 'number'
        ? update.timestamp
        : new Date(update.timestamp).getTime();
    if (!Number.isFinite(timestamp)) return;
    const numeric =
      typeof update.value === 'string' && update.value.trim() !== ''
        ? Number(update.value)
        : update.value;
    this.store.ingest({
      tagId: update.tagName,
      value: typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : update.value,
      quality: update.quality,
      timestamp,
    });
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const backend = this.engine.getBackendInfo();
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `NL query running: ${this.store.listTags().length} tags, ` +
          `backend: ${backend ? backend.name : 'regex'}`
        : 'NL query service not initialized',
    };
  }
}

export const nlQueryService = new NLQueryService();
