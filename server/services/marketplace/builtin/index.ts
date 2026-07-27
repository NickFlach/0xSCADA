/**
 * First-party plugin implementations.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 *
 * This module is the ONLY production source of executable plugin handlers.
 * `MarketplaceService.initialize()` publishes each manifest below under the
 * reserved `system:builtin` publisher and calls `registerImplementation` for
 * it, so an operator can install and invoke it end to end.
 *
 * A manifest published over HTTP by anyone else never gains an entry here and
 * therefore can never execute: it installs, reports
 * `implementationState: "unavailable"`, and refuses to start. That is the
 * containment story — the marketplace does not transport code, so there is no
 * untrusted code to sandbox. Adding a plugin means adding it here, in a
 * reviewed commit, and shipping a new build.
 */

import type { PluginManifest } from '@shared/types/marketplace';
import type { PluginHandler } from '../engine';
import {
  TAG_THRESHOLD_MONITOR_ID,
  tagThresholdMonitorHandler,
  tagThresholdMonitorManifest,
} from './tag-threshold-monitor';

export interface BuiltinPlugin {
  manifest: PluginManifest;
  handler: PluginHandler;
}

export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = Object.freeze([
  Object.freeze({
    manifest: tagThresholdMonitorManifest,
    handler: tagThresholdMonitorHandler,
  }),
]);

export { TAG_THRESHOLD_MONITOR_ID, tagThresholdMonitorManifest, tagThresholdMonitorHandler };
export type { ThresholdEvaluation, ThresholdState } from './tag-threshold-monitor';
