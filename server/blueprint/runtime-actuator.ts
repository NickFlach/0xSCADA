/**
 * Production actuation seam for the blueprint watchdog / safe-state core (#459).
 *
 * WHAT THIS ACTUALLY DRIVES — read this before trusting the safe state:
 *
 *   The deterministic runtime (server/blueprint/runtime.ts) owns a Float64Array
 *   tag store. Output-direction tags in that store are the command values a
 *   field-I/O layer is expected to publish. On current `main` that tag store is
 *   the ONLY sink that genuinely exists in this repository: the vendor adapters
 *   under server/services/vendors/ marshal write frames but do not transmit
 *   them, so there is no wire-level output path to bind today.
 *
 *   So {@link BlueprintRuntimeActuator} implements halt / hold-last / force-zero
 *   against the runtime tag store, and additionally against a
 *   {@link FieldOutputSink} when — and only when — a deployment binds one. No
 *   such sink ships in this repository; the interface exists so a real driver
 *   can be bound without touching the safe-state core, and the status surface
 *   reports honestly which sink is in use.
 *
 * SAFETY: `force-zero` and safe recipes command NEW output values. Those are
 * plant-output writes and are therefore fail-closed and off by default: they
 * require the explicit {@link OUTPUT_WRITE_OPT_IN_ENV} opt-in, and
 * {@link BlueprintRuntimeActuator.assertCanApply} rejects registration of a
 * blueprint whose declared safe state is not actuatable, so a blueprint is never
 * armed with a safe state it could not enter.
 */

import type { SafeStateAction } from "@shared/schema";
import type { BlueprintRuntime } from "./runtime.js";
import type { SafeStateActuator } from "./safe-state";

/**
 * Environment opt-in required before the actuator may command new output
 * values (`force-zero`, or a safe recipe). Unset/anything other than "true"
 * means those actions are unavailable and registration of a blueprint that
 * declares them fails closed.
 */
export const OUTPUT_WRITE_OPT_IN_ENV = "BLUEPRINT_SAFE_STATE_ALLOW_OUTPUT_WRITES" as const;

/** True when the deployment has explicitly opted in to commanded output writes. */
export function outputWritesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[OUTPUT_WRITE_OPT_IN_ENV] === "true";
}

/**
 * A real field-output path. A deployment binds one when it has a driver that
 * actually transmits; none is provided by this repository (see the module
 * header). Implementations MUST throw on failure — a swallowed write would let
 * the controller claim a safe state that never reached the plant.
 */
export interface FieldOutputSink {
  /** Stable identity, surfaced in safe-state status for auditability. */
  readonly id: string;
  /** Publish output tag values. Throws if the write did not take effect. */
  writeOutputs(values: ReadonlyMap<string, number>): void;
}

export interface BlueprintRuntimeActuatorOptions {
  /** Owning site, if the blueprint is site-scoped. */
  siteId?: string;
  /**
   * Named safe recipes available to this blueprint, as output-tag -> value.
   * A recipe that is not declared here cannot be applied, and a blueprint
   * declaring it is rejected at registration.
   */
  safeRecipes?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Optional real field-output path (see {@link FieldOutputSink}). */
  fieldSink?: FieldOutputSink;
  /** Environment used for the output-write opt-in. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/** How the actuator is currently commanding outputs. */
export type ActuatorOutputMode = "loop" | "hold-last" | "force-zero" | "recipe";

/** Serialisable description of what this actuator can and does drive. */
export interface ActuatorCapabilities {
  blueprintId: string;
  /** Identity of the output sink actually in use. */
  outputSink: string;
  /** True when a real field-output path is bound (none ships in this repo). */
  fieldSinkBound: boolean;
  /** Whether commanded output writes are opted in for this process. */
  outputWritesAllowed: boolean;
  /** Safe recipes this actuator can apply. */
  declaredRecipes: string[];
}

/**
 * Drives a real {@link BlueprintRuntime} into its declared safe state.
 *
 * Every method either takes effect or throws — never a silent no-op.
 */
export class BlueprintRuntimeActuator implements SafeStateActuator {
  readonly blueprintId: string;
  readonly siteId?: string;

  private readonly runtime: BlueprintRuntime;
  private readonly outputTagNames: readonly string[];
  private readonly safeRecipes: Readonly<Record<string, Readonly<Record<string, number>>>>;
  private readonly fieldSink?: FieldOutputSink;
  private readonly env: NodeJS.ProcessEnv;

  private halted = false;
  private outputMode: ActuatorOutputMode = "loop";
  /** Last values commanded to outputs, captured on hold-last. */
  private heldOutputs?: ReadonlyMap<string, number>;

  constructor(
    blueprintId: string,
    runtime: BlueprintRuntime,
    options: BlueprintRuntimeActuatorOptions = {},
  ) {
    this.blueprintId = blueprintId;
    this.siteId = options.siteId;
    this.runtime = runtime;
    this.safeRecipes = options.safeRecipes ?? {};
    this.fieldSink = options.fieldSink;
    this.env = options.env ?? process.env;
    this.outputTagNames = runtime.tagMeta
      .filter((tag) => tag.direction === "output")
      .map((tag) => tag.name);
  }

  // ─── Introspection ─────────────────────────────────────────────────────────

  /** True while the control loop is halted. Tick drivers MUST honour this. */
  isHalted(): boolean {
    return this.halted;
  }

  /** How outputs are currently being commanded. */
  getOutputMode(): ActuatorOutputMode {
    return this.outputMode;
  }

  /** Output tag names this actuator commands. */
  getOutputTagNames(): readonly string[] {
    return this.outputTagNames;
  }

  /** Current value of every output tag, read from the runtime tag store. */
  readOutputs(): Map<string, number> {
    const values = new Map<string, number>();
    for (const name of this.outputTagNames) values.set(name, this.runtime.get(name));
    return values;
  }

