/**
 * Compiler unit tests — Issue #457.
 *
 * Covers the pure, deterministic compilation logic: tag-index construction,
 * arity / reference validation, topological ordering (including stateful
 * feedback breaking cycles), and the Structure-of-Arrays packing contract that
 * the runtime relies on.
 */

import { describe, it, expect } from "vitest";
import { compileBlueprint, BlueprintCompileError } from "../compiler";
import {
  OpCode,
  OPERAND_STRIDE,
  type BlueprintDefinition,
  type TagDescriptor,
} from "../types";

function def(partial: Partial<BlueprintDefinition>): BlueprintDefinition {
  return {
    id: "bp",
    name: "test",
    tags: [],
    nodes: [],
    ...partial,
  };
}

describe("compileBlueprint — tag-index table", () => {
  it("assigns dense, declaration-ordered slots", () => {
    const c = compileBlueprint(
      def({
        tags: [
          { name: "A", direction: "input", dataType: "float" },
          { name: "B", direction: "internal", dataType: "float" },
          { name: "C", direction: "output", dataType: "float" },
        ],
      }),
    );
    expect(c.tagCount).toBe(3);
    expect(c.tagIndex.get("A")).toBe(0);
    expect(c.tagIndex.get("B")).toBe(1);
    expect(c.tagIndex.get("C")).toBe(2);
  });

  it("applies initial values into the parallel array", () => {
    const c = compileBlueprint(
      def({
        tags: [
          { name: "A", direction: "input", dataType: "float", initial: 3.5 },
          { name: "B", direction: "internal", dataType: "float" },
        ],
      }),
    );
    expect(Array.from(c.initialValues)).toEqual([3.5, 0]);
  });

  it("precomputes input and output slot lists", () => {
    const c = compileBlueprint(
      def({
        tags: [
          { name: "IN1", direction: "input", dataType: "float" },
          { name: "MID", direction: "internal", dataType: "float" },
          { name: "IN2", direction: "input", dataType: "float" },
          { name: "OUT", direction: "output", dataType: "float" },
        ],
      }),
    );
    expect(Array.from(c.inputSlots)).toEqual([0, 2]);
    expect(Array.from(c.outputSlots)).toEqual([3]);
  });

  it("rejects an empty tag space", () => {
    expect(() => compileBlueprint(def({}))).toThrow(BlueprintCompileError);
  });

  it("rejects duplicate tag names", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags: [
            { name: "A", direction: "input", dataType: "float" },
            { name: "A", direction: "output", dataType: "float" },
          ],
        }),
      ),
    ).toThrow(/duplicate tag/);
  });
});

describe("compileBlueprint — node validation", () => {
  const tags: TagDescriptor[] = [
    { name: "A", direction: "input", dataType: "float" },
    { name: "B", direction: "input", dataType: "float" },
    { name: "Y", direction: "output", dataType: "float" },
  ];

  it("rejects wrong operand arity", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags,
          nodes: [{ id: "n1", op: "AND", inputs: [{ tag: "A" }], output: "Y" }],
        }),
      ),
    ).toThrow(/expects 2 operand/);
  });

  it("rejects a node writing an unknown tag", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags,
          nodes: [{ id: "n1", op: "MOVE", inputs: [{ tag: "A" }], output: "NOPE" }],
        }),
      ),
    ).toThrow(/unknown tag "NOPE"/);
  });

  it("rejects a node reading an unknown tag", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags,
          nodes: [{ id: "n1", op: "MOVE", inputs: [{ tag: "GHOST" }], output: "Y" }],
        }),
      ),
    ).toThrow(/unknown tag "GHOST"/);
  });

  it("rejects two nodes driving the same output (multiple drivers)", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags,
          nodes: [
            { id: "n1", op: "MOVE", inputs: [{ tag: "A" }], output: "Y" },
            { id: "n2", op: "MOVE", inputs: [{ tag: "B" }], output: "Y" },
          ],
        }),
      ),
    ).toThrow(/more than one node/);
  });

  it("requires a param for CONST/TON", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags,
          nodes: [{ id: "n1", op: "CONST", inputs: [], output: "Y" }],
        }),
      ),
    ).toThrow(/requires a "param"/);
  });

  it("rejects a negative TON preset", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags,
          nodes: [{ id: "n1", op: "TON", inputs: [{ tag: "A" }], output: "Y", param: -1 }],
        }),
      ),
    ).toThrow(/TON preset must be >= 0/);
  });
});

