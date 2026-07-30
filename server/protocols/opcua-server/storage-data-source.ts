/**
 * OPC-UA Server Mode — Storage-backed TagDataSource
 *
 * Bridges the existing 0xSCADA persistence + tag-update fabric to the
 * {@link TagDataSource} the UA server consumes:
 *
 *   - definitions (`loadSites` / `loadTagDefs`) come from injected callbacks;
 *     `runtime.ts` supplies the real Drizzle queries against `sites` and
 *     `historian_data`;
 *   - live values arrive through {@link StorageTagDataSource.pushTagUpdate},
 *     which `runtime.ts` subscribes to `tagStreamServer.onTagUpdate(...)` — the
 *     same stream the gateway scan loop and simulator already publish to.
 *
 * Keeping the queries injected means this module stays pure and unit-testable
 * with no database.
 *
 * Part of #461.
 */

import type { DataType, Quality } from "@shared/types/core/common";
import type { TagDataSource } from "./index";
import type { SourceSite, SourceTag, TagSample } from "./types";

/** Update shape emitted by the existing tag-stream fabric. */
export interface IncomingTagUpdate {
  tagName: string;
  value: unknown;
  quality: Quality;
  timestamp: string;
}

export interface StorageDataSourceDeps {
  /** Load all site folders (the `sites` table). */
  loadSites: () => Promise<SourceSite[]>;
  /** Load the tag catalogue (distinct `historian_data` tag ids per site). */
  loadTagDefs: () => Promise<SourceTag[]>;
}

/** Infer a 0xSCADA DataType from a runtime value. */
export function inferDataType(value: unknown): DataType {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object":
      return Array.isArray(value) ? "array" : "object";
    default:
      return "string";
  }
}

/**
 * A {@link TagDataSource} backed by the storage layer for definitions and an
 * in-memory latest-value cache fed by {@link pushTagUpdate}.
 */
export class StorageTagDataSource implements TagDataSource {
  private readonly deps: StorageDataSourceDeps;
  private readonly latest = new Map<string, TagSample>();
  private readonly listeners = new Set<(sample: TagSample) => void>();

  constructor(deps: StorageDataSourceDeps) {
    this.deps = deps;
  }

  loadSites(): Promise<SourceSite[]> {
    return this.deps.loadSites();
  }

  loadTags(): Promise<SourceTag[]> {
    return this.deps.loadTagDefs();
  }

  async readTag(tagId: string): Promise<TagSample | undefined> {
    return this.latest.get(tagId);
  }

  subscribe(onChange: (sample: TagSample) => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  /**
   * Feed an update from the tag-stream fabric. Updates the latest cache and
   * notifies subscribers (which drives UA DataChangeNotifications).
   */
  pushTagUpdate(update: IncomingTagUpdate): void {
    const sample: TagSample = {
      tagId: update.tagName,
      value: update.value,
      dataType: inferDataType(update.value),
      quality: update.quality,
      timestamp: update.timestamp,
    };
    this.latest.set(sample.tagId, sample);
    for (const listener of this.listeners) {
      try {
        listener(sample);
      } catch {
        // A misbehaving listener must not break the fan-out.
      }
    }
  }
}
