/**
 * Agent Marketplace service.
 *
 * Feature [13.6] of ADR-0013 (docs/decisions/ADR-0013-autonomous-agent-architecture.md).
 * Issue #217. Design notes: docs/architecture/agent-marketplace.md.
 *
 * Wires the engine to the live host services it exposes as capabilities,
 * chooses a durable store, registers the first-party plugin implementations,
 * and forwards capability denials to the log as an audit trail.
 */

import { EventEmitter } from 'events';
import type {
  CapabilityDenialRecord,
  InstalledPlugin,
  MarketplaceEntry,
} from '@shared/types/marketplace';
import { logError, logInfo, logWarn } from '../../logger';
import { storage } from '../../storage';
import { tagStreamServer } from '../../websocket/tag-stream';
import { AgentMarketplace, SYSTEM_PUBLISHER } from './engine';
import type {
  ActiveAlarm,
  AlarmProvider,
  InstallRequest,
  MarketplaceOptions,
  PluginHandler,
  PluginHostContext,
  TagProvider,
  TagSample,
} from './engine';
import { BUILTIN_PLUGINS } from './builtin';
import { DatabaseMarketplaceStore } from './database-store';
import {
  InMemoryMarketplaceStore,
  type MarketplaceSnapshot,
  type MarketplaceStore,
} from './store';
import { MarketplaceError, isMarketplaceError, type MarketplaceErrorCode } from './errors';

export { AgentMarketplace, SYSTEM_PUBLISHER } from './engine';
export type {
  ActiveAlarm,
  AlarmProvider,
  InstallRequest,
  MarketplaceOptions,
  PluginHandler,
  PluginHostContext,
  TagProvider,
  TagSample,
};
export { MarketplaceError, isMarketplaceError };
export type { MarketplaceErrorCode };
export { compareSemver, parseSemver, satisfiesRange } from './semver';
export type { SemVer } from './semver';
export { DatabaseMarketplaceStore } from './database-store';
export { InMemoryMarketplaceStore } from './store';
export type { MarketplaceSnapshot, MarketplaceStore, StoredInstallation } from './store';
export { BUILTIN_PLUGINS } from './builtin';
export type { BuiltinPlugin } from './builtin';

