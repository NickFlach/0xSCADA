/**
 * Agent Marketplace engine.
 *
 * Feature [13.6] of ADR-0013 (docs/decisions/ADR-0013-autonomous-agent-architecture.md).
 * Issue #217. Design notes: docs/architecture/agent-marketplace.md.
 *
 * Responsibilities:
 *   - a registry of plugin manifests with real semver rules and a durable
 *     ownership record that blocks manifest hijack;
 *   - install / configure / lifecycle records with durable capability grants;
 *   - invocation of the FIRST-PARTY handler registered for a plugin id, under
 *     an enforcing capability gate, a wall-clock timeout, and a windowed
 *     failure tracker that auto-disables a misbehaving plugin.
 *
 * ── Isolation, stated plainly ────────────────────────────────────────────
 * Handlers execute in-process, in this server's own isolate. That is NOT a
 * security sandbox: a hostile handler could reach `process`, the filesystem,
 * or the event loop no matter what its manifest declares. What the capability
 * system does is constrain a COOPERATIVE plugin's access to host services at
 * the host-context boundary, and make every out-of-scope reach fail loudly
 * and audibly instead of silently succeeding.
 *
 * The reason that is a defensible position here is that no third-party code
 * can ever run: a published manifest is metadata only, nothing is downloaded
 * or dynamically loaded, and the only executable handlers are first-party
 * modules compiled into this server and registered through
 * `registerImplementation`. Executing untrusted code would require process or
 * VM isolation, which this repository does not implement.
 */

import { EventEmitter } from 'events';
import type {
  CapabilityDenialRecord,
  InstalledPlugin,
  MarketplaceEntry,
  PluginCapability,
  PluginCategory,
  PluginHealth,
  PluginImplementationState,
  PluginInvocationCode,
  PluginInvocationResult,
  PluginManifest,
} from '@shared/types/marketplace';
import { compareSemver, parseSemver, satisfiesRange } from './semver';
import { MarketplaceError } from './errors';
import { InMemoryMarketplaceStore, type MarketplaceStore } from './store';

// ── Host API surface (capability-gated) ───────────────────────────────────

export interface TagSample {
  value: number | string;
  timestamp: number;
}

export interface TagProvider {
  list(): string[];
  readLatest(tagId: string): TagSample | null;
}

export interface ActiveAlarm {
  id: string;
  name: string;
  severity: string;
  message: string;
}

export interface AlarmProvider {
  getActive(): ActiveAlarm[];
}

/**
 * What a handler receives.
 *
 * Every capability accessor is a getter that ENFORCES the grant: reading
 * `host.tags` without `tags:read` both declared in the manifest and granted
 * at install time throws `MarketplaceError('capability-denied')` and emits an
 * audit event. Nothing is silently omitted, so a plugin cannot quietly skip a
 * check it was supposed to make. `host.capabilities` is the supported way for
 * a cooperative plugin to feature-detect before reaching.
 */
export interface PluginHostContext {
  readonly pluginId: string;
  readonly config: Readonly<Record<string, string | number | boolean>>;
  readonly capabilities: readonly PluginCapability[];
  readonly tags: TagProvider;
  readonly alarms: AlarmProvider;
  readonly emitEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly log: (message: string) => void;
}

export type PluginHandler = (
  input: unknown,
  host: PluginHostContext,
) => Promise<unknown> | unknown;

export interface MarketplaceOptions {
  tagProvider?: TagProvider;
  alarmProvider?: AlarmProvider;
  /** Durable store. Defaults to a non-durable in-memory store for unit tests. */
  store?: MarketplaceStore;
  /** Wall-clock cap per invocation. */
  invokeTimeoutMs?: number;
  /** Recent invocations tracked for the windowed error rate. */
  errorWindow?: number;
  /** Consecutive failures before a plugin is auto-disabled. */
  autoDisableAfter?: number;
}

export interface InstallRequest {
  config?: Record<string, string | number | boolean>;
  grants?: PluginCapability[];
  /** Authenticated principal performing the install. */
  installedBy: string;
}

