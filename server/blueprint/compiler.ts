/**
 * Deterministic Blueprint Runtime — Compiler
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *
 * Compiles an authoring-form {@link BlueprintDefinition} into a {@link CompiledBlueprint}:
 * a flat, Structure-of-Arrays instruction stream plus a tag-index table.
 *
 * All work that can be done once — name resolution, operand-arity checks,
 * topological ordering, state-slot allocation, typed-array packing — happens
 * HERE, at load time. The runtime hot loop (./runtime.ts) then performs no
 * lookups, no allocation, and no validation.
 */

import {
  type BlueprintDefinition,
  type BlueprintNode,
  type BlueprintOp,
  type CompiledBlueprint,
  type TagDescriptor,
  OpCode,
  OP_TO_OPCODE,
  OPERAND_STRIDE,
  isTagOperand,
} from "./types.js";

/** Thrown when a blueprint cannot be compiled. Carries the offending node/tag id. */
export class BlueprintCompileError extends Error {
  constructor(
    message: string,
    readonly subjectId?: string,
  ) {
    super(message);
    this.name = "BlueprintCompileError";
  }
}

// ─── Per-op operand arity ─────────────────────────────────────────────────────

/**
 * Required operand count per op. `param` (CONST value / TON preset) is carried
 * separately in `BlueprintNode.param`, so e.g. CONST has 0 operands.
 */
const OP_ARITY: Readonly<Record<BlueprintOp, number>> = {
  AND: 2,
  OR: 2,
  NOT: 1,
  XOR: 2,
  GT: 2,
  GTE: 2,
  LT: 2,
  LTE: 2,
  EQ: 2,
  NEQ: 2,
  ADD: 2,
  SUB: 2,
  MUL: 2,
  DIV: 2,
  MIN: 2,
  MAX: 2,
  SELECT: 3,
  MOVE: 1,
  CONST: 0,
  LATCH: 2, // set, reset
  TON: 1, // enable (preset comes from param)
};

/** Ops that carry a `param` immediate. */
const OP_USES_PARAM: ReadonlySet<BlueprintOp> = new Set(["CONST", "TON"]);

/** Ops that own a slot in the per-tick state buffer (feedback / timer accumulator). */
const OP_IS_STATEFUL: ReadonlySet<BlueprintOp> = new Set(["LATCH", "TON"]);

// ─── Compiler ─────────────────────────────────────────────────────────────────