describe("compileBlueprint — instruction packing (SoA contract)", () => {
  it("packs opcode, dest, immediate and operands at the fixed stride", () => {
    const c = compileBlueprint(
      def({
        tags: [
          { name: "A", direction: "input", dataType: "float" },
          { name: "B", direction: "input", dataType: "float" },
          { name: "Y", direction: "output", dataType: "float" },
        ],
        nodes: [{ id: "add", op: "ADD", inputs: [{ tag: "A" }, { const: 2.5 }], output: "Y" }],
      }),
    );

    expect(c.instructionCount).toBe(1);
    expect(c.opcodes[0]).toBe(OpCode.ADD);
    expect(c.destIndices[0]).toBe(c.tagIndex.get("Y"));

    const base = 0 * OPERAND_STRIDE;
    // operand 0 -> tag A (index), operand 1 -> immediate (index -1, const carried)
    expect(c.operandTagIndices[base + 0]).toBe(c.tagIndex.get("A"));
    expect(c.operandTagIndices[base + 1]).toBe(-1);
    expect(c.operandConsts[base + 1]).toBe(2.5);
    // unused third slot stays -1
    expect(c.operandTagIndices[base + 2]).toBe(-1);
  });

  it("carries the CONST/TON immediate in the immediates array", () => {
    const c = compileBlueprint(
      def({
        tags: [{ name: "K", direction: "output", dataType: "float" }],
        nodes: [{ id: "k", op: "CONST", inputs: [], output: "K", param: 42 }],
      }),
    );
    expect(c.opcodes[0]).toBe(OpCode.CONST);
    expect(c.immediates[0]).toBe(42);
  });

  it("allocates exactly one state slot per stateful op", () => {
    const c = compileBlueprint(
      def({
        tags: [
          { name: "S", direction: "input", dataType: "bool" },
          { name: "R", direction: "input", dataType: "bool" },
          { name: "EN", direction: "input", dataType: "bool" },
          { name: "Q", direction: "output", dataType: "bool" },
          { name: "DN", direction: "output", dataType: "bool" },
        ],
        nodes: [
          { id: "l", op: "LATCH", inputs: [{ tag: "S" }, { tag: "R" }], output: "Q" },
          { id: "t", op: "TON", inputs: [{ tag: "EN" }], output: "DN", param: 1 },
        ],
      }),
    );
    expect(c.stateCount).toBe(2);
    // both stateful instructions get distinct, non-negative state indices
    const stateful = Array.from(c.stateIndices).filter((s) => s >= 0).sort();
    expect(stateful).toEqual([0, 1]);
  });
});

describe("compileBlueprint — topological ordering", () => {
  it("orders producers before consumers within a tick", () => {
    const c = compileBlueprint(
      def({
        tags: [
          { name: "A", direction: "input", dataType: "float" },
          { name: "MID", direction: "internal", dataType: "float" },
          { name: "Y", direction: "output", dataType: "float" },
        ],
        // Declared consumer-first to prove the sort reorders.
        nodes: [
          { id: "consumer", op: "MOVE", inputs: [{ tag: "MID" }], output: "Y" },
          { id: "producer", op: "MOVE", inputs: [{ tag: "A" }], output: "MID" },
        ],
      }),
    );
    // dest[0] must be MID (producer) before dest[1] = Y (consumer)
    expect(c.destIndices[0]).toBe(c.tagIndex.get("MID"));
    expect(c.destIndices[1]).toBe(c.tagIndex.get("Y"));
  });

  it("allows a stateful op to read its OWN output (direct feedback) without a cycle", () => {
    // Q = LATCH(set=A, reset=Q). The latch's reset reads its own previous-tick
    // value out of the state buffer, so the self-reference is NOT a cycle. This
    // is the compiler's documented feedback-breaking contract: it applies to a
    // stateful node's direct self-edge only.
    const c = compileBlueprint(
      def({
        tags: [
          { name: "A", direction: "input", dataType: "bool" },
          { name: "Q", direction: "output", dataType: "bool" },
        ],
        nodes: [{ id: "latch", op: "LATCH", inputs: [{ tag: "A" }, { tag: "Q" }], output: "Q" }],
      }),
    );
    expect(c.instructionCount).toBe(1);
    expect(c.stateCount).toBe(1);
  });

  it("rejects INDIRECT feedback routed through a stateless node (documented boundary)", () => {
    // Q = LATCH(set=A, reset=NQ) with NQ = NOT(Q). The feedback is routed through
    // a stateless NOT, so NQ must be computed *this* tick from Q computed *this*
    // tick — a genuine combinational cycle. The compiler only breaks a stateful
    // node's DIRECT self-edge, so it (correctly) rejects this. Break such loops
    // by feeding the latch's own output back directly instead.
    expect(() =>
      compileBlueprint(
        def({
          tags: [
            { name: "A", direction: "input", dataType: "bool" },
            { name: "Q", direction: "output", dataType: "bool" },
            { name: "NQ", direction: "internal", dataType: "bool" },
          ],
          nodes: [
            { id: "inv", op: "NOT", inputs: [{ tag: "Q" }], output: "NQ" },
            { id: "latch", op: "LATCH", inputs: [{ tag: "A" }, { tag: "NQ" }], output: "Q" },
          ],
        }),
      ),
    ).toThrow(/combinational cycle/);
  });

  it("rejects a DIRECT stateless self-cycle (X = NOT(X))", () => {
    // A stateless node reading its own output is a combinational self-loop: it
    // would otherwise silently read its own previous-tick value (an undeclared
    // implicit delay). The compiler rejects it, mirroring the indirect-feedback
    // boundary above — only a *stateful* op may read its own output.
    expect(() =>
      compileBlueprint(
        def({
          tags: [{ name: "X", direction: "internal", dataType: "bool", initial: 0 }],
          nodes: [{ id: "inv", op: "NOT", inputs: [{ tag: "X" }], output: "X" }],
        }),
      ),
    ).toThrow(/self-cycle/);
  });

  it("rejects a genuine combinational cycle through stateless nodes", () => {
    expect(() =>
      compileBlueprint(
        def({
          tags: [
            { name: "X", direction: "internal", dataType: "float" },
            { name: "Y", direction: "internal", dataType: "float" },
          ],
          nodes: [
            { id: "n1", op: "MOVE", inputs: [{ tag: "Y" }], output: "X" },
            { id: "n2", op: "MOVE", inputs: [{ tag: "X" }], output: "Y" },
          ],
        }),
      ),
    ).toThrow(/combinational cycle/);
  });
});
