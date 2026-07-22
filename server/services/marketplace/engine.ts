/**
 * Agent Marketplace Engine
 * ADR-0013 [13.6] — Issue #217
 *
 * Plugin registry, install/configure/enable-disable lifecycle with real
 * semver dependency checking, capability-scoped execution, and health
 * monitoring with auto-disable.
 *
 * Execution model: handlers run in-process through a host context built
 * from the plugin's GRANTED capabilities only — an ungranted capability's
 * API is simply absent. Invocations carry a wall-clock timeout and feed a
 * windowed failure tracker; repeated failures auto-disable the plugin.
 * This is capability scoping + fault containment, not memory isolation
 * (see shared/types/marketplace.ts for the full statement).
 */

import { EventEmitter } from 'events';
import type {
  InstalledPlugin,
  MarketplaceEntry,
  PluginCapability,
  PluginCategory,
  PluginHealth,
  PluginInvocationResult,
  PluginManifest,
} from '@shared/types/marketplace';
import { compareSemver, parseSemver, satisfiesRange } from './semver';

// ── Host API surface (capability-gated) ───────────────────────────────────

export interface TagProvider {
  list(): string[];
  readLatest(tagId: string): { value: number | string; timestamp: number } | null;
}

export interface AlarmProvider {
  getActive(): Array<{ id: string; name: string; severity: string; message: string }>;
}

/** What a handler receives — only granted capability APIs are present */
export interface PluginHostContext {
  pluginId: string;
  config: Record<string, string | number | boolean>;
  tags?: TagProvider;
  alarms?: AlarmProvider;
  emitEvent?: (type: string, payload: Record<string, unknown>) => void;
  log?: (message: string) => void;
}

export type PluginHandler = (
  input: unknown,
  host: PluginHostContext
) => Promise<unknown> | unknown;

export interface MarketplaceOptions {
  tagProvider?: TagProvider;
  alarmProvider?: AlarmProvider;
  /** Wall-clock cap per invocation */
  invokeTimeoutMs?: number;
  /** Recent invocations tracked for the windowed error rate */
  errorWindow?: number;
  /** Consecutive failures before a plugin is auto-disabled */
  autoDisableAfter?: number;
}

