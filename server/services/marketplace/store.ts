/**
 * Marketplace persistence contract.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 *
 * The registry (with its ownership record) and the installation records (with
 * their capability grants) are authorization state. State that resets on
 * restart is not an access control, so both are written through Drizzle to
 * `plugin_registry` / `plugin_installations` (migration
 * 0011_agent_marketplace.sql) by `DatabaseMarketplaceStore`.
 *
 * Deliberately NOT persisted: per-process invocation counters, failure
 * windows, uptime and the auto-disable streak. Those are transient telemetry
 * about the current process; a restart legitimately resets them. The
 * auto-disable *decision* is persisted, because it lands in the plugin's
 * status.
 *
 * This module holds no database import so the engine and its unit tests stay
 * free of the storage/driver graph. The Drizzle implementation lives in
 * ./database-store.
 */

import type {
  InstalledPlugin,
  MarketplaceEntry,
  PluginCapability,
  PluginManifest,
  PluginStatus,
} from '@shared/types/marketplace';

/**
 * The durable subset of an installation. Runtime-only fields (`startedAt`,
 * `lastError`, `implementationState`) are recomputed on load.
 */
export interface StoredInstallation {
  manifest: PluginManifest;
  status: PluginStatus;
  config: Record<string, string | number | boolean>;
  grantedCapabilities: PluginCapability[];
  installedBy: string;
  installedAt: number;
}

export interface MarketplaceSnapshot {
  entries: MarketplaceEntry[];
  installations: StoredInstallation[];
}

export interface MarketplaceStore {
  /** `database` is durable; `memory` is not — the service logs which is in use. */
  readonly kind: 'database' | 'memory';
  load(): Promise<MarketplaceSnapshot>;
  saveEntry(entry: MarketplaceEntry): Promise<void>;
  saveInstallation(plugin: InstalledPlugin): Promise<void>;
  deleteInstallation(pluginId: string): Promise<void>;
}

/**
 * Non-durable store. Used by unit tests, and by the service only when the
 * database is unavailable — in which case the service logs a warning saying
 * plainly that marketplace ownership does not survive a restart.
 */
export class InMemoryMarketplaceStore implements MarketplaceStore {
  readonly kind = 'memory' as const;

  private readonly entries = new Map<string, MarketplaceEntry>();
  private readonly installations = new Map<string, StoredInstallation>();

  async load(): Promise<MarketplaceSnapshot> {
    return {
      entries: [...this.entries.values()].map((entry) => ({
        ...entry,
        manifest: { ...entry.manifest },
      })),
      installations: [...this.installations.values()].map((install) => ({
        ...install,
        manifest: { ...install.manifest },
        config: { ...install.config },
        grantedCapabilities: [...install.grantedCapabilities],
      })),
    };
  }

  async saveEntry(entry: MarketplaceEntry): Promise<void> {
    this.entries.set(entry.manifest.id, { ...entry, manifest: { ...entry.manifest } });
  }

  async saveInstallation(plugin: InstalledPlugin): Promise<void> {
    this.installations.set(plugin.manifest.id, {
      manifest: { ...plugin.manifest },
      status: plugin.status,
      config: { ...plugin.config },
      grantedCapabilities: [...plugin.grantedCapabilities],
      installedBy: plugin.installedBy,
      installedAt: plugin.installedAt,
    });
  }

  async deleteInstallation(pluginId: string): Promise<void> {
    this.installations.delete(pluginId);
  }
}
