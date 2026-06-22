/**
 * OPC-UA Server Mode — Storage-backed TagDataSource
 *
 * Bridges the existing 0xSCADA persistence + tag-update fabric to the
 * {@link TagDataSource} the UA server consumes. Sites come from the `sites`
 * table; tags are discovered from the `historian_data` / `alarms` tag id space.
 *
 * The pushed-update path (`pushTagUpdate`) is wired by producers — the gateway
 * scan loop and the WebSocket tag-stream bridge already call
 * `broadcastTagUpdate({ tagName, value, quality, timestamp })`; the server-mode
 * integration forwards those same updates here so UA subscriptions fire.
 *
 * INTEGRATION(storage): there is no canonical `getAllTags()` in
 * `server/storage.ts` yet (tag ids are spread across historian/alarm rows), so
 * this source accepts an injected `loadTagDefs` callback. Wire it to a real
 * Drizzle query (e.g. `SELECT DISTINCT tag_id, site_id FROM historian_data`)
 * when the storage layer exposes one. See TODO below.
 *
 * Part of #461.
 */

import type { DataType, Quality } from "@shared/types/core/common";
import type { TagDataSource } from "./index";
import type { SourceSite, SourceTag, TagSample } from "./types";

/** Update shape emitted by the existing tag-stream fabric. */
export interface IncomingTagUpdate {
  tagName: string;
  value: number | string | boolean;
  quality: Quality;
  timestamp: string;
  /** Optional site association if the producer knows it. */
  siteId?: string;
}

export interface StorageDataSourceDeps {
  /** Load all site folders (typically from the `sites` table). */
  loadSites: () => Promise<SourceSite[]>;
  /**
   * Load tag definitions. Until `server/storage.ts` exposes a tag catalogue,
   * the caller supplies this (e.g. distinct historian tag ids joined to sites).
   * TODO(#461): replace with a real storage query.
   */
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
 * in-memory latest-value cache fed by `pushTagUpdate`.
 */
export class StorageTagDataSource implements TagDataSource {
  private readonly deps: StorageDataSourceDeps;
  private readonly latest = new Map<string, TagSample>();
  private readonly listeners = new Set<(s: TagSample) => void>();

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
