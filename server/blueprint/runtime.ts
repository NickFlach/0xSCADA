/**
 * Deterministic Blueprint Runtime — Hot Loop
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *   Target: bounded-allocation tick under 1ms p99 for a 1000-tag blueprint.
 *
 * DESIGN INVARIANTS (the whole point of this file):
 *   1. ALL memory is allocated at `load()` time. `tick()` allocates NOTHING —
 *      no closures, no arrays, no objects, no string concat, no Map access.
 *   2. NO `await` / Promise / microtask in the critical path. `tick()` is fully
 *      synchronous so it cannot be preempted by the event loop mid-scan.
 *   3. Tag access in the loop is by integer index into a single `Float64Array`,
 *      never by name. Name resolution happened in the compiler.
 *   4. Dispatch is a single `switch` on a `Uint8Array` opcode — V8 lowers a
 *      dense switch to a jump table.
 *
 * The runtime owns three pre-allocated buffers:
 *   - tagBuffer   : Float64Array(tagCount)   — current value of every tag
 *   - stateBuffer : Float64Array(stateCount) — feedback/timer state across ticks
 *   - (operand decode uses the program's typed arrays directly; no scratch buffer
 *      is needed because every op reads <= OPERAND_STRIDE operands into locals.)
 */

import {
  type CompiledBlueprint,
  type TagDescriptor,
  OpCode,
  OPERAND_STRIDE,
} from "./types.js";

/** Result of a single tick: timing only (values are read via getters to avoid allocation). */
export interface TickResult {
  /** Wall-clock duration of the tick in milliseconds (fractional). */
  durationMs: number;
  /** Monotonic tick counter since load. */
  tickNumber: number;
}

export class BlueprintRuntime {
  private readonly program: CompiledBlueprint;

  // ── Pre-allocated buffers (allocated once, in the constructor) ──
  private readonly tagBuffer: Float64Array;
  private readonly stateBuffer: Float64Array;

  // ── Pre-hoisted references to the program's typed arrays ──
  // Hoisting to instance fields lets the JIT treat them as monomorphic and
  // avoids a property chain (`this.program.opcodes`) on every instruction.
  private readonly opcodes: Uint8Array;
  private readonly destIndices: Int32Array;
  private readonly immediates: Float64Array;
  private readonly operandTagIndices: Int32Array;
  private readonly operandConsts: Float64Array;
  private readonly stateIndices: Int32Array;
  private readonly instructionCount: number;
  private readonly scanPeriodSeconds: number;

  private tickNumber = 0;

  /**
   * Load a compiled blueprint and pre-allocate all runtime buffers.
   * This is the ONLY place allocation happens (plus get/set helpers below).
   */
  constructor(program: CompiledBlueprint) {
    this.program = program;
    this.tagBuffer = new Float64Array(program.tagCount);
    this.tagBuffer.set(program.initialValues);
    this.stateBuffer = new Float64Array(program.stateCount);

    this.opcodes = program.opcodes;
    this.destIndices = program.destIndices;
    this.immediates = program.immediates;
    this.operandTagIndices = program.operandTagIndices;
    this.operandConsts = program.operandConsts;
    this.stateIndices = program.stateIndices;
    this.instructionCount = program.instructionCount;
    this.scanPeriodSeconds = program.scanPeriodMs / 1000;
  }

  // ─── Hot loop ───────────────────────────────────────────────────────────────

  /**
   * Execute one scan over the entire instruction stream.
   *
   * ZERO allocations in this method body. The only objects created are the
   * returned `TickResult` literal — callers that run at very high rates and do
   * not need timing should use {@link tickFast} which returns nothing.
   */
  tick(): TickResult {
    const start = performance.now();
    this.tickFast();
    const durationMs = performance.now() - start;
    return { durationMs, tickNumber: this.tickNumber };
  }

