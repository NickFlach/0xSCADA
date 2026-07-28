/**
 * The safe-state actuation seam must actually move outputs (#459).
 *
 * These tests drive the REAL deterministic runtime (not a fake) through
 * {@link BlueprintRuntimeActuator} and assert the runtime's tag store — the only
 * output sink that genuinely exists in this repository today — really changes.
 */

import { describe, expect, it } from "vitest";

import { compileBlueprint } from "../compiler";
import { BlueprintRuntime } from "../runtime";
import type { BlueprintDefinition } from "../types";
import {
  BlueprintRuntimeActuator,
  OUTPUT_WRITE_OPT_IN_ENV,
  type FieldOutputSink,
} from "../runtime-actuator";

const DEFINITION: BlueprintDefinition = {
  id: "bp-actuator",
  name: "Two-output actuator fixture",
  scanPeriodMs: 50,
  tags: [
    { name: "IN_A", direction: "input", dataType: "float", initial: 3 },
    { name: "IN_B", direction: "input", dataType: "float", initial: 4 },
    { name: "OUT_SUM", direction: "output", dataType: "float" },
    { name: "OUT_COPY", direction: "output", dataType: "float" },
  ],
  nodes: [
    { id: "n_sum", op: "ADD", inputs: [{ tag: "IN_A" }, { tag: "IN_B" }], output: "OUT_SUM" },
    { id: "n_copy", op: "MOVE", inputs: [{ tag: "IN_A" }], output: "OUT_COPY" },
  ],
};

class RecordingSink implements FieldOutputSink {
  readonly id = "recording-sink";
  readonly writes: Array<Record<string, number>> = [];
  failNext = false;

  writeOutputs(values: ReadonlyMap<string, number>): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("field write rejected");
    }
    this.writes.push(Object.fromEntries(values));
  }
}

function build(
  env: NodeJS.ProcessEnv,
  options: { fieldSink?: FieldOutputSink; safeRecipes?: Record<string, Record<string, number>> } = {},
): { runtime: BlueprintRuntime; actuator: BlueprintRuntimeActuator } {
  const runtime = new BlueprintRuntime(compileBlueprint(DEFINITION));
  const actuator = new BlueprintRuntimeActuator("bp-actuator", runtime, {
    siteId: "site-1",
    env,
    ...options,
  });
  return { runtime, actuator };
}

