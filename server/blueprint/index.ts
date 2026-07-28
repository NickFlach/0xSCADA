/**
 * Blueprint control-plane module — public surface.
 *
 * Three concerns live behind this barrel:
 *
 *  - **Deterministic execution (#457)** — the compiler, the SoA program layout,
 *    {@link BlueprintRuntime} (whose `tickFast()` is the bounded-allocation hot
 *    loop), the `.strict()` definition schema and the gated production host
 *    {@link BlueprintControlLoop}.
 *  - **Watchdog & safe-state (#459)** — {@link Watchdog} (per-blueprint
 *    tick-budget monitor + trip logic), {@link SafeStateController} (applies /
 *    clears the declared safe state, anchors CRITICAL transitions, audits them),
 *    {@link WatchdogRegistry} (one watchdog per running blueprint, status for the
 *    operator UI), {@link BlueprintRuntimeActuator} (the real
 *    {@link SafeStateActuator} used in production; drives the runtime tag store)
 *    and {@link BlueprintSafetyHost} (composition root that constructs runtimes,
 *    registers watchdogs and drives ticks).
 *  - **Tick-aware scheduling & telemetry (#458)** — PREEMPT_RT detection with
 *    graceful fallback ({@link TickScheduler}), the fixed-period
 *    {@link BlueprintTickLoop} that measures jitter / deadline misses / WCET,
 *    and the `/health` adapter that reports the real scheduling mode.
 *
 * Consumers should import from `server/blueprint` rather than reaching into
 * individual files, so the internal layout can evolve without churning call
 * sites.
 *
 * IMPORTING THIS MODULE HAS NO SIDE EFFECTS. In particular it never probes the
 * kernel and never applies a real-time scheduling policy — see
 * `./scheduler.ts` for why that matters.
 *
 * @module server/blueprint
 */

// ── Deterministic runtime (#457) ─────────────────────────────────────────────

export {
  type TagDirection,
  type TagDescriptor,
  type BlueprintOp,
  type BlueprintNode,
  type BlueprintOperand,
  type BlueprintDefinition,
  type CompiledBlueprint,
  OpCode,
  OP_TO_OPCODE,
  OPERAND_STRIDE,
  isTagOperand,
} from "./types.js";

export { compileBlueprint, BlueprintCompileError } from "./compiler.js";

export { BlueprintRuntime, type TickResult } from "./runtime.js";

export {
  BlueprintDefinitionSchema,
  BlueprintDefinitionError,
  parseBlueprintDefinition,
  type BlueprintDefinitionLimits,
} from "./definition-schema.js";

export {
  BlueprintControlLoop,
  BlueprintControlLoopError,
  BlueprintControlLoopConfigSchema,
  describeBlueprintControlLoopHealth,
  getBlueprintControlLoop,
  loadBlueprintControlLoopConfig,
  startBlueprintControlLoop,
  type BlueprintControlLoopConfig,
  type BlueprintControlLoopHealth,
  type BlueprintControlLoopState,
  type BlueprintControlLoopStatus,
} from "./control-loop.js";

export { makeControlFarmBlueprint, makeInputVector } from "./fixtures.js";

export * from "./safe-state";
export * from "./watchdog";
export { WatchdogRegistry } from "./registry";
export {
  BridgeAnchorBackend,
  StorageSafeStateAuditSink,
} from "./safe-state-adapters";
export {
  BlueprintRuntimeActuator,
  OUTPUT_WRITE_OPT_IN_ENV,
  outputWritesEnabled,
  type ActuatorCapabilities,
  type ActuatorOutputMode,
  type FieldOutputSink,
  type BlueprintRuntimeActuatorOptions,
} from "./runtime-actuator";
export {
  BlueprintSafetyHost,
  blueprintSafetyHost,
  safeStateRegistry,
  blueprintSafetyBindingSchema,
  blueprintSafetyBindingsSchema,
  SAFETY_BINDINGS_ENV,
  SAFETY_BINDINGS_FILE_ENV,
  type BlueprintSafetyBinding,
  type BlueprintSafetyHostStatus,
} from "./safety-host";
export {
  getBlueprintProductionSafetyStatus,
  type BlueprintProductionSafetyStatus,
} from "./production-safety";

// ── Tick-aware scheduler (#458) ──────────────────────────────────────────────

export {
  TickScheduler,
  detectRtCapability,
  normalizeConfig,
  configFromEnv,
  getScheduler,
  applyScheduler,
  createDefaultHostProbe,
  chrtSyscall,
  DEFAULT_PRIORITY,
  MIN_PRIORITY,
  MAX_PRIORITY,
  DEFAULT_SCHEDULER_CONFIG,
  ENV_RT_ENABLED,
  ENV_RT_PRIORITY,
  ENV_RT_POLICY,
  PREEMPTION_SYSFS,
  type SchedulingMode,
  type SchedPolicy,
  type SchedulerConfig,
  type SchedulerEnvConfig,
  type SchedulerStatus,
  type SchedulerHealthSummary,
  type DedicatedSchedulerTarget,
  type RtCapability,
  type HostProbe,
  type RtSyscall,
} from "./scheduler.js";

export {
  BlueprintTickLoop,
  type TickFn,
  type TickLoopOptions,
  type TickLoopHealth,
} from "./tick-loop.js";

export { createSchedulerCheck } from "./health.js";

// ── Tick telemetry (#458) ────────────────────────────────────────────────────

export {
  exposeBlueprintMetrics,
  resetBlueprintMetrics,
  TickAccountant,
  publishTickStats,
  type TickStats,
  type TickSample,
  type TickAccountantOptions,
} from "../metrics/blueprint.js";
