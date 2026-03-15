/**
 * Shared Vendor Adapter Base Class
 * Issue #370: Extract duplicated logic from vendor adapters
 *
 * Provides: polling, tag cache, connection map, metrics/diagnostics patterns.
 */

import { BaseAdapter, AdapterTag, AdapterContext } from '../../../shared/types/services/adapters';
import type { AdapterType } from '../../../shared/types/services/adapters';

/** Cached tag entry */
export interface TagCacheEntry {
  value: unknown;
  timestamp: Date;
  quality: string;
  /** Extra adapter-specific metadata (e.g. typeCode, transport id) */
  [key: string]: unknown;
}

/** Polling subscription handle */
export interface PollHandle {
  key: string;
  timer: ReturnType<typeof setInterval>;
}

/**
 * VendorBaseAdapter extends the shared BaseAdapter with common vendor patterns.
 * Subclasses still implement doInitialize, doConnect, doDisconnect, doDestroy, and readTags.
 */
export abstract class VendorBaseAdapter<T extends AdapterType = 'protocol'> extends BaseAdapter<T> {

  // ─── Tag Cache ──────────────────────────────────────────────────────
  protected tagCache: Map<string, TagCacheEntry> = new Map();
  protected maxTagCache = 50_000;

  protected getCachedTag(address: string): TagCacheEntry | undefined {
    return this.tagCache.get(address);
  }

  protected setCachedTag(address: string, entry: TagCacheEntry): void {
    this.tagCache.set(address, entry);
    if (this.tagCache.size > this.maxTagCache) {
      // Evict oldest entries
      const keys = Array.from(this.tagCache.keys());
      for (let i = 0; i < keys.length - this.maxTagCache; i++) {
        this.tagCache.delete(keys[i]);
      }
    }
  }

  protected clearTagCache(): void {
    this.tagCache.clear();
  }

  // ─── Polling ────────────────────────────────────────────────────────
  protected pollingTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  /**
   * Start polling a set of addresses at a given interval (ms).
   * Returns a key that can be passed to stopPolling().
   */
  startPolling(
    addresses: string[],
    intervalMs: number,
    callback: (tags: AdapterTag[]) => void,
    label = 'poll',
  ): string {
    const key = `${label}_${Date.now()}`;
    const timer = setInterval(async () => {
      try {
        const tags = await this.readTags(addresses);
        callback(tags);
      } catch (err) {
        this.context?.logger.error(`Polling error (${label}):`, err);
        this.errorsCount++;
      }
    }, intervalMs);
    this.pollingTimers.set(key, timer);
    return key;
  }

  stopPolling(key: string): void {
    const timer = this.pollingTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.pollingTimers.delete(key);
    }
  }

  protected stopAllPolling(): void {
    for (const timer of this.pollingTimers.values()) {
      clearInterval(timer);
    }
    this.pollingTimers.clear();
  }

  // ─── Metrics & Diagnostics ─────────────────────────────────────────
  protected messagesProcessed = 0;
  protected errorsCount = 0;
  protected startTime = Date.now();

  protected async getMetrics(): Promise<Record<string, unknown>> {
    return {
      messagesProcessed: this.messagesProcessed,
      errorsCount: this.errorsCount,
      uptime: Date.now() - this.startTime,
      cachedTags: this.tagCache.size,
      activePollers: this.pollingTimers.size,
    };
  }

  protected async getDiagnostics(): Promise<Record<string, unknown>> {
    return {};
  }

  // ─── Abstract ──────────────────────────────────────────────────────
  abstract readTags(addresses: string[]): Promise<AdapterTag[]>;
}
