/**
 * Deterministic Blueprint Runtime — Test/Benchmark Fixtures
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *
 * Synthetic but realistic blueprints used by both the unit tests and the
 * benchmark suite. Kept here (not under __tests__/) so bench/ can import them
 * without reaching into test-only paths.
 */

import type { BlueprintDefinition, BlueprintNode, TagDescriptor } from "./types.js";

/**
 * Build a blueprint with roughly `tagCount` tags that exercises every opcode
 * class. The shape mimics a control-module farm: each "unit" reads two analog
 * inputs, runs a comparator + interlock chain, drives a latch and an on-delay
 * timer, and writes a command output.
 *
 * Layout per unit (8 tags):
 *   in_a, in_b           : inputs (analog)
 *   hi_alarm             : in_a > limit             (GT)
 *   permissive           : in_b < limit2            (LT)
 *   interlock            : hi_alarm AND permissive   (AND)
 *   cmd_latch            : LATCH(set=interlock, reset=in_a EQ 0)  (LATCH + EQ)
 *   delayed              : TON(enable=cmd_latch, preset)          (TON)
 *   out_cmd              : SELECT(delayed, in_a + in_b, 0)        (SELECT + ADD)
 */
export function makeControlFarmBlueprint(tagCount: number): BlueprintDefinition {
  const TAGS_PER_UNIT = 8;
  const units = Math.max(1, Math.floor(tagCount / TAGS_PER_UNIT));

  const tags: TagDescriptor[] = [];
  const nodes: BlueprintNode[] = [];

  for (let u = 0; u < units; u++) {
    const inA = `U${u}.IN_A`;
    const inB = `U${u}.IN_B`;
    const hiAlarm = `U${u}.HI_ALARM`;
    const permissive = `U${u}.PERMISSIVE`;
    const interlock = `U${u}.INTERLOCK`;
    const zeroCmp = `U${u}.IS_ZERO`;
    const cmdLatch = `U${u}.CMD_LATCH`;
    const delayed = `U${u}.DELAYED`;
    const sumAB = `U${u}.SUM_AB`;
    const outCmd = `U${u}.OUT_CMD`;

    tags.push(
      { name: inA, direction: "input", dataType: "float", initial: 0 },
      { name: inB, direction: "input", dataType: "float", initial: 0 },
      { name: hiAlarm, direction: "internal", dataType: "bool" },
      { name: permissive, direction: "internal", dataType: "bool" },
      { name: interlock, direction: "internal", dataType: "bool" },
      { name: zeroCmp, direction: "internal", dataType: "bool" },
      { name: cmdLatch, direction: "internal", dataType: "bool" },
      { name: delayed, direction: "internal", dataType: "bool" },
      { name: sumAB, direction: "internal", dataType: "float" },
      { name: outCmd, direction: "output", dataType: "float" },
    );

    nodes.push(
      { id: `${u}:hi`, op: "GT", inputs: [{ tag: inA }, { const: 75 }], output: hiAlarm },
      { id: `${u}:perm`, op: "LT", inputs: [{ tag: inB }, { const: 90 }], output: permissive },
      {
        id: `${u}:ilk`,
        op: "AND",
        inputs: [{ tag: hiAlarm }, { tag: permissive }],
        output: interlock,
      },
      { id: `${u}:zero`, op: "EQ", inputs: [{ tag: inA }, { const: 0 }], output: zeroCmp },
      {
        id: `${u}:latch`,
        op: "LATCH",
        inputs: [{ tag: interlock }, { tag: zeroCmp }],
        output: cmdLatch,
      },
      { id: `${u}:ton`, op: "TON", inputs: [{ tag: cmdLatch }], output: delayed, param: 0.5 },
      { id: `${u}:sum`, op: "ADD", inputs: [{ tag: inA }, { tag: inB }], output: sumAB },
      {
        id: `${u}:out`,
        op: "SELECT",
        inputs: [{ tag: delayed }, { tag: sumAB }, { const: 0 }],
        output: outCmd,
      },
    );
  }

  return {
    id: `farm-${units}`,
    name: `Control Farm (${units} units, ${tags.length} tags)`,
    tags,
    nodes,
    scanPeriodMs: 100,
  };
}

/**
 * Deterministic pseudo-random input vector for a control-farm blueprint, so the
 * benchmark's input write does real work without pulling in Math.random()
 * jitter. Returns a Float64Array sized to the blueprint's input count.
 */
export function makeInputVector(inputCount: number, seed: number): Float64Array {
  const v = new Float64Array(inputCount);
  // xorshift32 — cheap, deterministic, allocation-free after this array.
  let s = seed >>> 0 || 1;
  for (let i = 0; i < inputCount; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    v[i] = (s % 10000) / 100; // 0..100
  }
  return v;
}
