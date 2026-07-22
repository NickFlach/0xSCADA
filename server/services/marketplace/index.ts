/**
 * Agent Marketplace Service
 * ADR-0013 [13.6] — Issue #217
 *
 * Singleton wrapper wiring the marketplace to live read-only providers:
 * tags from the tag-stream cache, alarms from the phi alerting service.
 * Handlers registered here run under the capability-scoped host context.
 */

import { EventEmitter } from 'events';

export * from './semver';
export * from './engine';

import { AgentMarketplace, type TagProvider, type AlarmProvider } from './engine';
import { tagStreamServer } from '../../websocket/tag-stream';

const liveTagProvider: TagProvider = {
  list: () => Array.from(tagStreamServer.getLatestValues().keys()),
  readLatest: (tagId) => {
    const update = tagStreamServer.getLatestValues().get(tagId);
    if (!update) return null;
    return {
      value: typeof update.value === 'boolean' ? String(update.value) : update.value,
      timestamp: new Date(update.timestamp).getTime(),
    };
  },
};

/**
 * No live process-alarm source exists on this branch (the alarm pipeline
 * gains a producer with the alarm-correlation work); plugins granted
 * 'alarms:read' get an empty list rather than fabricated data. Swap this
 * provider for the correlation service's active groups once merged.
 */
const liveAlarmProvider: AlarmProvider = {
  getActive: () => [],
};

export class MarketplaceService extends EventEmitter {
  readonly marketplace: AgentMarketplace;

  private initialized = false;

  constructor() {
    super();
    this.marketplace = new AgentMarketplace({
      tagProvider: liveTagProvider,
      alarmProvider: liveAlarmProvider,
    });
    for (const event of [
      'plugin-published',
      'plugin-installed',
      'plugin-started',
      'plugin-stopped',
      'plugin-auto-disabled',
      'plugin-event',
      'plugin-log',
    ]) {
      this.marketplace.on(event, (payload) => this.emit(event, payload));
    }
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const status = this.marketplace.getStatus();
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Marketplace running: ${status.published} published, ${status.installed} installed, ${status.running} running`
        : 'Marketplace service not initialized',
    };
  }
}

export const marketplaceService = new MarketplaceService();
