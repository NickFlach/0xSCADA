/**
 * Agent Marketplace & Plugin System
 * ADR-0013 [13.6] — Registry, installation, sandboxed execution
 */

import type {
  PluginManifest,
  InstalledPlugin,
  PluginExecutionContext,
  PluginHealthStatus,
  PluginStatus,
  MarketplaceEntry,
} from '../../shared/types/marketplace';

export class AgentMarketplace {
  private registry: Map<string, MarketplaceEntry> = new Map();
  private installed: Map<string, InstalledPlugin> = new Map();
  private contexts: Map<string, PluginExecutionContext> = new Map();
  private healthCheckers: Map<string, NodeJS.Timeout> = new Map();

  // ── Registry ──────────────────────────────────────────────────

  publish(manifest: PluginManifest): MarketplaceEntry {
    const entry: MarketplaceEntry = {
      manifest,
      downloads: 0,
      rating: 0,
      verified: false,
      publishedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.registry.set(manifest.id, entry);
    return entry;
  }

  search(query: string, category?: string): MarketplaceEntry[] {
    const lower = query.toLowerCase();
    return [...this.registry.values()].filter((e) => {
      const matchesQuery =
        !query ||
        e.manifest.name.toLowerCase().includes(lower) ||
        e.manifest.description.toLowerCase().includes(lower) ||
        e.manifest.tags.some((t) => t.toLowerCase().includes(lower));
      const matchesCategory = !category || e.manifest.category === category;
      return matchesQuery && matchesCategory;
    });
  }

  getEntry(pluginId: string): MarketplaceEntry | undefined {
    return this.registry.get(pluginId);
  }

  // ── Installation ──────────────────────────────────────────────

  install(pluginId: string, config: Record<string, unknown> = {}): InstalledPlugin | null {
    const entry = this.registry.get(pluginId);
    if (!entry) return null;

    // Check dependencies
    for (const [depId] of Object.entries(entry.manifest.dependencies)) {
      if (!this.installed.has(depId)) {
        throw new Error(`Missing dependency: ${depId}`);
      }
    }

    // Validate config against schema
    for (const [key, field] of Object.entries(entry.manifest.configSchema)) {
      if (field.required && !(key in config)) {
        if (field.default !== undefined) {
          config[key] = field.default;
        } else {
          throw new Error(`Missing required config: ${key}`);
        }
      }
    }

    const plugin: InstalledPlugin = {
      manifest: entry.manifest,
      status: 'installed',
      installedAt: Date.now(),
      config,
      lastHealthCheck: Date.now(),
      errorCount: 0,
    };

    this.installed.set(pluginId, plugin);
    entry.downloads++;

    // Create execution context
    this.contexts.set(pluginId, {
      pluginId,
      capabilities: entry.manifest.requiredCapabilities,
      sandbox: {
        allowNetwork: false,
        allowFileSystem: false,
        memoryLimitMb: 128,
        timeoutMs: 30000,
      },
    });

    return plugin;
  }

  uninstall(pluginId: string): boolean {
    this.stop(pluginId);
    this.contexts.delete(pluginId);
    return this.installed.delete(pluginId);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start(pluginId: string): boolean {
    const plugin = this.installed.get(pluginId);
    if (!plugin || plugin.status === 'running') return false;

    plugin.status = 'running';

    // Start health monitoring
    const interval = setInterval(() => {
      this.checkHealth(pluginId);
    }, 30000);
    this.healthCheckers.set(pluginId, interval);

    return true;
  }

  stop(pluginId: string): boolean {
    const plugin = this.installed.get(pluginId);
    if (!plugin) return false;

    plugin.status = 'stopped';

    const checker = this.healthCheckers.get(pluginId);
    if (checker) {
      clearInterval(checker);
      this.healthCheckers.delete(pluginId);
    }

    return true;
  }

  // ── Health ────────────────────────────────────────────────────

  private checkHealth(pluginId: string): void {
    const plugin = this.installed.get(pluginId);
    if (!plugin) return;

    plugin.lastHealthCheck = Date.now();
    // In production: check actual plugin process health
  }

  getHealth(pluginId: string): PluginHealthStatus | null {
    const plugin = this.installed.get(pluginId);
    if (!plugin) return null;

    return {
      pluginId,
      healthy: plugin.status === 'running' && plugin.errorCount < 10,
      uptime: plugin.status === 'running' ? Date.now() - plugin.installedAt : 0,
      memoryUsageMb: 0, // Would read from actual sandbox
      lastActivity: plugin.lastHealthCheck,
      errorRate: plugin.errorCount,
    };
  }

  reportError(pluginId: string, error: string): void {
    const plugin = this.installed.get(pluginId);
    if (!plugin) return;

    plugin.errorCount++;
    plugin.lastError = error;

    if (plugin.errorCount >= 10) {
      plugin.status = 'error';
      this.stop(pluginId);
    }
  }

  // ── Accessors ─────────────────────────────────────────────────

  getInstalled(): InstalledPlugin[] {
    return [...this.installed.values()];
  }

  getRunning(): InstalledPlugin[] {
    return [...this.installed.values()].filter((p) => p.status === 'running');
  }

  getContext(pluginId: string): PluginExecutionContext | undefined {
    return this.contexts.get(pluginId);
  }

  updateConfig(pluginId: string, config: Record<string, unknown>): boolean {
    const plugin = this.installed.get(pluginId);
    if (!plugin) return false;
    plugin.config = { ...plugin.config, ...config };
    return true;
  }

  destroyAll(): void {
    for (const [id] of this.healthCheckers) {
      this.stop(id);
    }
    this.installed.clear();
    this.contexts.clear();
  }
}