/** Live read-only view of the tag-stream cache, exposed under `tags:read`. */
const liveTagProvider: TagProvider = {
  list: () => [...tagStreamServer.getLatestValues().keys()],
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
 * No process-alarm source is wired to the marketplace on this branch — the
 * alarm-correlation service owns active groups and does not yet expose a
 * read-only projection. Plugins granted `alarms:read` therefore see an empty
 * list rather than fabricated alarms. Swap this for the correlation service's
 * active groups when that projection exists.
 */
const liveAlarmProvider: AlarmProvider = {
  getActive: (): ActiveAlarm[] => [],
};

/**
 * Picks the concrete store on first use rather than at module load.
 *
 * `server/index.ts` imports the route graph — and therefore this module —
 * before it awaits `initializeDatabase()`. Choosing the store in the
 * constructor would sample `storage.isConnected()` too early and permanently
 * downgrade a database-backed deployment to a non-durable store. The first
 * call happens inside `initialize()`, which registerRoutes awaits after the
 * database is up.
 */
class DeferredMarketplaceStore implements MarketplaceStore {
  private delegate: MarketplaceStore | null = null;

  private resolve(): MarketplaceStore {
    if (!this.delegate) {
      this.delegate = storage.isConnected()
        ? new DatabaseMarketplaceStore()
        : new InMemoryMarketplaceStore();
    }
    return this.delegate;
  }

  get kind(): MarketplaceStore['kind'] {
    return this.resolve().kind;
  }

  load(): Promise<MarketplaceSnapshot> {
    return this.resolve().load();
  }

  saveEntry(entry: MarketplaceEntry): Promise<void> {
    return this.resolve().saveEntry(entry);
  }

  saveInstallation(plugin: InstalledPlugin): Promise<void> {
    return this.resolve().saveInstallation(plugin);
  }

  deleteInstallation(pluginId: string): Promise<void> {
    return this.resolve().deleteInstallation(pluginId);
  }
}

export class MarketplaceService extends EventEmitter {
  readonly marketplace: AgentMarketplace;

  private readonly store: MarketplaceStore;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  constructor(options: { store?: MarketplaceStore } = {}) {
    super();
    // A database-backed store is required for the ownership record to be a
    // real control. When the database is unavailable the service still runs,
    // but it says so rather than pretending the state is durable.
    this.store = options.store ?? new DeferredMarketplaceStore();

    this.marketplace = new AgentMarketplace({
      tagProvider: liveTagProvider,
      alarmProvider: liveAlarmProvider,
      store: this.store,
    });

    for (const event of [
      'marketplace-loaded',
      'plugin-published',
      'plugin-republished',
      'plugin-installed',
      'plugin-updated',
      'plugin-configured',
      'plugin-started',
      'plugin-stopped',
      'plugin-enabled',
      'plugin-disabled',
      'plugin-uninstalled',
      'plugin-auto-disabled',
      'plugin-event',
      'plugin-log',
      'plugin-capability-denied',
    ]) {
      this.marketplace.on(event, (payload: unknown) => this.emit(event, payload));
    }

    // Capability denial is a security event: a plugin reached for a host
    // service it was not granted. Audit it rather than only counting it.
    this.marketplace.on('plugin-capability-denied', (record: CapabilityDenialRecord) => {
      logWarn(
        `[marketplace] capability denied: plugin=${record.pluginId} `
        + `capability=${record.capability} reason=${record.reason}`,
      );
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = this.runInitialize();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async runInitialize(): Promise<void> {
    // Implementations must be registered before the state is loaded so that
    // restored installations report the right implementationState.
    for (const builtin of BUILTIN_PLUGINS) {
      this.marketplace.registerImplementation(builtin.manifest.id, builtin.handler);
    }

    try {
      await this.marketplace.load();
    } catch (error) {
      // Fail closed for the marketplace, not for the plant. A malformed
      // plugin row must not stop the SCADA server from starting, but it must
      // not silently produce an empty registry either: an ownership check
      // against an empty registry would authorize a hijack. The engine stays
      // un-loaded, every publish/install returns 503 store-unavailable, and
      // the service reports unhealthy until an operator fixes the row.
      logError(error, '[marketplace] state could not be loaded; marketplace mutations are refused');
      return;
    }

    for (const builtin of BUILTIN_PLUGINS) {
      try {
        await this.marketplace.publishSystemManifest(builtin.manifest);
      } catch (error) {
        // A built-in whose id collides with an operator-published plugin must
        // not take the server down, but it also must not be silently ignored.
        this.marketplace.unregisterImplementation(builtin.manifest.id);
        logError(
          error,
          `[marketplace] built-in plugin "${builtin.manifest.id}" could not be registered`,
        );
      }
    }

    if (this.store.kind !== 'database') {
      logWarn(
        '[marketplace] running on a non-durable in-memory store: plugin ownership '
        + 'and capability grants will NOT survive a restart. Configure the database '
        + 'before relying on marketplace authorization.',
      );
    }

    const status = this.marketplace.getStatus();
    logInfo(
      `[marketplace] ready: ${status.published} published, ${status.installed} installed, `
      + `${BUILTIN_PLUGINS.length} built-in implementation(s), store=${this.store.kind}`,
    );
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.initialized) {
      return { healthy: false, message: 'Marketplace service not initialized' };
    }
    const status = this.marketplace.getStatus();
    return {
      healthy: true,
      message:
        `Marketplace running: ${status.published} published, ${status.installed} installed, `
        + `${status.running} running, ${status.unimplemented} without an implementation, `
        + `store=${this.store.kind}${status.durable ? '' : ' (NOT durable)'}`,
    };
  }
}

export const marketplaceService = new MarketplaceService();
export { SYSTEM_PUBLISHER as MARKETPLACE_SYSTEM_PUBLISHER };
