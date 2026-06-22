/**
 * Bridge Modules Index
 * 
 * Exports all bridge modules for integration into the main application.
 * Bridges connect different parts of the system and handle cross-cutting concerns.
 * 
 * Issue: #280 — Bridge modules integration
 */

export { eventAnchorBridge, type AnchorableEvent, type AnchorBatch, type EventAnchorConfig } from './event-anchor';
export { stateSyncBridge, type StateChange, type SyncTarget, type StateSyncConfig } from './state-sync';
// Anchor-Backend Switch dispatch (#455)
export {
  anchorRouter,
  AnchorRouter,
  projectSwitch,
  backendsFor,
  parseBackendEnv,
  DEFAULT_BACKEND_PROFILES,
  type AnchorBackend,
  type BackendProfile,
  type ProjectionInput,
  type SwitchProjection,
  type BackendRouting,
  type RoutableEvent,
  type DispatchResult,
} from './anchor-router';

import { eventAnchorBridge } from './event-anchor';
import { stateSyncBridge } from './state-sync';

/**
 * Initialize all bridge modules
 */
export async function initializeBridges(): Promise<void> {
  await eventAnchorBridge.initialize();
  await stateSyncBridge.initialize();
}

/**
 * Get health status for all bridge modules
 */
export async function getBridgeHealthStatus(): Promise<{
  eventAnchor: { healthy: boolean; message: string };
  stateSync: { healthy: boolean; message: string };
}> {
  const [eventAnchorHealth, stateSyncHealth] = await Promise.all([
    eventAnchorBridge.healthCheck(),
    stateSyncBridge.healthCheck()
  ]);

  return {
    eventAnchor: eventAnchorHealth,
    stateSync: stateSyncHealth
  };
}

/**
 * Shutdown all bridge modules gracefully
 */
export async function shutdownBridges(): Promise<void> {
  await Promise.all([
    eventAnchorBridge.removeAllListeners(),
    stateSyncBridge.shutdown()
  ]);
}