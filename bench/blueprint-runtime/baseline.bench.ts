/**
 * BASELINE benchmark — Issue #457 (Deterministic Blueprint Runtime).
 *
 * This is the "before" picture: a deliberately naive interpreter that executes
 * the SAME blueprint semantics as the locked runtime, but with the anti-patterns
 * the issue exists to eliminate:
 *
 *   - tag store is a `Map<string, number>` keyed by NAME (dynamic hash lookups
 *     in the hot path);
 *   - each node's operands are read into a freshly-allocated array per tick
 *     (per-tick allocation -> GC pressure);
 *   - dispatch is on the string opcode (megamorphic, no jump table);
 *   - results are returned in a freshly-allocated object map per tick.
 *
 * It is NOT dead code: running it produces the contrast numbers cited in the
 * gate-decision note (docs/decisions/ADR-0026-...). Keeping it lets CI / future
 * maintainers re-measure the gap on any hardware.
 *
 * The baseline interpreter intentionally re-implements logic rather than calling
 * the production runtime, so the two files measure genuinely different machines.
 */

import {
  type BlueprintDefinition,
  type BlueprintNode,
  isTagOperand,
} from "../../server/blueprint/types.js";
import { makeControlFarmBlueprint, makeInputVector } from "../../server/blueprint/fixtures.js";
import { runLatencyBench, formatReport, isMain, type LatencyStats } from "./harness.js";

/**
 * Naive, allocation-heavy interpreter. One instance per blueprint. `tick()`
 * mirrors the locked runtime's semantics but uses Map lookups + per-tick
 * allocation on purpose.
 */
class NaiveBlueprintInterpreter {
  private readonly tags = new Map<string, number>();
  private readonly state = new Map<string, number>(); // LATCH/TON state keyed by node id
  private readonly nodes: readonly BlueprintNode[];
  private readonly dtSeconds: number;

  constructor(def: BlueprintDefinition) {
    for (const t of def.tags) this.tags.set(t.name, t.initial ?? 0);
    // NOTE: no topo-sort here — baseline just runs in authoring order, which is
    // the fixture's already-correct order. The point is the per-tick cost, not
    // ordering correctness.
    this.nodes = def.nodes;
    this.dtSeconds = (def.scanPeriodMs ?? 100) / 1000;
  }

  setInput(name: string, value: number): void {
    this.tags.set(name, value);
  }

  get(name: string): number {
    return this.tags.get(name) ?? 0;
  }

  tick(): Record<string, number> {
    // Anti-pattern: fresh result object each tick.
    const results: Record<string, number> = {};
    for (const node of this.nodes) {
      // Anti-pattern: fresh operands array each node, each tick.
      const ops = node.inputs.map((o) =>
        isTagOperand(o) ? (this.tags.get(o.tag) ?? 0) : o.const,
      );
      const a = ops[0] ?? 0;
      const b = ops[1] ?? 0;
      const c = ops[2] ?? 0;
      let out: number;
      switch (node.op) {
        case "AND":
          out = a !== 0 && b !== 0 ? 1 : 0;
          break;
        case "OR":
          out = a !== 0 || b !== 0 ? 1 : 0;
          break;
        case "NOT":
          out = a !== 0 ? 0 : 1;
          break;
        case "XOR":
          out = (a !== 0) !== (b !== 0) ? 1 : 0;
          break;
        case "GT":
          out = a > b ? 1 : 0;
          break;
        case "GTE":
          out = a >= b ? 1 : 0;
          break;
        case "LT":
          out = a < b ? 1 : 0;
          break;
        case "LTE":
          out = a <= b ? 1 : 0;
          break;
        case "EQ":
          out = a === b ? 1 : 0;
          break;
        case "NEQ":
          out = a !== b ? 1 : 0;
          break;
        case "ADD":
          out = a + b;
          break;
        case "SUB":
          out = a - b;
          break;
        case "MUL":
          out = a * b;
          break;
        case "DIV":
          out = b !== 0 ? a / b : 0;
          break;
        case "MIN":
          out = a < b ? a : b;
          break;
        case "MAX":
          out = a > b ? a : b;
          break;
        case "SELECT":
          out = a !== 0 ? b : c;
          break;
        case "MOVE":
          out = a;
          break;
        case "CONST":
          out = node.param ?? 0;
          break;
        case "LATCH": {
          let q = this.state.get(node.id) ?? 0;
          if (b !== 0) q = 0;
          if (a !== 0) q = 1;
          this.state.set(node.id, q);
          out = q;
          break;
        }
        case "TON": {
          let elapsed = this.state.get(node.id) ?? 0;
          const preset = node.param ?? 0;
          if (a !== 0) {
            elapsed += this.dtSeconds;
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
          this.state.set(node.id, elapsed);
          break;
        }
        default:
          out = 0;
          break;
      }
      this.tags.set(node.output, out);
      results[node.output] = out;
    }
    return results;
  }
}

const TAG_COUNT = 1000;
const INSTRUCTION_COUNT = 800;

export async function runBaselineBench(): Promise<LatencyStats> {
  const def = makeControlFarmBlueprint(TAG_COUNT);
  if (def.tags.length !== TAG_COUNT) {
    throw new Error(
      `benchmark fixture must contain exactly ${TAG_COUNT} tags, got ${def.tags.length}`,
    );
  }
  if (def.nodes.length !== INSTRUCTION_COUNT) {
    throw new Error(
      `benchmark fixture must contain exactly ${INSTRUCTION_COUNT} instructions, ` +
        `got ${def.nodes.length}`,
    );
  }
  const interp = new NaiveBlueprintInterpreter(def);

  // Pre-build a few input vectors so beforeTick rotates inputs without Math.random.
  const inputNames = def.tags.filter((t) => t.direction === "input").map((t) => t.name);
  const vectors = [
    makeInputVector(inputNames.length, 1),
    makeInputVector(inputNames.length, 2),
    makeInputVector(inputNames.length, 3),
  ];

  return runLatencyBench({
    label: `BASELINE naive interpreter — ${def.tags.length}-tag blueprint`,
    warmup: 5_000,
    iterations: 50_000,
    beforeTick: (i) => {
      const v = vectors[i % vectors.length];
      for (let k = 0; k < inputNames.length; k++) interp.setInput(inputNames[k], v[k]);
    },
    tick: () => {
      // Result object is intentionally discarded — its allocation is the point.
      interp.tick();
    },
  });
}

async function main(): Promise<void> {
  const stats = await runBaselineBench();
  console.log(formatReport(stats));
}

if (isMain(import.meta.url)) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