describe("BlueprintRuntimeActuator", () => {
  it("discovers the blueprint's output tags from the compiled program", () => {
    const { actuator } = build({});
    expect([...actuator.getOutputTagNames()].sort()).toEqual(["OUT_COPY", "OUT_SUM"]);
    expect(actuator.getCapabilities()).toMatchObject({
      blueprintId: "bp-actuator",
      outputSink: "runtime-tag-store",
      fieldSinkBound: false,
      outputWritesAllowed: false,
    });
  });

  it("halts and resumes a real latch that tick drivers must honour", () => {
    const { actuator } = build({});
    expect(actuator.isHalted()).toBe(false);
    actuator.halt();
    expect(actuator.isHalted()).toBe(true);
    actuator.resume();
    expect(actuator.isHalted()).toBe(false);
    expect(actuator.getOutputMode()).toBe("loop");
  });

  it("holds the last computed outputs and republishes them to a bound sink", () => {
    const sink = new RecordingSink();
    const { runtime, actuator } = build({}, { fieldSink: sink });

    runtime.tickFast();
    expect(runtime.get("OUT_SUM")).toBe(7);

    actuator.holdLastOutputs();

    expect(actuator.getOutputMode()).toBe("hold-last");
    expect(Object.fromEntries(actuator.getHeldOutputs()!)).toEqual({
      OUT_SUM: 7,
      OUT_COPY: 3,
    });
    // Hold-last commands no NEW value; it re-asserts what the loop last wrote.
    expect(runtime.get("OUT_SUM")).toBe(7);
    expect(sink.writes).toEqual([{ OUT_SUM: 7, OUT_COPY: 3 }]);
  });

  it("refuses to force outputs to zero without the explicit opt-in", () => {
    const { runtime, actuator } = build({});
    runtime.tickFast();

    expect(() => actuator.forceZeroOutputs()).toThrow(
      new RegExp(OUTPUT_WRITE_OPT_IN_ENV),
    );
    expect(() => actuator.assertCanApply("force-zero")).toThrow(/Refusing to arm/);
    // Fail-closed means the plant output is untouched, not partially written.
    expect(runtime.get("OUT_SUM")).toBe(7);
  });

  it("does not treat any value other than \"true\" as an opt-in", () => {
    for (const value of ["1", "yes", "TRUE", ""]) {
      const { actuator } = build({ [OUTPUT_WRITE_OPT_IN_ENV]: value });
      expect(actuator.getCapabilities().outputWritesAllowed).toBe(false);
      expect(() => actuator.forceZeroOutputs()).toThrow();
    }
  });

  it("drives every output tag to zero in the runtime tag store once opted in", () => {
    const sink = new RecordingSink();
    const { runtime, actuator } = build(
      { [OUTPUT_WRITE_OPT_IN_ENV]: "true" },
      { fieldSink: sink },
    );
    runtime.tickFast();
    expect(runtime.get("OUT_SUM")).toBe(7);
    expect(runtime.get("OUT_COPY")).toBe(3);

    actuator.assertCanApply("force-zero");
    actuator.forceZeroOutputs();

    expect(runtime.get("OUT_SUM")).toBe(0);
    expect(runtime.get("OUT_COPY")).toBe(0);
    expect(actuator.getOutputMode()).toBe("force-zero");
    expect(sink.writes).toEqual([{ OUT_SUM: 0, OUT_COPY: 0 }]);
  });

  it("propagates a field-sink failure instead of claiming the plant is safe", () => {
    const sink = new RecordingSink();
    sink.failNext = true;
    const { runtime, actuator } = build(
      { [OUTPUT_WRITE_OPT_IN_ENV]: "true" },
      { fieldSink: sink },
    );
    runtime.tickFast();

    expect(() => actuator.forceZeroOutputs()).toThrow(/field write rejected/);
  });

  it("applies only declared safe recipes, and only when opted in", () => {
    const recipes = { "purge-and-vent": { OUT_SUM: 0, OUT_COPY: 1 } };

    const denied = build({}, { safeRecipes: recipes });
    expect(() => denied.actuator.assertCanApply({ recipe: "purge-and-vent" })).toThrow(
      new RegExp(OUTPUT_WRITE_OPT_IN_ENV),
    );

    const allowed = build({ [OUTPUT_WRITE_OPT_IN_ENV]: "true" }, { safeRecipes: recipes });
    expect(() => allowed.actuator.assertCanApply({ recipe: "unknown" })).toThrow(
      /not defined for this blueprint/,
    );
    expect(() => allowed.actuator.applySafeRecipe("unknown")).toThrow(/Unknown safe recipe/);

    allowed.runtime.tickFast();
    allowed.actuator.assertCanApply({ recipe: "purge-and-vent" });
    allowed.actuator.applySafeRecipe("purge-and-vent");

    expect(allowed.runtime.get("OUT_SUM")).toBe(0);
    expect(allowed.runtime.get("OUT_COPY")).toBe(1);
    expect(allowed.actuator.getOutputMode()).toBe("recipe");
  });

  it("rejects a recipe that targets a tag the blueprint does not output", () => {
    const { actuator } = build(
      { [OUTPUT_WRITE_OPT_IN_ENV]: "true" },
      { safeRecipes: { bad: { IN_A: 0 } } },
    );

    expect(() => actuator.assertCanApply({ recipe: "bad" })).toThrow(
      /targets non-output tags: IN_A/,
    );
  });

  it("always accepts hold-last, which commands no new value", () => {
    const { actuator } = build({});
    expect(() => actuator.assertCanApply("hold-last")).not.toThrow();
  });
});
