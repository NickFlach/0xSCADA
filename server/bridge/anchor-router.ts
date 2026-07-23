/**
 * Backward-compatible import surface for the #455 anchor switch.
 *
 * Runtime routing now lives in `anchor-switch.ts` and `bridge/index.ts`; this
 * module intentionally contains no simulated transport.
 */

export {
  anchorSwitch as anchorRouter,
  AnchorSwitch as AnchorRouter,
  anchorSwitch,
  AnchorSwitch,
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
} from "./anchor-switch";