  /** What this actuator can drive, for the operator/status surface. */
  getCapabilities(): ActuatorCapabilities {
    return {
      blueprintId: this.blueprintId,
      outputSink: this.fieldSink ? this.fieldSink.id : "runtime-tag-store",
      fieldSinkBound: this.fieldSink !== undefined,
      outputWritesAllowed: outputWritesEnabled(this.env),
      declaredRecipes: Object.keys(this.safeRecipes),
    };
  }

  // ─── SafeStateActuator ─────────────────────────────────────────────────────

  assertCanApply(action: SafeStateAction): void {
    if (action === "hold-last") {
      // Always actuatable: halting stops recomputation and the held values are
      // re-commanded to whatever sink is in use. No new value is commanded.
      return;
    }

    if (action === "force-zero") {
      if (!outputWritesEnabled(this.env)) {
        throw new Error(
          `Blueprint ${this.blueprintId} declares the "force-zero" safe state, which writes plant outputs. ` +
            `Set ${OUTPUT_WRITE_OPT_IN_ENV}=true to allow it, or declare "hold-last" instead. Refusing to arm.`,
        );
      }
      if (this.outputTagNames.length === 0) {
        throw new Error(
          `Blueprint ${this.blueprintId} declares "force-zero" but has no output tags to de-energise. Refusing to arm.`,
        );
      }
      return;
    }

    const recipe = this.safeRecipes[action.recipe];
    if (!recipe) {
      throw new Error(
        `Blueprint ${this.blueprintId} declares safe recipe "${action.recipe}", which is not defined for this blueprint. Refusing to arm.`,
      );
    }
    if (!outputWritesEnabled(this.env)) {
      throw new Error(
        `Blueprint ${this.blueprintId} declares safe recipe "${action.recipe}", which writes plant outputs. ` +
          `Set ${OUTPUT_WRITE_OPT_IN_ENV}=true to allow it. Refusing to arm.`,
      );
    }
    const unknown = Object.keys(recipe).filter(
      (name) => !this.outputTagNames.includes(name),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Safe recipe "${action.recipe}" for blueprint ${this.blueprintId} targets non-output tags: ${unknown.join(", ")}. Refusing to arm.`,
      );
    }
  }

  /**
   * Stop the control loop. The latch is what makes the halt real: the safety
   * host's tick driver refuses to tick while it is set, and
   * {@link Watchdog.runTick} skips the tick body once the controller is in safe
   * state, so no further output values are computed.
   */
  halt(): void {
    this.halted = true;
  }

  /**
   * Release the halt after an operator has cleared the safe state. Outputs are
   * deliberately NOT restored to their pre-trip values: the loop recomputes
   * them from live inputs on the next tick.
   */
  resume(): void {
    this.halted = false;
    this.outputMode = "loop";
    this.heldOutputs = undefined;
  }

  /**
   * Freeze outputs at their last commanded value. Commands no new value: the
   * current tag-store values are snapshotted and re-published to the bound
   * field sink so it holds them rather than ageing out.
   */
  holdLastOutputs(): void {
    const held = this.readOutputs();
    this.heldOutputs = held;
    this.outputMode = "hold-last";
    this.publish(held);
  }

  /**
   * Drive every output tag to zero / de-energised.
   *
   * SAFETY: this is a plant-output write. It is unreachable unless the
   * deployment sets {@link OUTPUT_WRITE_OPT_IN_ENV}=true; the check is repeated
   * here (not only in {@link assertCanApply}) so the opt-in cannot be bypassed
   * by a caller that constructed the actuator directly.
   */
  forceZeroOutputs(): void {
    if (!outputWritesEnabled(this.env)) {
      throw new Error(
        `Refusing to force-zero outputs for blueprint ${this.blueprintId}: ` +
          `${OUTPUT_WRITE_OPT_IN_ENV} is not set to "true".`,
      );
    }
    const zeros = new Map<string, number>();
    for (const name of this.outputTagNames) {
      this.runtime.set(name, 0);
      zeros.set(name, 0);
    }
    this.heldOutputs = zeros;
    this.outputMode = "force-zero";
    this.publish(zeros);
  }

  /**
   * Apply a named, previously-declared safe recipe.
   *
   * SAFETY: also a plant-output write — same fail-closed opt-in as
   * {@link forceZeroOutputs}. Unknown recipes throw rather than defaulting to
   * anything.
   */
  applySafeRecipe(recipe: string): void {
    const values = this.safeRecipes[recipe];
    if (!values) {
      throw new Error(
        `Unknown safe recipe "${recipe}" for blueprint ${this.blueprintId}`,
      );
    }
    if (!outputWritesEnabled(this.env)) {
      throw new Error(
        `Refusing to apply safe recipe "${recipe}" for blueprint ${this.blueprintId}: ` +
          `${OUTPUT_WRITE_OPT_IN_ENV} is not set to "true".`,
      );
    }
    const applied = new Map<string, number>();
    for (const [name, value] of Object.entries(values)) {
      this.runtime.set(name, value);
      applied.set(name, value);
    }
    this.heldOutputs = applied;
    this.outputMode = "recipe";
    this.publish(applied);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Publish commanded values to the bound field sink. Failures propagate: the
   * controller records a RECOVERY_FAILED transition rather than reporting a
   * safe state that never reached the plant.
   */
  private publish(values: ReadonlyMap<string, number>): void {
    if (!this.fieldSink) return;
    this.fieldSink.writeOutputs(values);
  }

  /** Values last commanded by a safe-state action, if any. */
  getHeldOutputs(): ReadonlyMap<string, number> | undefined {
    return this.heldOutputs;
  }
}