export function compileBlueprint(def: BlueprintDefinition): CompiledBlueprint {
  if (def.tags.length === 0) {
    throw new BlueprintCompileError("blueprint has no tags", def.id);
  }

  // 1. Build the tag-index table (name -> dense slot) and detect duplicates.
  const tagIndex = new Map<string, number>();
  const tagMeta: TagDescriptor[] = [];
  for (const tag of def.tags) {
    if (tagIndex.has(tag.name)) {
      throw new BlueprintCompileError(`duplicate tag "${tag.name}"`, tag.name);
    }
    tagIndex.set(tag.name, tagMeta.length);
    tagMeta.push(tag);
  }
  const tagCount = tagMeta.length;

  // Initial values + input/output slot lists (precomputed for IO marshalling).
  const initialValues = new Float64Array(tagCount);
  const inputSlotList: number[] = [];
  const outputSlotList: number[] = [];
  for (let i = 0; i < tagCount; i++) {
    const t = tagMeta[i];
    initialValues[i] = t.initial ?? 0;
    if (t.direction === "input") inputSlotList.push(i);
    else if (t.direction === "output") outputSlotList.push(i);
  }

  // 2. Validate nodes (arity, tag references, unique outputs) before ordering.
  const writtenBy = new Map<string, BlueprintNode>(); // output tag -> node
  for (const node of def.nodes) {
    validateNode(node, tagIndex);
    if (writtenBy.has(node.output)) {
      throw new BlueprintCompileError(
        `tag "${node.output}" is written by more than one node (multiple drivers)`,
        node.id,
      );
    }
    writtenBy.set(node.output, node);
  }

  // 3. Topologically order nodes so a producer runs before any consumer WITHIN
  //    the same tick. Stateful ops (LATCH/TON) read their own previous-tick
  //    output via the state buffer, so a self / cyclic dependency through a
  //    stateful node does NOT count as a cycle.
  const order = topoSort(def.nodes, writtenBy);

  // 4. Allocate state slots for stateful ops.
  let stateCount = 0;
  const stateSlotByNode = new Map<string, number>();
  for (const node of order) {
    if (OP_IS_STATEFUL.has(node.op)) {
      stateSlotByNode.set(node.id, stateCount);
      // LATCH needs 1 slot (latched value); TON needs 1 slot (elapsed seconds).
      stateCount += 1;
    }
  }

  // 5. Emit the flat instruction stream (SoA).
  const instructionCount = order.length;
  const opcodes = new Uint8Array(instructionCount);
  const destIndices = new Int32Array(instructionCount);
  const immediates = new Float64Array(instructionCount);
  const operandTagIndices = new Int32Array(instructionCount * OPERAND_STRIDE).fill(-1);
  const operandConsts = new Float64Array(instructionCount * OPERAND_STRIDE);
  const stateIndices = new Int32Array(instructionCount).fill(-1);

  for (let i = 0; i < instructionCount; i++) {
    const node = order[i];
    opcodes[i] = OP_TO_OPCODE[node.op];
    destIndices[i] = tagIndex.get(node.output)!;
    immediates[i] = OP_USES_PARAM.has(node.op) ? (node.param ?? 0) : 0;

    const base = i * OPERAND_STRIDE;
    for (let k = 0; k < node.inputs.length; k++) {
      const operand = node.inputs[k];
      if (isTagOperand(operand)) {
        operandTagIndices[base + k] = tagIndex.get(operand.tag)!;
      } else {
        // index stays -1 => runtime reads operandConsts instead.
        operandConsts[base + k] = operand.const;
      }
    }

    const stateSlot = stateSlotByNode.get(node.id);
    if (stateSlot !== undefined) stateIndices[i] = stateSlot;
  }

  return {
    id: def.id,
    name: def.name,
    scanPeriodMs: def.scanPeriodMs ?? 100,
    tagCount,
    instructionCount,
    stateCount,
    opcodes,
    destIndices,
    immediates,
    operandTagIndices,
    operandConsts,
    stateIndices,
    tagIndex,
    initialValues,
    tagMeta,
    inputSlots: Int32Array.from(inputSlotList),
    outputSlots: Int32Array.from(outputSlotList),
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateNode(node: BlueprintNode, tagIndex: ReadonlyMap<string, number>): void {
  const expectedArity = OP_ARITY[node.op];
  if (expectedArity === undefined) {
    throw new BlueprintCompileError(`unknown op "${node.op}"`, node.id);
  }
  if (node.inputs.length !== expectedArity) {
    throw new BlueprintCompileError(
      `op ${node.op} expects ${expectedArity} operand(s), got ${node.inputs.length}`,
      node.id,
    );
  }
  if (node.inputs.length > OPERAND_STRIDE) {
    // Defensive: OPERAND_STRIDE must cover the widest op.
    throw new BlueprintCompileError(
      `op ${node.op} arity ${node.inputs.length} exceeds OPERAND_STRIDE ${OPERAND_STRIDE}`,
      node.id,
    );
  }
  if (!tagIndex.has(node.output)) {
    throw new BlueprintCompileError(`node writes unknown tag "${node.output}"`, node.id);
  }
  for (const operand of node.inputs) {
    if (isTagOperand(operand) && !tagIndex.has(operand.tag)) {
      throw new BlueprintCompileError(`node reads unknown tag "${operand.tag}"`, node.id);
    }
  }
  if (OP_USES_PARAM.has(node.op) && node.param === undefined) {
    throw new BlueprintCompileError(`op ${node.op} requires a "param" value`, node.id);
  }
  if (node.op === "TON" && (node.param ?? 0) < 0) {
    throw new BlueprintCompileError(`TON preset must be >= 0`, node.id);
  }
}

// ─── Topological sort ───────────────────────────────────────────────────────

/**
 * Kahn's algorithm over the data-dependency graph.
 *
 * An edge producer -> consumer exists when `consumer` reads a tag that
 * `producer` writes. Stateful ops break the dependency on their OWN output
 * (they read the previous tick's value out of the state buffer), so a feedback
 * loop routed through a LATCH/TON does not deadlock the sort. Any remaining
 * cycle (combinational feedback through stateless nodes) is a genuine error.
 */
function topoSort(
  nodes: readonly BlueprintNode[],
  writtenBy: ReadonlyMap<string, BlueprintNode>,
): BlueprintNode[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // node id -> ids of nodes that depend on it
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    dependents.set(node.id, []);
  }

  for (const node of nodes) {
    const selfStateful = OP_IS_STATEFUL.has(node.op);
    const seenProducers = new Set<string>();
    for (const operand of node.inputs) {
      if (!isTagOperand(operand)) continue;
      const producer = writtenBy.get(operand.tag);
      if (!producer) continue; // operand is an external input / unwritten tag
      // A stateful node reading its own output uses last tick's state — not an edge.
      if (selfStateful && producer.id === node.id) continue;
      // A STATELESS node reading its own output is a direct combinational
      // self-cycle (e.g. X = NOT(X)). Nothing breaks the loop, so it would
      // silently read its own previous-tick value — an undeclared implicit
      // delay. Reject it for the same reason indirect stateless feedback is
      // rejected below; feedback must be modelled through a stateful op.
      if (producer.id === node.id) {
        throw new BlueprintCompileError(
          `node "${node.id}" feeds its own stateless output back into itself ` +
            `(combinational self-cycle on tag "${operand.tag}"). ` +
            `Model feedback with a stateful op (LATCH/TON) instead.`,
          node.id,
        );
      }
      if (seenProducers.has(producer.id)) continue;
      seenProducers.add(producer.id);
      dependents.get(producer.id)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  const byId = new Map<string, BlueprintNode>(nodes.map((n) => [n.id, n]));
  // Seed queue with zero-in-degree nodes, preserving authoring order for stable output.
  const queue: string[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) queue.push(node.id);
  }

  const ordered: BlueprintNode[] = [];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    ordered.push(byId.get(id)!);
    for (const dep of dependents.get(id)!) {
      const d = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, d);
      if (d === 0) queue.push(dep);
    }
  }

  if (ordered.length !== nodes.length) {
    const remaining = nodes
      .filter((n) => !ordered.includes(n))
      .map((n) => n.id)
      .join(", ");
    throw new BlueprintCompileError(
      `combinational cycle detected among nodes: ${remaining}. ` +
        `Break the loop with a stateful op (LATCH/TON) to model feedback.`,
    );
  }

  return ordered;
}

// Re-export so consumers can `import { OpCode } from "./compiler"` if convenient.
export { OpCode };
