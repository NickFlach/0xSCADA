/**
 * Deterministic Blueprint Runtime — Core Types
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *   "bounded-allocation tick under 1ms p99"
 *
 * A *blueprint* here is the runtime (execution-time) form of an ISA-88 control
 * module / ladder-logic body. It is a directed acyclic graph of logic operations
 * over a flat tag space. At load time it is compiled (see ./compiler.ts) into a
 * flat, branch-light instruction stream plus a tag-index table so the hot loop
 * (see ./runtime.ts) can run with ZERO allocations and NO dynamic Map/Object
 * lookups.
 *
 * NOTE: This is distinct from the *design-time* code-generation engine that
 * lives in server/blueprints/ (plural). That engine emits vendor PLC code; this
 * one executes control logic deterministically in-process.
 */

// ─── Tag space ──────────────────────────────────────────────────────────────

/**
 * Direction of a tag relative to the runtime.
 *  - `input`   : written by the field/IO layer before each tick, read-only inside the tick.
 *  - `output`  : computed by the runtime, published to the field/IO layer after the tick.
 *  - `internal`: scratch/state tag that lives only inside the runtime (latches, timers, …).
 */
export type TagDirection = "input" | "output" | "internal";

/**
 * Declared shape of a single tag in a blueprint. All tag values are stored as
 * `float64` in the runtime buffer; booleans are represented as 0.0 / 1.0. This
 * keeps the hot buffer a single homogeneous `Float64Array` (one cache-friendly
 * allocation) rather than a tagged union.
 */
export interface TagDescriptor {
  /** Stable, human-readable name, unique within the blueprint (e.g. "PUMP_01.RUN"). */
  readonly name: string;
  readonly direction: TagDirection;
  /** Logical type — informational; runtime always stores float64. */
  readonly dataType: "bool" | "int" | "float";
  /** Initial value applied at load time (defaults to 0). */
  readonly initial?: number;
}

// ─── Logic operations (authoring form) ───────────────────────────────────────

/**
 * The set of primitive operations a blueprint node can perform. Deliberately
 * small and fixed so the compiler can map each to a dense numeric opcode and the
 * runtime can branch on it via a `switch` (which V8 lowers to a jump table).
 */
export type BlueprintOp =
  // Boolean logic
  | "AND"
  | "OR"
  | "NOT"
  | "XOR"
  // Comparison (output is 0.0 / 1.0)
  | "GT"
  | "GTE"
  | "LT"
  | "LTE"
  | "EQ"
  | "NEQ"
  // Arithmetic
  | "ADD"
  | "SUB"
  | "MUL"
  | "DIV"
  | "MIN"
  | "MAX"
  // Selection / movement
  | "SELECT" // SELECT(cond, a, b) -> cond != 0 ? a : b
  | "MOVE" // copy operand[0] -> destination
  | "CONST" // emit an immediate value
  // Stateful
  | "LATCH" // SR latch: LATCH(set, reset) with feedback on destination
  | "TON"; // on-delay timer: TON(enable, presetSeconds) -> done bit

/**
 * A single logic node in the authoring (un-compiled) blueprint. Each node reads
 * from named tags (or constants) and writes its result to exactly one tag.
 */
export interface BlueprintNode {
  /** Stable id, unique within the blueprint. Used for topo-sort & diagnostics. */
  readonly id: string;
  readonly op: BlueprintOp;
  /**
   * Input operands. Each is either a tag reference (`{ tag: "..." }`) or an
   * immediate constant (`{ const: 1.5 }`). Operand count is validated per-op by
   * the compiler.
   */
  readonly inputs: readonly BlueprintOperand[];
  /** Name of the tag this node writes its result into. */
  readonly output: string;
  /** For CONST/TON: the immediate parameter (CONST value, or TON preset seconds). */
  readonly param?: number;
}

export type BlueprintOperand = { readonly tag: string } | { readonly const: number };

export function isTagOperand(o: BlueprintOperand): o is { readonly tag: string } {
  return (o as { tag?: string }).tag !== undefined;
}

/** A complete authoring-form blueprint. */
export interface BlueprintDefinition {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly TagDescriptor[];
  readonly nodes: readonly BlueprintNode[];
  /** Nominal scan period in milliseconds (used by stateful ops like TON). */
  readonly scanPeriodMs?: number;
}

