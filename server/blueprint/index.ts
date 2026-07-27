/**
 * Deterministic Blueprint Runtime + Watchdog / Safe-State — public surface.
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 * Issue #459: [wave:2b] Watchdog & Safe-State Fallback
 *
 * This barrel is the single import point for the rest of the server. Consumers
 * should import from `server/blueprint` rather than reaching into individual
 * files, so the internal SoA layout can evolve without churning call sites.
 *
 * Safe-state pieces:
 * - {@link Watchdog}                : per-blueprint tick-budget monitor + trip logic.
 * - {@link SafeStateController}     : applies / clears the declared safe state,
 *                                     anchors CRITICAL transitions, audits them.
 * - {@link WatchdogRegistry}        : tracks one watchdog per running blueprint and
 *                                     exposes status for the operator UI.
 * - {@link BlueprintRuntimeActuator}: the real {@link SafeStateActuator} used in
 *                                     production; drives the runtime tag store.
 * - {@link BlueprintSafetyHost}     : composition root that constructs runtimes,
 *                                     registers watchdogs and drives ticks.
 */

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