interface PluginStats {
  invocations: number;
  failures: number;
  consecutiveFailures: number;
  capabilityDenials: number;
  /** Rolling window of outcomes; `true` = success. */
  recent: boolean[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Owner of the compiled-in first-party plugins. Reserved: the HTTP publish
 * path refuses any principal whose name starts with `system:`, so a
 * configured API key cannot impersonate the built-in publisher and take over
 * a built-in plugin id.
 */
export const SYSTEM_PUBLISHER = 'system:builtin';
const RESERVED_PUBLISHER_PREFIX = 'system:';

/**
 * Raised by the invocation timer only.
 *
 * A nominal type rather than a message match: classifying by
 * `message.includes('timed out')` would let a handler mislabel its own
 * ordinary failure as a host-imposed timeout and corrupt the audit trail.
 * Only this class, constructed inside `withTimeout`, can produce
 * `code: "timeout"`.
 */
class PluginTimeoutError extends Error {
  constructor(pluginId: string, ms: number) {
    super(`Plugin "${pluginId}" invocation timed out after ${ms}ms`);
    this.name = 'PluginTimeoutError';
  }
}

function emptyStats(): PluginStats {
  return {
    invocations: 0,
    failures: 0,
    consecutiveFailures: 0,
    capabilityDenials: 0,
    recent: [],
  };
}

export class AgentMarketplace extends EventEmitter {
  private readonly tagProvider: TagProvider | null;
  private readonly alarmProvider: AlarmProvider | null;
  private readonly store: MarketplaceStore;
  private readonly invokeTimeoutMs: number;
  private readonly errorWindow: number;
  private readonly autoDisableAfter: number;

  private registry = new Map<string, MarketplaceEntry>();
  private installed = new Map<string, InstalledPlugin>();
  private readonly implementations = new Map<string, PluginHandler>();
  private readonly stats = new Map<string, PluginStats>();
  private loaded = false;

  constructor(options: MarketplaceOptions = {}) {
    super();
    this.tagProvider = options.tagProvider ?? null;
    this.alarmProvider = options.alarmProvider ?? null;
    this.store = options.store ?? new InMemoryMarketplaceStore();
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 5000;
    this.errorWindow = options.errorWindow ?? 20;
    this.autoDisableAfter = options.autoDisableAfter ?? 5;
  }

  get storeKind(): MarketplaceStore['kind'] {
    return this.store.kind;
  }

  // ── Startup ──────────────────────────────────────────────────────────

  /**
   * Hydrate the registry, ownership records and installations from the store.
   * Called once at startup, before the HTTP surface accepts a publish — an
   * ownership check against an unhydrated registry would authorize a hijack.
   */
  async load(): Promise<void> {
    const snapshot = await this.store.load();

    const registry = new Map<string, MarketplaceEntry>();
    for (const entry of snapshot.entries) {
      registry.set(entry.manifest.id, entry);
    }

    const installed = new Map<string, InstalledPlugin>();
    for (const record of snapshot.installations) {
      installed.set(record.manifest.id, {
        manifest: record.manifest,
        status: record.status,
        config: record.config,
        grantedCapabilities: record.grantedCapabilities,
        installedBy: record.installedBy,
        installedAt: record.installedAt,
        startedAt: null,
        lastError: null,
        implementationState: this.implementationState(record.manifest.id),
      });
      this.stats.set(record.manifest.id, emptyStats());
    }

    this.registry = registry;
    this.installed = installed;
    this.loaded = true;
    this.emit('marketplace-loaded', {
      store: this.store.kind,
      published: registry.size,
      installed: installed.size,
    });
  }

  // ── Registry ─────────────────────────────────────────────────────────

  /**
   * Publish a manifest on behalf of an authenticated principal.
   *
   * First publish of an id records `publisher` as its durable owner. Every
   * later publish of that id must come from the same principal, and must
   * carry a strictly newer semver — republishing an existing version is
   * refused. Together these close the manifest-hijack hole: a different
   * principal cannot take over an id by bumping its version.
   */
  async publish(manifest: PluginManifest, publisher: string): Promise<MarketplaceEntry> {
    this.requireLoaded();
    // Normalize before comparing: an ownership record that distinguishes
    // "alice" from " alice" is trivially defeated.
    const identity = publisher.trim();
    if (identity.length === 0) {
      throw new MarketplaceError('ownership-conflict', 'A publisher identity is required');
    }
    if (identity.startsWith(RESERVED_PUBLISHER_PREFIX)) {
      throw new MarketplaceError(
        'ownership-conflict',
        `Publisher names beginning with "${RESERVED_PUBLISHER_PREFIX}" are reserved for built-in plugins`,
      );
    }
    return this.writeEntry(manifest, identity);
  }

  /**
   * Publish a compiled-in first-party manifest. Not reachable over HTTP.
   *
   * The compiled manifest is authoritative and the registry row is a
   * projection of it, so re-publishing the same version at every boot is a
   * no-op rewrite rather than a version conflict. A stored version NEWER than
   * the compiled one means the deployment was rolled back under a live
   * database; that is refused loudly instead of silently downgrading.
   */
  async publishSystemManifest(manifest: PluginManifest): Promise<MarketplaceEntry> {
    this.requireLoaded();
    const existing = this.registry.get(manifest.id);
    if (existing && existing.publisher !== SYSTEM_PUBLISHER) {
      throw new MarketplaceError(
        'ownership-conflict',
        `Built-in plugin "${manifest.id}" is already registered to publisher "${existing.publisher}"`,
      );
    }
    if (existing && compareSemver(manifest.version, existing.manifest.version) < 0) {
      throw new MarketplaceError(
        'version-conflict',
        `Built-in plugin "${manifest.id}" is compiled at ${manifest.version} but the registry holds newer ${existing.manifest.version}`,
      );
    }
    return this.writeEntry(manifest, SYSTEM_PUBLISHER, { allowSameVersion: true });
  }

  private async writeEntry(
    manifest: PluginManifest,
    publisher: string,
    options: { allowSameVersion?: boolean } = {},
  ): Promise<MarketplaceEntry> {
    this.validateManifest(manifest);

    const existing = this.registry.get(manifest.id);
    if (existing) {
      if (existing.publisher !== publisher) {
        // The hijack the review flagged: a different principal republishing
        // someone else's id with a bumped version.
        throw new MarketplaceError(
          'ownership-conflict',
          `Plugin "${manifest.id}" is owned by another publisher`,
        );
      }
      const order = compareSemver(manifest.version, existing.manifest.version);
      if (order < 0 || (order === 0 && !options.allowSameVersion)) {
        throw new MarketplaceError(
          'version-conflict',
          `Plugin "${manifest.id}" version ${manifest.version} is not newer than published ${existing.manifest.version}`,
        );
      }
    }

    const entry: MarketplaceEntry = {
      manifest: { ...manifest },
      publisher,
      publishedAt: existing?.publishedAt ?? Date.now(),
      updatedAt: Date.now(),
      installs: existing?.installs ?? 0,
    };
    await this.store.saveEntry(entry);
    this.registry.set(manifest.id, entry);
    this.emit(existing ? 'plugin-republished' : 'plugin-published', entry);
    return entry;
  }

  search(query = '', category?: PluginCategory): MarketplaceEntry[] {
    const needle = query.trim().toLowerCase();
    return [...this.registry.values()].filter((entry) => {
      const manifest = entry.manifest;
      if (category && manifest.category !== category) return false;
      if (!needle) return true;
      return (
        manifest.id.includes(needle)
        || manifest.name.toLowerCase().includes(needle)
        || manifest.description.toLowerCase().includes(needle)
        || manifest.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }

  getEntry(pluginId: string): MarketplaceEntry | undefined {
    return this.registry.get(pluginId);
  }

  /** The durable owner of a plugin id, if it has ever been published. */
  getPublisher(pluginId: string): string | undefined {
    return this.registry.get(pluginId)?.publisher;
  }

  // ── Implementations ──────────────────────────────────────────────────

  /**
   * Bind an executable handler to a plugin id.
   *
   * Only first-party modules compiled into this server call this — see
   * ./builtin, which is invoked from MarketplaceService.initialize(). There is
   * deliberately no HTTP path to it: a published manifest never becomes
   * executable on its own.
   */
  registerImplementation(pluginId: string, handler: PluginHandler): void {
    this.implementations.set(pluginId, handler);
    const plugin = this.installed.get(pluginId);
    if (plugin) plugin.implementationState = 'available';
  }

  unregisterImplementation(pluginId: string): boolean {
    const removed = this.implementations.delete(pluginId);
    const plugin = this.installed.get(pluginId);
    if (plugin) plugin.implementationState = this.implementationState(pluginId);
    return removed;
  }

  private implementationState(pluginId: string): PluginImplementationState {
    return this.implementations.has(pluginId) ? 'available' : 'unavailable';
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async install(pluginId: string, request: InstallRequest): Promise<InstalledPlugin> {
    this.requireLoaded();
    const entry = this.registry.get(pluginId);
    if (!entry) {
      throw new MarketplaceError('not-found', `Plugin "${pluginId}" is not in the registry`);
    }
    if (this.installed.has(pluginId)) {
      throw new MarketplaceError(
        'already-installed',
        `Plugin "${pluginId}" is already installed — use update()`,
      );
    }
    const installedBy = request.installedBy.trim();
    if (installedBy.length === 0) {
      throw new MarketplaceError('invalid-state', 'An installing principal is required');
    }

    // Dependencies must be installed AND satisfy the declared semver range.
    for (const [depId, range] of Object.entries(entry.manifest.dependencies)) {
      const dependency = this.installed.get(depId);
      if (!dependency) {
        throw new MarketplaceError(
          'dependency-missing',
          `Missing dependency: ${depId}@${range}`,
        );
      }
      if (!satisfiesRange(dependency.manifest.version, range)) {
        throw new MarketplaceError(
          'dependency-unsatisfied',
          `Dependency ${depId}@${dependency.manifest.version} does not satisfy required range "${range}"`,
        );
      }
    }

    const granted = this.narrowGrants(
      entry.manifest,
      request.grants ?? [...entry.manifest.requiredCapabilities],
      { rejectUndeclared: true },
    );

    const plugin: InstalledPlugin = {
      manifest: { ...entry.manifest },
      status: 'installed',
      config: this.validateConfig(entry.manifest, request.config ?? {}),
      grantedCapabilities: granted,
      installedBy,
      installedAt: Date.now(),
      startedAt: null,
      lastError: null,
      implementationState: this.implementationState(pluginId),
    };

    // Persist before publishing to the in-memory view: a store failure must
    // leave no installed plugin behind, not an installation the next restart
    // would forget.
    await this.store.saveInstallation(plugin);
    const updatedEntry: MarketplaceEntry = { ...entry, installs: entry.installs + 1 };
    await this.store.saveEntry(updatedEntry);

    this.installed.set(pluginId, plugin);
    this.stats.set(pluginId, emptyStats());
    this.registry.set(pluginId, updatedEntry);

    this.emit('plugin-installed', plugin);
    return plugin;
  }

  /** Upgrade an installed plugin to the (strictly newer) registry version. */
  async update(pluginId: string): Promise<InstalledPlugin> {
    const plugin = this.requireInstalled(pluginId);
    const entry = this.registry.get(pluginId);
    if (!entry) {
      throw new MarketplaceError('not-found', `Plugin "${pluginId}" is not in the registry`);
    }
    if (compareSemver(entry.manifest.version, plugin.manifest.version) <= 0) {
      throw new MarketplaceError(
        'version-conflict',
        `Plugin "${pluginId}" is already at ${plugin.manifest.version}; registry has ${entry.manifest.version}`,
      );
    }

    const wasRunning = plugin.status === 'running';
    if (wasRunning) await this.stop(pluginId);

    // Re-validate carried-over config against the NEW schema, and narrow the
    // existing grants to what the new manifest still declares. A new version
    // never widens an existing grant on its own — that would let a republish
    // silently escalate an already-approved installation.
    const next: InstalledPlugin = {
      ...plugin,
      config: this.validateConfig(entry.manifest, plugin.config),
      grantedCapabilities: this.narrowGrants(
        entry.manifest,
        plugin.grantedCapabilities,
        { rejectUndeclared: false },
      ),
      manifest: { ...entry.manifest },
      status: 'installed',
      lastError: null,
      implementationState: this.implementationState(pluginId),
    };
    await this.commit(plugin, next);
    this.emit('plugin-updated', plugin);
    if (wasRunning) await this.start(pluginId);
    return plugin;
  }

  async configure(
    pluginId: string,
    config: Record<string, string | number | boolean>,
  ): Promise<InstalledPlugin> {
    const plugin = this.requireInstalled(pluginId);
    await this.commit(plugin, {
      ...plugin,
      config: this.validateConfig(plugin.manifest, config),
    });
    this.emit('plugin-configured', plugin);
    return plugin;
  }

  async start(pluginId: string): Promise<InstalledPlugin> {
    const plugin = this.requireInstalled(pluginId);
    if (plugin.status === 'disabled') {
      throw new MarketplaceError(
        'invalid-state',
        `Plugin "${pluginId}" is disabled — enable it first`,
      );
    }
    if (plugin.implementationState !== 'available') {
      // Refuse rather than run something that can only ever fail. The state
      // is reported by listInstalled()/getHealth() so callers can tell an
      // un-implemented plugin from a broken one.
      throw new MarketplaceError(
        'not-implemented',
        `Plugin "${pluginId}" is installed but no implementation is registered in this build`,
      );
    }
    if (plugin.status === 'running') return plugin;

    await this.commit(plugin, {
      ...plugin,
      status: 'running',
      startedAt: Date.now(),
      lastError: null,
    });
    const stats = this.stats.get(pluginId);
    if (stats) stats.consecutiveFailures = 0;

    this.emit('plugin-started', plugin);
    return plugin;
  }

  async stop(pluginId: string): Promise<InstalledPlugin> {
    const plugin = this.requireInstalled(pluginId);
    if (plugin.status === 'running' || plugin.status === 'error') {
      await this.commit(plugin, { ...plugin, status: 'stopped', startedAt: null });
      this.emit('plugin-stopped', plugin);
    }
    return plugin;
  }

  /** Administratively block a plugin from starting or being invoked. */
  async disable(pluginId: string): Promise<InstalledPlugin> {
    const plugin = this.requireInstalled(pluginId);
    await this.commit(plugin, { ...plugin, status: 'disabled', startedAt: null });
    this.emit('plugin-disabled', plugin);
    return plugin;
  }

  async enable(pluginId: string): Promise<InstalledPlugin> {
    const plugin = this.requireInstalled(pluginId);
    if (plugin.status === 'disabled' || plugin.status === 'error') {
      await this.commit(plugin, { ...plugin, status: 'stopped' });
      const stats = this.stats.get(pluginId);
      if (stats) stats.consecutiveFailures = 0;
      this.emit('plugin-enabled', plugin);
    }
    return plugin;
  }

  async uninstall(pluginId: string): Promise<void> {
    this.requireInstalled(pluginId);
    for (const other of this.installed.values()) {
      if (other.manifest.id !== pluginId && pluginId in other.manifest.dependencies) {
        throw new MarketplaceError(
          'dependents-installed',
          `Cannot uninstall "${pluginId}": "${other.manifest.id}" depends on it`,
        );
      }
    }
    await this.store.deleteInstallation(pluginId);
    this.installed.delete(pluginId);
    this.stats.delete(pluginId);
    this.emit('plugin-uninstalled', { pluginId });
  }

  listInstalled(): InstalledPlugin[] {
    return [...this.installed.values()];
  }

  getInstalled(pluginId: string): InstalledPlugin | undefined {
    return this.installed.get(pluginId);
  }

  // ── Execution ────────────────────────────────────────────────────────

  async invoke(pluginId: string, input: unknown): Promise<PluginInvocationResult> {
    const started = Date.now();
    const plugin = this.installed.get(pluginId);
    if (!plugin) {
      return this.failure(pluginId, 'not-installed', `Plugin "${pluginId}" is not installed`, started);
    }
    const handler = this.implementations.get(pluginId);
    if (!handler) {
      return this.failure(
        pluginId,
        'not-implemented',
        `Plugin "${pluginId}" is installed but no implementation is registered in this build`,
        started,
      );
    }
    if (plugin.status !== 'running') {
      return this.failure(
        pluginId,
        'not-running',
        `Plugin "${pluginId}" is ${plugin.status}, not running`,
        started,
      );
    }

    const host = this.buildHostContext(plugin);
    try {
      const output = await this.withTimeout(
        Promise.resolve().then(() => handler(input, host)),
        this.invokeTimeoutMs,
        pluginId,
      );
      await this.recordOutcome(pluginId, true, null);
      return { pluginId, success: true, code: 'ok', output, durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Classify by type, never by message text: a handler controls its own
      // error strings and must not be able to choose its own failure code.
      const code: PluginInvocationCode = error instanceof PluginTimeoutError
        ? 'timeout'
        : error instanceof MarketplaceError && error.code === 'capability-denied'
          ? 'capability-denied'
          : 'handler-error';
      await this.recordOutcome(pluginId, false, message);
      return { pluginId, success: false, code, error: message, durationMs: Date.now() - started };
    }
  }

  // ── Health ───────────────────────────────────────────────────────────

  getHealth(pluginId: string): PluginHealth | null {
    const plugin = this.installed.get(pluginId);
    if (!plugin) return null;
    const stats = this.stats.get(pluginId) ?? emptyStats();
    const windowFailures = stats.recent.filter((ok) => !ok).length;
    return {
      pluginId,
      status: plugin.status,
      implementationState: plugin.implementationState,
      // Uptime counts from the last start, not install time.
      uptimeSeconds: plugin.status === 'running' && plugin.startedAt
        ? Math.round((Date.now() - plugin.startedAt) / 1000)
        : 0,
      invocations: stats.invocations,
      failures: stats.failures,
      windowedErrorRate: stats.recent.length === 0
        ? 0
        : windowFailures / stats.recent.length,
      consecutiveFailures: stats.consecutiveFailures,
      capabilityDenials: stats.capabilityDenials,
      lastError: plugin.lastError,
    };
  }

  getAllHealth(): PluginHealth[] {
    return [...this.installed.keys()]
      .map((id) => this.getHealth(id))
      .filter((health): health is PluginHealth => health !== null);
  }

  getStatus(): {
    published: number;
    installed: number;
    running: number;
    unimplemented: number;
    durable: boolean;
  } {
    const installed = this.listInstalled();
    return {
      published: this.registry.size,
      installed: installed.length,
      running: installed.filter((plugin) => plugin.status === 'running').length,
      unimplemented: installed.filter(
        (plugin) => plugin.implementationState === 'unavailable',
      ).length,
      durable: this.store.kind === 'database',
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private requireLoaded(): void {
    if (!this.loaded) {
      throw new MarketplaceError(
        'store-unavailable',
        'Marketplace state has not been loaded yet',
      );
    }
  }

  private requireInstalled(pluginId: string): InstalledPlugin {
    const plugin = this.installed.get(pluginId);
    if (!plugin) {
      throw new MarketplaceError('not-installed', `Plugin "${pluginId}" is not installed`);
    }
    return plugin;
  }

  /**
   * Persist a candidate installation state, then apply it to the live record.
   *
   * Mutating first and persisting after would leave the in-memory view ahead
   * of the database if the write failed — a plugin that looks disabled until
   * the next restart silently re-enables it.
   */
  private async commit(plugin: InstalledPlugin, next: InstalledPlugin): Promise<void> {
    await this.store.saveInstallation(next);
    Object.assign(plugin, next);
  }

  private validateManifest(manifest: PluginManifest): void {
    if (!ID_PATTERN.test(manifest.id)) {
      throw new MarketplaceError(
        'invalid-manifest',
        `Plugin id "${manifest.id}" must match ${ID_PATTERN}`,
      );
    }
    if (!parseSemver(manifest.version)) {
      throw new MarketplaceError(
        'invalid-manifest',
        `Plugin "${manifest.id}" version "${manifest.version}" is not valid semver`,
      );
    }
    for (const [depId, range] of Object.entries(manifest.dependencies)) {
      if (depId === manifest.id) {
        throw new MarketplaceError(
          'invalid-manifest',
          `Plugin "${manifest.id}" cannot depend on itself`,
        );
      }
      if (range !== '*' && !parseSemver(range.replace(/^[\^~]/, ''))) {
        throw new MarketplaceError(
          'invalid-manifest',
          `Plugin "${manifest.id}" has invalid dependency range "${range}"`,
        );
      }
    }
    for (const [key, field] of Object.entries(manifest.configSchema)) {
      if (field.type === 'select' && (!field.options || field.options.length === 0)) {
        throw new MarketplaceError(
          'invalid-manifest',
          `Config "${key}" for plugin "${manifest.id}" is a select without options`,
        );
      }
    }
  }

  /**
   * Reduce a grant set to what the manifest declares.
   *
   * At install time an undeclared grant is a caller error and is rejected. At
   * update time the grants came from an earlier approved install, so a
   * capability the new version no longer declares is dropped (fail-closed
   * narrowing) rather than rejected.
   */
  private narrowGrants(
    manifest: PluginManifest,
    requested: readonly PluginCapability[],
    options: { rejectUndeclared: boolean },
  ): PluginCapability[] {
    const declared = new Set(manifest.requiredCapabilities);
    const granted: PluginCapability[] = [];
    for (const capability of requested) {
      if (!declared.has(capability)) {
        if (options.rejectUndeclared) {
          throw new MarketplaceError(
            'capability-not-declared',
            `Capability "${capability}" is not declared by plugin "${manifest.id}"`,
          );
        }
        continue;
      }
      if (!granted.includes(capability)) granted.push(capability);
    }
    return granted;
  }

  /**
   * Validate config against the schema. Defaults apply to every field that
   * declares one; required fields without a value or default fail; values are
   * type-checked; select values must be in options; unknown keys fail. The
   * caller's object is never mutated.
   */
  private validateConfig(
    manifest: PluginManifest,
    config: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(config)) {
      if (!(key in manifest.configSchema)) {
        throw new MarketplaceError(
          'invalid-config',
          `Unknown config key "${key}" for plugin "${manifest.id}"`,
        );
      }
    }
    for (const [key, field] of Object.entries(manifest.configSchema)) {
      let value = config[key];
      if (value === undefined) {
        if (field.default !== undefined) {
          value = field.default;
        } else if (field.required) {
          throw new MarketplaceError(
            'invalid-config',
            `Missing required config "${key}" for plugin "${manifest.id}"`,
          );
        } else {
          continue;
        }
      }
      const expected = field.type === 'select' ? 'string' : field.type;
      if (typeof value !== expected) {
        throw new MarketplaceError(
          'invalid-config',
          `Config "${key}" for plugin "${manifest.id}" must be a ${expected}`,
        );
      }
      if (field.type === 'select' && field.options && !field.options.includes(value as string)) {
        throw new MarketplaceError(
          'invalid-config',
          `Config "${key}" must be one of: ${field.options.join(', ')}`,
        );
      }
      result[key] = value;
    }
    return result;
  }

  /**
   * Build the enforcing host context. Each accessor is a getter so that a
   * denial happens at the moment of reach, inside the handler's own call
   * stack, and surfaces as a thrown `capability-denied` rather than as a
   * missing property the plugin might ignore.
   */
  private buildHostContext(plugin: InstalledPlugin): PluginHostContext {
    const pluginId = plugin.manifest.id;
    const declared = new Set(plugin.manifest.requiredCapabilities);
    const granted = new Set(plugin.grantedCapabilities);
    const tagProvider = this.tagProvider;
    const alarmProvider = this.alarmProvider;

    const gate = (capability: PluginCapability): void => {
      if (!declared.has(capability)) {
        throw this.denyCapability(pluginId, capability, 'undeclared');
      }
      if (!granted.has(capability)) {
        throw this.denyCapability(pluginId, capability, 'ungranted');
      }
    };
    const requireProvider = <T>(capability: PluginCapability, provider: T | null): T => {
      gate(capability);
      if (provider === null) {
        throw new MarketplaceError(
          'invalid-state',
          `Host service for "${capability}" is not configured on this server`,
        );
      }
      return provider;
    };

    const emitEvent = (type: string, payload: Record<string, unknown>): void => {
      this.emit('plugin-event', { pluginId, type, payload });
    };
    const log = (message: string): void => {
      this.emit('plugin-log', { pluginId, message });
    };

    const host: PluginHostContext = {
      pluginId,
      config: Object.freeze({ ...plugin.config }),
      capabilities: Object.freeze([...plugin.grantedCapabilities]),
      get tags(): TagProvider {
        return requireProvider('tags:read', tagProvider);
      },
      get alarms(): AlarmProvider {
        return requireProvider('alarms:read', alarmProvider);
      },
      get emitEvent(): (type: string, payload: Record<string, unknown>) => void {
        gate('events:emit');
        return emitEvent;
      },
      get log(): (message: string) => void {
        gate('log');
        return log;
      },
    };
    return Object.freeze(host);
  }

  private denyCapability(
    pluginId: string,
    capability: PluginCapability,
    reason: CapabilityDenialRecord['reason'],
  ): MarketplaceError {
    const stats = this.stats.get(pluginId);
    if (stats) stats.capabilityDenials++;
    const record: CapabilityDenialRecord = { pluginId, capability, reason, at: Date.now() };
    this.emit('plugin-capability-denied', record);
    return new MarketplaceError(
      'capability-denied',
      `Plugin "${pluginId}" reached for capability "${capability}" that is ${reason}`,
    );
  }

  /**
   * Bound an invocation by wall clock.
   *
   * Honest limit: this races a timer on the event loop, so it bounds a handler
   * that YIELDS (async work, I/O, awaited promises). It cannot interrupt a
   * handler that blocks the event loop synchronously — a `while` loop owns the
   * thread and the timer cannot fire until it returns, so such a call is
   * reported as whatever it eventually produced. Pre-empting that needs the
   * same process/VM isolation boundary this module states it does not have.
   * It is acceptable here only because handlers are first-party code from
   * ./builtin, reviewed like the rest of the server.
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number, pluginId: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new PluginTimeoutError(pluginId, ms)),
            ms,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async recordOutcome(
    pluginId: string,
    success: boolean,
    error: string | null,
  ): Promise<void> {
    const plugin = this.installed.get(pluginId);
    const stats = this.stats.get(pluginId);
    if (!plugin || !stats) return;

    stats.invocations++;
    stats.recent.push(success);
    if (stats.recent.length > this.errorWindow) stats.recent.shift();

    if (success) {
      stats.consecutiveFailures = 0;
      return;
    }

    stats.failures++;
    stats.consecutiveFailures++;
    plugin.lastError = error;
    if (stats.consecutiveFailures >= this.autoDisableAfter && plugin.status === 'running') {
      // The auto-disable decision is authorization-adjacent, so it is durable
      // even though the counters that produced it are not.
      await this.commit(plugin, { ...plugin, status: 'error', startedAt: null });
      this.emit('plugin-auto-disabled', {
        pluginId,
        consecutiveFailures: stats.consecutiveFailures,
        lastError: error,
      });
    }
  }

  private failure(
    pluginId: string,
    code: PluginInvocationCode,
    error: string,
    startedMs: number,
  ): PluginInvocationResult {
    return { pluginId, success: false, code, error, durationMs: Date.now() - startedMs };
  }
}