// ─── Compiled (runtime) form ──────────────────────────────────────────────────

/**
 * Dense numeric opcode. Order is the contract between compiler and runtime; the
 * runtime switch dispatches on these. Do NOT reorder without updating both.
 */
export enum OpCode {
  AND = 0,
  OR = 1,
  NOT = 2,
  XOR = 3,
  GT = 4,
  GTE = 5,
  LT = 6,
  LTE = 7,
  EQ = 8,
  NEQ = 9,
  ADD = 10,
  SUB = 11,
  MUL = 12,
  DIV = 13,
  MIN = 14,
  MAX = 15,
  SELECT = 16,
  MOVE = 17,
  CONST = 18,
  LATCH = 19,
  TON = 20,
}

export const OP_TO_OPCODE: Readonly<Record<BlueprintOp, OpCode>> = {
  AND: OpCode.AND,
  OR: OpCode.OR,
  NOT: OpCode.NOT,
  XOR: OpCode.XOR,
  GT: OpCode.GT,
  GTE: OpCode.GTE,
  LT: OpCode.LT,
  LTE: OpCode.LTE,
  EQ: OpCode.EQ,
  NEQ: OpCode.NEQ,
  ADD: OpCode.ADD,
  SUB: OpCode.SUB,
  MUL: OpCode.MUL,
  DIV: OpCode.DIV,
  MIN: OpCode.MIN,
  MAX: OpCode.MAX,
  SELECT: OpCode.SELECT,
  MOVE: OpCode.MOVE,
  CONST: OpCode.CONST,
  LATCH: OpCode.LATCH,
  TON: OpCode.TON,
};

/**
 * Number of operand slots each instruction reserves in the flat operand table.
 * Using a FIXED stride (rather than variable-length encoding) keeps decoding
 * branch-free: instruction `i` always reads operands at `i * OPERAND_STRIDE`.
 * The widest op (SELECT) needs 3 operands.
 */
export const OPERAND_STRIDE = 3;

/**
 * Compiled program: a Structure-of-Arrays layout designed for the hot loop.
 *
 * Everything below is allocated ONCE at compile time. The runtime never grows
 * or reshapes these; it only reads them. The only mutable per-tick state is the
 * separately-allocated tag buffer + state buffer owned by the runtime.
 *
 * For instruction `i` (0 <= i < instructionCount):
 *   - opcode      = opcodes[i]
 *   - destIndex   = destIndices[i]            (tag-buffer slot to write)
 *   - immediate   = immediates[i]             (CONST value / TON preset, else 0)
 *   - operand k   = operandTagIndices[i*STRIDE + k]  (tag-buffer slot, or -1 if immediate)
 *                   operandConsts[i*STRIDE + k]       (immediate value when index === -1)
 *   - stateIndex  = stateIndices[i]           (slot in the state buffer, or -1 if stateless)
 */
export interface CompiledBlueprint {
  readonly id: string;
  readonly name: string;
  readonly scanPeriodMs: number;

  /** Total number of tag slots (size of the runtime tag buffer). */
  readonly tagCount: number;
  /** Number of compiled instructions. */
  readonly instructionCount: number;
  /** Number of state slots required (size of the runtime state buffer). */
  readonly stateCount: number;

  // ── Instruction stream (SoA) ──
  readonly opcodes: Uint8Array;
  readonly destIndices: Int32Array;
  readonly immediates: Float64Array;
  readonly operandTagIndices: Int32Array; // length = instructionCount * OPERAND_STRIDE
  readonly operandConsts: Float64Array; // length = instructionCount * OPERAND_STRIDE
  readonly stateIndices: Int32Array;

  // ── Tag-index table ──
  /** name -> tag-buffer slot. Used only OUTSIDE the tick (load/get/set). */
  readonly tagIndex: ReadonlyMap<string, number>;
  /** Initial values for the tag buffer, applied at runtime load. */
  readonly initialValues: Float64Array;
  /** Tag metadata, parallel to buffer slots (slot i describes tag i). */
  readonly tagMeta: readonly TagDescriptor[];
  /** Slots that are inputs (written by IO before tick) — precomputed for fast IO marshalling. */
  readonly inputSlots: Int32Array;
  /** Slots that are outputs (read by IO after tick). */
  readonly outputSlots: Int32Array;
}
