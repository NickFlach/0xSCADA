/**
 * Drizzle-backed marketplace store.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 *
 * Writes through `server/storage.ts`, which resolves to Postgres in
 * production (tables created by migrations/0011_agent_marketplace.sql) and to
 * the repository's SQLite development fallback otherwise. Both back-ends are
 * durable across a restart, which is the whole point: the ownership record
 * that blocks manifest hijack is only an access control while it survives.
 */

import type {
  InstalledPlugin,
  MarketplaceEntry,
  PluginCapability,
  PluginManifest,
  PluginStatus,
} from '@shared/types/marketplace';
import { storage } from '../../storage';
import { MarketplaceError } from './errors';
import type { MarketplaceSnapshot, MarketplaceStore, StoredInstallation } from './store';

function asRecord(value: unknown, field: string, pluginId: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new MarketplaceError(
    'invalid-manifest',
    `Stored plugin "${pluginId}" has a malformed ${field} column`,
  );
}

/**
 * Persisted manifests were validated by the publish path before they were
 * written, but a row can still be edited or corrupted out of band. Re-check
 * the shape on the way back in rather than trusting the column.
 */
function toManifest(value: unknown, pluginId: string): PluginManifest {
  const raw = asRecord(value, 'manifest', pluginId);
  if (
    typeof raw.id !== 'string'
    || typeof raw.name !== 'string'
    || typeof raw.version !== 'string'
    || typeof raw.category !== 'string'
    || !Array.isArray(raw.requiredCapabilities)
    || !Array.isArray(raw.tags)
    || typeof raw.dependencies !== 'object'
    || raw.dependencies === null
    || typeof raw.configSchema !== 'object'
    || raw.configSchema === null
  ) {
    throw new MarketplaceError(
      'invalid-manifest',
      `Stored plugin "${pluginId}" has a malformed manifest column`,
    );
  }
  return raw as unknown as PluginManifest;
}

function toConfig(value: unknown, pluginId: string): Record<string, string | number | boolean> {
  const raw = asRecord(value, 'config', pluginId);
  const config: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      config[key] = entry;
      continue;
    }
    throw new MarketplaceError(
      'invalid-config',
      `Stored plugin "${pluginId}" has a non-scalar value for config key "${key}"`,
    );
  }
  return config;
}

function toCapabilities(value: unknown, pluginId: string): PluginCapability[] {
  if (!Array.isArray(value)) {
    throw new MarketplaceError(
      'invalid-manifest',
      `Stored plugin "${pluginId}" has a malformed granted_capabilities column`,
    );
  }
  return value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new MarketplaceError(
        'invalid-manifest',
        `Stored plugin "${pluginId}" has a non-string granted capability`,
      );
    }
    return entry as PluginCapability;
  });
}

const PLUGIN_STATUSES: readonly PluginStatus[] = [
  'installed',
  'running',
  'stopped',
  'disabled',
  'error',
];

/**
 * A plugin that was `running` when the server stopped is not running now.
 * Restoring it as `running` would report uptime for something that never
 * started, so a restart lands in `stopped` and an operator restarts it.
 * `disabled` and `error` survive verbatim — a restart must not clear them.
 */
function toRestoredStatus(value: unknown, pluginId: string): PluginStatus {
  if (typeof value !== 'string' || !PLUGIN_STATUSES.includes(value as PluginStatus)) {
    throw new MarketplaceError(
      'invalid-state',
      `Stored plugin "${pluginId}" has an unknown status "${String(value)}"`,
    );
  }
  const status = value as PluginStatus;
  return status === 'running' ? 'stopped' : status;
}

function toEpoch(value: unknown, pluginId: string, column: string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new MarketplaceError(
    'invalid-state',
    `Stored plugin "${pluginId}" has an unreadable ${column} timestamp`,
  );
}

export class DatabaseMarketplaceStore implements MarketplaceStore {
  readonly kind = 'database' as const;

  async load(): Promise<MarketplaceSnapshot> {
    const registryRows = await storage.getPluginRegistryEntries();
    const installRows = await storage.getPluginInstallations();

    const entries: MarketplaceEntry[] = registryRows.map((row) => ({
      manifest: toManifest(row.manifest, row.id),
      publisher: row.publisher,
      publishedAt: toEpoch(row.publishedAt, row.id, 'published_at'),
      updatedAt: toEpoch(row.updatedAt, row.id, 'updated_at'),
      installs: Number(row.installs),
    }));

    const installations: StoredInstallation[] = installRows.map((row) => ({
      manifest: toManifest(row.manifest, row.id),
      status: toRestoredStatus(row.status, row.id),
      config: toConfig(row.config, row.id),
      grantedCapabilities: toCapabilities(row.grantedCapabilities, row.id),
      installedBy: row.installedBy,
      installedAt: toEpoch(row.installedAt, row.id, 'installed_at'),
    }));

    return { entries, installations };
  }

  async saveEntry(entry: MarketplaceEntry): Promise<void> {
    await storage.upsertPluginRegistryEntry({
      id: entry.manifest.id,
      version: entry.manifest.version,
      manifest: entry.manifest,
      publisher: entry.publisher,
      installs: entry.installs,
      publishedAt: new Date(entry.publishedAt),
      updatedAt: new Date(entry.updatedAt),
    });
  }

  async saveInstallation(plugin: InstalledPlugin): Promise<void> {
    await storage.upsertPluginInstallation({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      manifest: plugin.manifest,
      status: plugin.status,
      config: plugin.config,
      grantedCapabilities: plugin.grantedCapabilities,
      installedBy: plugin.installedBy,
      installedAt: new Date(plugin.installedAt),
      updatedAt: new Date(),
    });
  }

  async deleteInstallation(pluginId: string): Promise<void> {
    await storage.deletePluginInstallation(pluginId);
  }
}
