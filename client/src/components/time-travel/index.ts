/**
 * Time-Travel Debugger Components
 *
 * β.1.3 - Time-travel debugger UI
 *
 * VERITY (Versioned Evidence & Reality Integrity Through Yields)
 * Components for navigating git history, reconstructing plant states,
 * and replaying agent decisions with frozen inputs.
 *
 * See: docs/REALITY_ARTIFACT_ARCHITECTURE.md
 * See: docs/wireframes/TIME_TRAVEL_DEBUGGER.md
 */

// Types
export * from "./types";

// Components
export { CommitTimeline, DEMO_COMMITS } from "./CommitTimeline";
export { RealitySnapshot, DEMO_SNAPSHOT } from "./RealitySnapshot";
export { ArtifactInspector, DEMO_ARTIFACTS } from "./ArtifactInspector";
export { DiffViewer, DEMO_DIFF } from "./DiffViewer";
export {
  DecisionReplay,
  DEMO_DECISION,
  DEMO_REPLAY_RESULT,
  DEMO_REPLAY_RESULT_DIVERGED,
} from "./DecisionReplay";

// Main container component
export { TimeTravelDebugger } from "./TimeTravelDebugger";
export type { TimeTravelDebuggerProps } from "./TimeTravelDebugger";
