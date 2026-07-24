/**
 * Deterministic Blueprint Runtime — public surface.
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *
 * This barrel is the single import point for the rest of the server (and for the
 * 2b watchdog, #3, which gates on this module). Consumers should import from
 * `server/blueprint` rather than reaching into individual files, so the internal
 * SoA layout can evolve without churning call sites.
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

export { makeControlFarmBlueprint, makeInputVector } from "./fixtures.js";