  /**
   * The genuinely allocation-free scan. Returns nothing so the steady-state hot
   * path can avoid even the result-object literal.
   */
  tickFast(): void {
    // Hoist everything into locals so the loop touches no `this` after entry.
    const tags = this.tagBuffer;
    const state = this.stateBuffer;
    const opcodes = this.opcodes;
    const dest = this.destIndices;
    const imm = this.immediates;
    const opTag = this.operandTagIndices;
    const opConst = this.operandConsts;
    const stateIdx = this.stateIndices;
    const n = this.instructionCount;
    const dt = this.scanPeriodSeconds;

    for (let i = 0; i < n; i++) {
      const base = i * OPERAND_STRIDE;

      // Decode up to OPERAND_STRIDE operands. `index === -1` means "immediate".
      const i0 = opTag[base];
      const a = i0 >= 0 ? tags[i0] : opConst[base];
      const i1 = opTag[base + 1];
      const b = i1 >= 0 ? tags[i1] : opConst[base + 1];
      const i2 = opTag[base + 2];
      const c = i2 >= 0 ? tags[i2] : opConst[base + 2];

      const d = dest[i];
      let out: number;

      switch (opcodes[i]) {
        // ── Boolean (treat any non-zero as true; emit 0.0/1.0) ──
        case OpCode.AND:
          out = a !== 0 && b !== 0 ? 1 : 0;
          break;
        case OpCode.OR:
          out = a !== 0 || b !== 0 ? 1 : 0;
          break;
        case OpCode.NOT:
          out = a !== 0 ? 0 : 1;
          break;
        case OpCode.XOR:
          out = (a !== 0) !== (b !== 0) ? 1 : 0;
          break;
        // ── Comparison ──
        case OpCode.GT:
          out = a > b ? 1 : 0;
          break;
        case OpCode.GTE:
          out = a >= b ? 1 : 0;
          break;
        case OpCode.LT:
          out = a < b ? 1 : 0;
          break;
        case OpCode.LTE:
          out = a <= b ? 1 : 0;
          break;
        case OpCode.EQ:
          out = a === b ? 1 : 0;
          break;
        case OpCode.NEQ:
          out = a !== b ? 1 : 0;
          break;
        // ── Arithmetic ──
        case OpCode.ADD:
          out = a + b;
          break;
        case OpCode.SUB:
          out = a - b;
          break;
        case OpCode.MUL:
          out = a * b;
          break;
        case OpCode.DIV:
          out = b !== 0 ? a / b : 0; // deterministic: div-by-zero -> 0, never NaN/Inf
          break;
        case OpCode.MIN:
          out = a < b ? a : b;
          break;
        case OpCode.MAX:
          out = a > b ? a : b;
          break;
        // ── Selection / movement ──
        case OpCode.SELECT:
          out = a !== 0 ? b : c;
          break;
        case OpCode.MOVE:
          out = a;
          break;
        case OpCode.CONST:
          out = imm[i];
          break;
        // ── Stateful ──
        case OpCode.LATCH: {
          // SR latch with set-dominant behaviour. State holds the latched value.
          const s = stateIdx[i];
          let q = state[s];
          if (b !== 0) q = 0; // reset
          if (a !== 0) q = 1; // set dominates
          state[s] = q;
          out = q;
          break;
        }
        case OpCode.TON: {
          // On-delay timer. `a` = enable, `imm[i]` = preset seconds.
          // State holds elapsed seconds. Output is the "done" bit (0/1).
          const s = stateIdx[i];
          let elapsed = state[s];
          if (a !== 0) {
            elapsed += dt;
            const preset = imm[i];
            if (elapsed >= preset) {
              elapsed = preset;
              out = 1;
            } else {
              out = 0;
            }
          } else {
            elapsed = 0;
            out = 0;
          }
          state[s] = elapsed;
          break;
        }
        default:
          // Unreachable for a validly-compiled program; keep deterministic.
          out = 0;
          break;
      }

      tags[d] = out;
    }

    this.tickNumber++;
  }

  // ─── IO marshalling (called OUTSIDE the tick) ─────────────────────────────────

  /**
   * Bulk-write input tags from a same-length Float64Array of input values, in
   * the order of `program.inputSlots`. Allocation-free.
   */
  writeInputs(values: Float64Array): void {
    const slots = this.program.inputSlots;
    const n = slots.length;
    if (values.length !== n) {
      throw new RangeError(`expected ${n} input values, got ${values.length}`);
    }
    const tags = this.tagBuffer;
    for (let i = 0; i < n; i++) tags[slots[i]] = values[i];
  }

  /**
   * Bulk-read output tags into the provided same-length Float64Array, in the
   * order of `program.outputSlots`. Allocation-free (caller supplies the buffer).
   */
  readOutputs(out: Float64Array): void {
    const slots = this.program.outputSlots;
    const n = slots.length;
    if (out.length !== n) {
      throw new RangeError(`expected ${n} output slots, got ${out.length}`);
    }
    const tags = this.tagBuffer;
    for (let i = 0; i < n; i++) out[i] = tags[slots[i]];
  }

  // ─── Single-tag accessors (diagnostics / tests; NOT for the hot path) ──────────

  /** Read a tag by name. Uses the Map — do not call inside the tick. */
  get(name: string): number {
    const slot = this.program.tagIndex.get(name);
    if (slot === undefined) throw new RangeError(`unknown tag "${name}"`);
    return this.tagBuffer[slot];
  }

  /** Write a tag by name. Uses the Map — do not call inside the tick. */
  set(name: string, value: number): void {
    const slot = this.program.tagIndex.get(name);
    if (slot === undefined) throw new RangeError(`unknown tag "${name}"`);
    this.tagBuffer[slot] = value;
  }

  /** Reset tag + state buffers to load-time initial values. */
  reset(): void {
    this.tagBuffer.set(this.program.initialValues);
    this.stateBuffer.fill(0);
    this.tickNumber = 0;
  }

  // ─── Introspection ────────────────────────────────────────────────────────────

  get tagCount(): number {
    return this.program.tagCount;
  }
  get inputCount(): number {
    return this.program.inputSlots.length;
  }
  get outputCount(): number {
    return this.program.outputSlots.length;
  }
  get ticks(): number {
    return this.tickNumber;
  }
  get tagMeta(): readonly TagDescriptor[] {
    return this.program.tagMeta;
  }
}