interface PluginStats {
  invocations: number;
  failures: number;
  consecutiveFailures: number;
  recent: boolean[]; // true = success
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export class AgentMarketplace extends EventEmitter {
  private readonly tagProvider: TagProvider | null;
  private readonly alarmProvider: AlarmProvider | null;
  private readonly invokeTimeoutMs: number;
  private readonly errorWindow: number;
  private readonly autoDisableAfter: number;

  private registry: Map<string, MarketplaceEntry> = new Map();
  private installed: Map<string, InstalledPlugin> = new Map();
  private implementations: Map<string, PluginHandler> = new Map();
  private stats: Map<string, PluginStats> = new Map();

  constructor(options: MarketplaceOptions = {}) {
    super();
    this.tagProvider = options.tagProvider ?? null;
    this.alarmProvider = options.alarmProvider ?? null;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 5000;
    this.errorWindow = options.errorWindow ?? 20;
    this.autoDisableAfter = options.autoDisableAfter ?? 5;
  }

  // ── Registry ─────────────────────────────────────────────────────────

  /**
   * Publish a manifest. Republishing an existing id requires a strictly
   * newer semver and preserves the install counter (Wave-2 reset it).
   */
  publish(manifest: PluginManifest): MarketplaceEntry {
    if (!ID_PATTERN.test(manifest.id)) {
      throw new Error(`Plugin id "${manifest.id}" must match ${ID_PATTERN}`);
    }
    if (!parseSemver(manifest.version)) {
      throw new Error(`Plugin "${manifest.id}" version "${manifest.version}" is not valid semver`);
    }
    for (const range of Object.values(manifest.dependencies)) {
      if (range !== '*' && !parseSemver(range.replace(/^[\^~]/, ''))) {
        throw new Error(`Plugin "${manifest.id}" has invalid dependency range "${range}"`);
      }
    }

    const existing = this.registry.get(manifest.id);
    if (existing && compareSemver(manifest.version, existing.manifest.version) <= 0) {
      throw new Error(
        `Plugin "${manifest.id}" version ${manifest.version} is not newer than published ${existing.manifest.version}`
      );
    }
    const entry: MarketplaceEntry = {
      manifest: { ...manifest },
      publishedAt: existing?.publishedAt ?? Date.now(),
      updatedAt: Date.now(),
      installs: existing?.installs ?? 0,
    };
    this.registry.set(manifest.id, entry);
    this.emit(existing ? 'plugin-republished' : 'plugin-published', entry);
    return entry;
  }

  search(query = '', category?: PluginCategory): MarketplaceEntry[] {
    const q = query.trim().toLowerCase();
    return Array.from(this.registry.values()).filter((entry) => {
      const m = entry.manifest;
      if (category && m.category !== category) return false;
      if (!q) return true;
      return (
        m.id.includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }

  getEntry(pluginId: string): MarketplaceEntry | undefined {
    return this.registry.get(pluginId);
  }

  /** Handlers are registered in code — a manifest alone is not executable */
  registerImplementation(pluginId: string, handler: PluginHandler): void {
    this.implementations.set(pluginId, handler);
  }

  unregisterImplementation(pluginId: string): boolean {
    return this.implementations.delete(pluginId);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  install(
    pluginId: string,
    config: Record<string, string | number | boolean> = {},
    grants?: PluginCapability[]
  ): InstalledPlugin {
    const entry = this.registry.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" is not in the registry`);
    if (this.installed.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is already installed — use update()`);
    }

    // Dependencies must be installed AND satisfy the declared semver range
    for (const [depId, range] of Object.entries(entry.manifest.dependencies)) {
      const dep = this.installed.get(depId);
      if (!dep) throw new Error(`Missing dependency: ${depId}@${range}`);
      if (!satisfiesRange(dep.manifest.version, range)) {
        throw new Error(
          `Dependency ${depId}@${dep.manifest.version} does not satisfy required range "${range}"`
        );
      }
    }

    // Grants must be a subset of what the manifest declares
    const granted = grants ?? [...entry.manifest.requiredCapabilities];
    for (const capability of granted) {
      if (!entry.manifest.requiredCapabilities.includes(capability)) {
        throw new Error(
          `Capability "${capability}" is not declared by plugin "${pluginId}"`
        );
      }
    }

    const validatedConfig = this.validateConfig(entry.manifest, config);
    const plugin: InstalledPlugin = {
      manifest: { ...entry.manifest },
      status: 'installed',
      config: validatedConfig,
      grantedCapabilities: granted,
      installedAt: Date.now(),
      startedAt: null,
      lastError: null,
    };
    this.installed.set(pluginId, plugin);
    this.stats.set(pluginId, { invocations: 0, failures: 0, consecutiveFailures: 0, recent: [] });
    entry.installs++;
    this.emit('plugin-installed', plugin);
    return plugin;
  }

  /** Upgrade an installed plugin to the (strictly newer) registry version */
  update(pluginId: string): InstalledPlugin {
    const plugin = this.requireInstalled(pluginId);
    const entry = this.registry.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" is not in the registry`);
    if (compareSemver(entry.manifest.version, plugin.manifest.version) <= 0) {
      throw new Error(
        `Plugin "${pluginId}" is already at ${plugin.manifest.version}; registry has ${entry.manifest.version}`
      );
    }
    const wasRunning = plugin.status === 'running';
    if (wasRunning) this.stop(pluginId);

    // Revalidate carried-over config against the NEW schema
    plugin.config = this.validateConfig(entry.manifest, plugin.config);
    plugin.manifest = { ...entry.manifest };
    plugin.status = 'installed';
    plugin.lastError = null;
    this.emit('plugin-updated', plugin);
    if (wasRunning) this.start(pluginId);
    return plugin;
  }

  configure(
    pluginId: string,
    config: Record<string, string | number | boolean>
  ): InstalledPlugin {
    const plugin = this.requireInstalled(pluginId);
    plugin.config = this.validateConfig(plugin.manifest, config);
    this.emit('plugin-configured', plugin);
    return plugin;
  }

  start(pluginId: string): InstalledPlugin {
    const plugin = this.requireInstalled(pluginId);
    if (plugin.status === 'disabled') {
      throw new Error(`Plugin "${pluginId}" is disabled — enable it first`);
    }
    if (plugin.status === 'running') return plugin;
    plugin.status = 'running';
    plugin.startedAt = Date.now();
    plugin.lastError = null;
    const stats = this.stats.get(pluginId);
    if (stats) stats.consecutiveFailures = 0;
    this.emit('plugin-started', plugin);
    return plugin;
  }

  stop(pluginId: string): InstalledPlugin {
    const plugin = this.requireInstalled(pluginId);
    if (plugin.status === 'running' || plugin.status === 'error') {
      plugin.status = 'stopped';
      plugin.startedAt = null;
      this.emit('plugin-stopped', plugin);
    }
    return plugin;
  }

  /** Administratively block a plugin from starting or being invoked */
  disable(pluginId: string): InstalledPlugin {
    const plugin = this.requireInstalled(pluginId);
    plugin.status = 'disabled';
    plugin.startedAt = null;
    this.emit('plugin-disabled', plugin);
    return plugin;
  }

  enable(pluginId: string): InstalledPlugin {
    const plugin = this.requireInstalled(pluginId);
    if (plugin.status === 'disabled' || plugin.status === 'error') {
      plugin.status = 'stopped';
      const stats = this.stats.get(pluginId);
      if (stats) stats.consecutiveFailures = 0;
      this.emit('plugin-enabled', plugin);
    }
    return plugin;
  }

  uninstall(pluginId: string): void {
    this.requireInstalled(pluginId);
    // Refuse while other installed plugins depend on this one
    for (const other of this.installed.values()) {
      if (other.manifest.id !== pluginId && pluginId in other.manifest.dependencies) {
        throw new Error(
          `Cannot uninstall "${pluginId}": "${other.manifest.id}" depends on it`
        );
      }
    }
    this.installed.delete(pluginId);
    this.stats.delete(pluginId);
    this.emit('plugin-uninstalled', { pluginId });
  }

  listInstalled(): InstalledPlugin[] {
    return Array.from(this.installed.values());
  }

  getInstalled(pluginId: string): InstalledPlugin | undefined {
    return this.installed.get(pluginId);
  }

  // ── Execution ────────────────────────────────────────────────────────

  async invoke(pluginId: string, input: unknown): Promise<PluginInvocationResult> {
    const started = Date.now();
    const plugin = this.installed.get(pluginId);
    if (!plugin) {
      return this.failResult(pluginId, `Plugin "${pluginId}" is not installed`, started);
    }
    if (plugin.status !== 'running') {
      return this.failResult(
        pluginId,
        `Plugin "${pluginId}" is ${plugin.status}, not running`,
        started
      );
    }
    const handler = this.implementations.get(pluginId);
    if (!handler) {
      return this.failResult(
        pluginId,
        `Plugin "${pluginId}" has no registered implementation`,
        started
      );
    }

    const host = this.buildHostContext(plugin);
    try {
      const output = await this.withTimeout(
        Promise.resolve().then(() => handler(input, host)),
        this.invokeTimeoutMs,
        pluginId
      );
      this.recordOutcome(pluginId, true, null);
      return { pluginId, success: true, output, durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordOutcome(pluginId, false, message);
      return { pluginId, success: false, error: message, durationMs: Date.now() - started };
    }
  }

  // ── Health ───────────────────────────────────────────────────────────

  getHealth(pluginId: string): PluginHealth | null {
    const plugin = this.installed.get(pluginId);
    if (!plugin) return null;
    const stats = this.stats.get(pluginId) ?? {
      invocations: 0,
      failures: 0,
      consecutiveFailures: 0,
      recent: [],
    };
    const windowFailures = stats.recent.filter((ok) => !ok).length;
    return {
      pluginId,
      status: plugin.status,
      // Uptime counts from the last start, not install time (Wave-2 bug)
      uptimeSeconds:
        plugin.status === 'running' && plugin.startedAt
          ? Math.round((Date.now() - plugin.startedAt) / 1000)
          : 0,
      invocations: stats.invocations,
      failures: stats.failures,
      windowedErrorRate:
        stats.recent.length === 0 ? 0 : windowFailures / stats.recent.length,
      consecutiveFailures: stats.consecutiveFailures,
      lastError: plugin.lastError,
      hasImplementation: this.implementations.has(pluginId),
    };
  }

  getAllHealth(): PluginHealth[] {
    return Array.from(this.installed.keys())
      .map((id) => this.getHealth(id))
      .filter((h): h is PluginHealth => h !== null);
  }

  getStatus(): { published: number; installed: number; running: number } {
    return {
      published: this.registry.size,
      installed: this.installed.size,
      running: this.listInstalled().filter((p) => p.status === 'running').length,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private requireInstalled(pluginId: string): InstalledPlugin {
    const plugin = this.installed.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" is not installed`);
    return plugin;
  }

  /**
   * Validate config against the schema. Defaults apply to EVERY field
   * that declares one (Wave-2 only applied them to required fields);
   * required fields without a value or default fail; values are
   * type-checked; select values must be in options; unknown keys fail.
   * The caller's object is never mutated.
   */
  private validateConfig(
    manifest: PluginManifest,
    config: Record<string, string | number | boolean>
  ): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(config)) {
      if (!(key in manifest.configSchema)) {
        throw new Error(`Unknown config key "${key}" for plugin "${manifest.id}"`);
      }
    }
    for (const [key, field] of Object.entries(manifest.configSchema)) {
      let value = config[key];
      if (value === undefined) {
        if (field.default !== undefined) {
          value = field.default;
        } else if (field.required) {
          throw new Error(`Missing required config "${key}" for plugin "${manifest.id}"`);
        } else {
          continue;
        }
      }
      const expected = field.type === 'select' ? 'string' : field.type;
      if (typeof value !== expected) {
        throw new Error(
          `Config "${key}" for plugin "${manifest.id}" must be a ${expected}`
        );
      }
      if (field.type === 'select' && field.options && !field.options.includes(value as string)) {
        throw new Error(
          `Config "${key}" must be one of: ${field.options.join(', ')}`
        );
      }
      result[key] = value;
    }
    return result;
  }

  private buildHostContext(plugin: InstalledPlugin): PluginHostContext {
    const host: PluginHostContext = {
      pluginId: plugin.manifest.id,
      config: { ...plugin.config },
    };
    const granted = plugin.grantedCapabilities;
    if (granted.includes('tags:read') && this.tagProvider) {
      host.tags = this.tagProvider;
    }
    if (granted.includes('alarms:read') && this.alarmProvider) {
      host.alarms = this.alarmProvider;
    }
    if (granted.includes('events:emit')) {
      host.emitEvent = (type, payload) =>
        this.emit('plugin-event', { pluginId: plugin.manifest.id, type, payload });
    }
    if (granted.includes('log')) {
      host.log = (message) =>
        this.emit('plugin-log', { pluginId: plugin.manifest.id, message });
    }
    return host;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, pluginId: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Plugin "${pluginId}" invocation timed out after ${ms}ms`)),
            ms
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private recordOutcome(pluginId: string, success: boolean, error: string | null): void {
    const plugin = this.installed.get(pluginId);
    const stats = this.stats.get(pluginId);
    if (!plugin || !stats) return;

    stats.invocations++;
    stats.recent.push(success);
    if (stats.recent.length > this.errorWindow) stats.recent.shift();

    if (success) {
      stats.consecutiveFailures = 0;
    } else {
      stats.failures++;
      stats.consecutiveFailures++;
      plugin.lastError = error;
      if (stats.consecutiveFailures >= this.autoDisableAfter && plugin.status === 'running') {
        plugin.status = 'error';
        plugin.startedAt = null;
        this.emit('plugin-auto-disabled', {
          pluginId,
          consecutiveFailures: stats.consecutiveFailures,
          lastError: error,
        });
      }
    }
  }

  private failResult(
    pluginId: string,
    error: string,
    startedMs: number
  ): PluginInvocationResult {
    return { pluginId, success: false, error, durationMs: Date.now() - startedMs };
  }
}
