/**
 * Deterministic Blueprint Runtime — authoring-form validation.
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *
 * `compileBlueprint()` assumes a structurally well-formed {@link BlueprintDefinition}:
 * it validates *semantics* (arity, tag references, cycles) but happily dereferences
 * fields whose presence the TypeScript types merely assert. A definition loaded
 * from disk is untrusted input, so it goes through this Zod schema first.
 *
 * The schema is deliberately `.strict()`: an unrecognised field is a rejection,
 * not something to ignore. Combined with the size limits enforced by
 * {@link parseBlueprintDefinition}, this is the "fail closed at load" boundary —
 * a malformed or oversized blueprint produces a clear error and the control loop
 * refuses to start, rather than the process crashing or executing something the
 * author did not write.
 */

import { z } from "zod";
import {
  OP_TO_OPCODE,
  OPERAND_STRIDE,
  type BlueprintDefinition,
  type BlueprintOp,
} from "./types.js";

/** Thrown when a candidate blueprint definition is rejected. */
export class BlueprintDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintDefinitionError";
  }
}

/**
 * Op names derived from the compiler/runtime opcode table so the schema can
 * never drift from the set of ops the runtime can actually execute.
 */
const BLUEPRINT_OPS = Object.keys(OP_TO_OPCODE) as [BlueprintOp, ...BlueprintOp[]];

export const BlueprintOperandSchema = z.union([
  z.object({ tag: z.string().min(1) }).strict(),
  z.object({ const: z.number().finite() }).strict(),
]);

export const TagDescriptorSchema = z
  .object({
    name: z.string().min(1),
    direction: z.enum(["input", "output", "internal"]),
    dataType: z.enum(["bool", "int", "float"]),
    initial: z.number().finite().optional(),
  })
  .strict();

export const BlueprintNodeSchema = z
  .object({
    id: z.string().min(1),
    op: z.enum(BLUEPRINT_OPS),
    // Per-op arity is checked by the compiler; OPERAND_STRIDE is the hard
    // structural bound the compiled instruction stream can encode.
    inputs: z.array(BlueprintOperandSchema).max(OPERAND_STRIDE),
    output: z.string().min(1),
    param: z.number().finite().optional(),
  })
  .strict();

export const BlueprintDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    tags: z.array(TagDescriptorSchema).min(1),
    nodes: z.array(BlueprintNodeSchema).min(1),
    /** Nominal scan period. Also the `dt` used by stateful ops (TON). */
    scanPeriodMs: z.number().int().min(1).max(3_600_000).optional(),
  })
  .strict();

/** Structural size ceilings applied on top of the schema. */
export interface BlueprintDefinitionLimits {
  readonly maxTags: number;
  readonly maxNodes: number;
}

function formatIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
  const extra = error.issues.length > shown.length ? ` (+${error.issues.length - shown.length} more)` : "";
  return `${shown.join("; ")}${extra}`;
}

/**
 * Validate an untrusted value as a {@link BlueprintDefinition}.
 *
 * @throws {BlueprintDefinitionError} with a message naming the offending field
 *   or limit. Never returns a partially-validated definition.
 */
export function parseBlueprintDefinition(
  value: unknown,
  limits: BlueprintDefinitionLimits,
): BlueprintDefinition {
  const parsed = BlueprintDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    throw new BlueprintDefinitionError(`schema validation failed — ${formatIssues(parsed.error)}`);
  }
  const def = parsed.data;

  if (def.tags.length > limits.maxTags) {
    throw new BlueprintDefinitionError(
      `blueprint declares ${def.tags.length} tags, exceeding the configured maximum of ${limits.maxTags}`,
    );
  }
  if (def.nodes.length > limits.maxNodes) {
    throw new BlueprintDefinitionError(
      `blueprint declares ${def.nodes.length} nodes, exceeding the configured maximum of ${limits.maxNodes}`,
    );
  }

  return def;
}
