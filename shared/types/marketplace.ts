/**
 * Agent Marketplace & Plugin System — shared types
 *
 * Feature [13.6] of ADR-0013 (docs/decisions/ADR-0013-autonomous-agent-architecture.md).
 * Issue #217. Design notes: docs/architecture/agent-marketplace.md.
 *
 * ── What this system is ──────────────────────────────────────────────────
 * A registry of plugin *manifests* (metadata: id, version, declared
 * capabilities, config schema, dependencies) plus an install/grant/lifecycle
 * record for each plugin an operator has explicitly installed.
 *
 * ── What this system is NOT ─────────────────────────────────────────────
 * It is NOT a code-distribution channel and it is NOT a security sandbox.
 *
 *  - No plugin code is ever uploaded, downloaded, or dynamically loaded. A
 *    published manifest can never become executable on its own. Executable
 *    handlers come only from first-party modules compiled into this server
 *    and registered through `registerImplementation` at startup
 *    (server/services/marketplace/builtin/). An installed plugin with no
 *    such handler reports `implementationState: "unavailable"` and refuses
 *    to start — it is not silently broken.
 *  - Handlers therefore run in-process, in the server's own isolate. Node
 *    in-process execution is NOT a security boundary against hostile code:
 *    a malicious handler could reach `process`, `require`, the filesystem,
 *    or the event loop regardless of its granted capabilities. The
 *    capability system constrains a *cooperative* plugin's access to host
 *    services at the host-context boundary; it does not contain hostile
 *    code. Containing untrusted code would require process/VM isolation
 *    (worker threads with a restricted module graph, a child process, or a
 *    separate container), which this repository does not implement.
 *  - Accordingly, the trust model is: only trusted, first-party,
 *    explicitly-installed plugins execute. Third-party code execution is
 *    out of scope until an isolation boundary exists.
 *
 * No money, tokens, licences, or signatures move through this system. There
 * is no payment path, no plugin signing, and no signature verification.
 */

export type PluginCategory =
  | 'intelligence'
  | 'integration'
  | 'reporting'
  | 'safety'
  | 'optimization'
  | 'custom';

/**
 * Host services a plugin may be granted.
 *
 * A capability must be BOTH declared in the manifest AND granted at install
 * time. Reaching for anything else through the host context throws
 * `capability-denied` and emits an audit event — it never silently proceeds.
 */
export type PluginCapability =
  | 'tags:read'
  | 'alarms:read'
  | 'events:emit'
  | 'log';

export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.freeze([
  'tags:read',
  'alarms:read',
  'events:emit',
  'log',
]);

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select';
  description: string;
  default?: string | number | boolean;
  required: boolean;
  options?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Free-text attribution shown in listings. NOT an identity or authorization claim. */
  author: string;
  category: PluginCategory;
  /** Capabilities the plugin needs; installation grants a subset of these. */
  requiredCapabilities: PluginCapability[];
  configSchema: Record<string, PluginConfigField>;
  /** pluginId → semver range (`^`, `~`, exact, or `*`) — enforced at install. */
  dependencies: Record<string, string>;
  tags: string[];
}

/**
 * A registry record. `publisher` is the ownership record: it is the
 * authenticated control-plane principal that FIRST published this plugin id,
 * captured server-side. Only that principal (or an admin key) may publish a
 * later version of the id. It is never read from a request body.
 */
export interface MarketplaceEntry {
  manifest: PluginManifest;
  publisher: string;
  publishedAt: number;
  updatedAt: number;
  installs: number;
}

export type PluginStatus = 'installed' | 'running' | 'stopped' | 'disabled' | 'error';

/**
 * Whether an executable handler is registered for this plugin id.
 *
 *  - `available`   — a first-party implementation is compiled in and registered.
 *  - `unavailable` — the manifest is installed but nothing can execute it.
 *                    This is an expected, reportable state, not an error.
 */
export type PluginImplementationState = 'available' | 'unavailable';

export interface InstalledPlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  config: Record<string, string | number | boolean>;
  grantedCapabilities: PluginCapability[];
  /** Authenticated principal that installed it — captured server-side. */
  installedBy: string;
  installedAt: number;
  startedAt: number | null;
  lastError: string | null;
  implementationState: PluginImplementationState;
}

export interface PluginHealth {
  pluginId: string;
  status: PluginStatus;
  implementationState: PluginImplementationState;
  /** Seconds since the last start; 0 when not running. */
  uptimeSeconds: number;
  invocations: number;
  failures: number;
  /** Failure fraction over the recent invocation window. */
  windowedErrorRate: number;
  consecutiveFailures: number;
  capabilityDenials: number;
  lastError: string | null;
}

/**
 * Machine-readable outcome codes so callers never have to parse a message.
 */
export type PluginInvocationCode =
  | 'ok'
  | 'not-installed'
  | 'not-running'
  | 'not-implemented'
  | 'timeout'
  | 'capability-denied'
  | 'handler-error';

export interface PluginInvocationResult {
  pluginId: string;
  success: boolean;
  code: PluginInvocationCode;
  output?: unknown;
  error?: string;
  durationMs: number;
}

/** Audit record emitted whenever a plugin reaches for a capability it lacks. */
export interface CapabilityDenialRecord {
  pluginId: string;
  capability: PluginCapability;
  /** `undeclared` — not in the manifest at all; `ungranted` — declared but not granted at install. */
  reason: 'undeclared' | 'ungranted';
  at: number;
}
