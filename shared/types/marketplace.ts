/**
 * Agent Marketplace & Plugin System Types
 * ADR-0013 [13.6] — Issue #217
 *
 * Registry for agent plugins with install/configure/enable-disable
 * lifecycle, real semver versioning, health monitoring, and
 * capability-scoped execution.
 *
 * Isolation model (stated honestly per the repo integrity rule): plugin
 * handlers run in-process through a PluginExecutionContext that exposes
 * ONLY the host APIs matching the plugin's granted capabilities, with a
 * wall-clock timeout and windowed error tracking that auto-disables
 * failing plugins. This is capability scoping and fault containment —
 * not memory isolation. Arbitrary untrusted code would additionally need
 * worker/child-process isolation, which this codebase's build pipeline
 * does not currently support (noEmit + tsx dev runtime). ADR-0008
 * capability tokens are being built separately; the grant model here is
 * designed to plug into them.
 */

export type PluginCategory =
  | 'intelligence'
  | 'integration'
  | 'reporting'
  | 'safety'
  | 'optimization'
  | 'custom';

/** Capabilities a plugin may be granted — enforced by the host API surface */
export type PluginCapability =
  | 'tags:read'
  | 'alarms:read'
  | 'events:emit'
  | 'log';

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
  author: string;
  category: PluginCategory;
  /** Capabilities the plugin needs; installation grants ⊆ these */
  requiredCapabilities: PluginCapability[];
  configSchema: Record<string, PluginConfigField>;
  /** pluginId → semver range (^, ~, exact, or *) — actually enforced */
  dependencies: Record<string, string>;
  tags: string[];
}

export interface MarketplaceEntry {
  manifest: PluginManifest;
  publishedAt: number;
  updatedAt: number;
  installs: number;
}

export type PluginStatus = 'installed' | 'running' | 'stopped' | 'disabled' | 'error';

export interface InstalledPlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  config: Record<string, string | number | boolean>;
  grantedCapabilities: PluginCapability[];
  installedAt: number;
  startedAt: number | null;
  lastError: string | null;
}

export interface PluginHealth {
  pluginId: string;
  status: PluginStatus;
  /** Seconds since last start; 0 when not running */
  uptimeSeconds: number;
  invocations: number;
  failures: number;
  /** Failure fraction over the recent invocation window */
  windowedErrorRate: number;
  consecutiveFailures: number;
  lastError: string | null;
  hasImplementation: boolean;
}

export interface PluginInvocationResult {
  pluginId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}
