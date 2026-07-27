/**
 * Blueprint safety composition root (#459).
 *
 * This is the module that makes the watchdog non-ceremonial: it constructs the
 * deterministic runtime for each operator-declared blueprint, wraps it in a real
 * {@link BlueprintRuntimeActuator}, calls {@link WatchdogRegistry.register}, and
 * drives the control ticks whose durations the watchdog measures. Without it,
 * `register()` would only ever be called from tests and
 * `/api/blueprint-safe-state` would always be empty.
 *
 * OFF BY DEFAULT. The host does nothing unless a deployment explicitly supplies
 * blueprint safety bindings through {@link SAFETY_BINDINGS_FILE_ENV} or
 * {@link SAFETY_BINDINGS_ENV}. In a default deployment the API therefore reports
 * `state: "DISABLED"` with an explicit reason — empty *because no blueprint is
 * loaded*, which is a different and honest statement from empty because nothing
 * ever registers.
 *
 * FAIL-CLOSED. A binding whose declared safe state cannot actually be actuated
 * (for example `force-zero` without the plant-output opt-in) is rejected by
 * {@link WatchdogRegistry.register}; that blueprint is NOT started and the
 * refusal is reported in the host status.
 *
 * Relationship to #457: that issue lands its own deterministic-runtime
 * production host separately. This module deliberately does not depend on it —
 * it composes only `compileBlueprint` / `BlueprintRuntime`, which are already on
 * main. When #457's host lands, it should register its runtimes with the shared
 * {@link safeStateRegistry} rather than starting a second loop here.
 */

import { readFileSync } from "node:fs";

import { z } from "zod";
import { safeStateConfigSchema } from "@shared/schema";

import { compileBlueprint } from "./compiler.js";
import { BlueprintRuntime } from "./runtime.js";
import type { BlueprintDefinition } from "./types.js";
import { WatchdogRegistry } from "./registry";
import { BridgeAnchorBackend, StorageSafeStateAuditSink } from "./safe-state-adapters";
import {
  BlueprintRuntimeActuator,
  type ActuatorCapabilities,
} from "./runtime-actuator";
import type { Watchdog } from "./watchdog";
import { log, logError } from "../logger";

/** Env var holding a path to a JSON safety-bindings document. */
export const SAFETY_BINDINGS_FILE_ENV = "BLUEPRINT_SAFETY_BINDINGS_FILE" as const;
/** Env var holding an inline JSON safety-bindings document. */
export const SAFETY_BINDINGS_ENV = "BLUEPRINT_SAFETY_BINDINGS" as const;

/** Default tick period when neither the binding nor the blueprint declares one. */
const DEFAULT_SCAN_PERIOD_MS = 100;

// ─── Binding document schema (Zod-validated operator input) ──────────────────

const tagDescriptorSchema = z.object({
  name: z.string().min(1),
  direction: z.enum(["input", "output", "internal"]),
  dataType: z.enum(["bool", "int", "float"]),
  initial: z.number().optional(),
});

const operandSchema = z.union([
  z.object({ tag: z.string().min(1) }).strict(),
  z.object({ const: z.number() }).strict(),
]);

const nodeSchema = z.object({
  id: z.string().min(1),
  op: z.enum([
    "AND", "OR", "NOT", "XOR",
    "GT", "GTE", "LT", "LTE", "EQ", "NEQ",
    "ADD", "SUB", "MUL", "DIV", "MIN", "MAX",
    "SELECT", "MOVE", "CONST", "LATCH", "TON",
  ]),
  inputs: z.array(operandSchema),
  output: z.string().min(1),
  param: z.number().optional(),
});

const blueprintDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(tagDescriptorSchema).min(1),
  nodes: z.array(nodeSchema).min(1),
  scanPeriodMs: z.number().int().positive().optional(),
});

/** One blueprint bound to a watchdog and a declared safe state. */
export const blueprintSafetyBindingSchema = z.object({
  /** Owning site, if the blueprint is site-scoped. */
  siteId: z.string().min(1).optional(),
  blueprint: blueprintDefinitionSchema,
  safeState: safeStateConfigSchema,
  /**
   * Named safe recipes: recipe name -> (output tag -> value). A safe state of
   * `{ recipe }` is only actuatable if the recipe is declared here.
   */
  safeRecipes: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  /** Tick period; defaults to the blueprint's scanPeriodMs. */
  scanIntervalMs: z.number().int().positive().optional(),
});

export const blueprintSafetyBindingsSchema = z.object({
  bindings: z.array(blueprintSafetyBindingSchema).min(1),
});

export type BlueprintSafetyBinding = z.infer<typeof blueprintSafetyBindingSchema>;

// ─── Host status ─────────────────────────────────────────────────────────────

export interface BlueprintSafetyHostStatus {
  /**
   * DISABLED — no bindings configured; nothing is loaded (default deployment).
   * RUNNING  — at least one blueprint is armed and ticking.
   * FAILED   — bindings were configured but none could be armed.
   */
  state: "DISABLED" | "RUNNING" | "FAILED";
  /** Plain-language explanation, safe to show an operator. */
  reason: string;
  /** Which env var supplied the bindings, if any. */
  source: typeof SAFETY_BINDINGS_FILE_ENV | typeof SAFETY_BINDINGS_ENV | null;
  /** Blueprints that are armed with a watchdog right now. */
  registeredBlueprintIds: string[];
  /** Bindings that were refused, with the reason they were refused. */
  rejected: Array<{ blueprintId: string; message: string }>;
  /** What each armed actuator can actually drive. */
  actuators: ActuatorCapabilities[];
}

interface HostedBlueprint {
  binding: BlueprintSafetyBinding;
  runtime: BlueprintRuntime;
  actuator: BlueprintRuntimeActuator;
  watchdog: Watchdog;
  timer: NodeJS.Timeout;
  ticking: boolean;
}

// ─── Host ────────────────────────────────────────────────────────────────────

export class BlueprintSafetyHost {
  private readonly hosted = new Map<string, HostedBlueprint>();
  private state: BlueprintSafetyHostStatus["state"] = "DISABLED";
  private reason =
    `No blueprint safety bindings configured (${SAFETY_BINDINGS_FILE_ENV} / ${SAFETY_BINDINGS_ENV} unset); no blueprint is loaded.`;
  private source: BlueprintSafetyHostStatus["source"] = null;
  private rejected: Array<{ blueprintId: string; message: string }> = [];

  constructor(private readonly registry: WatchdogRegistry) {}

  /**
   * Load the configured bindings, arm a watchdog per blueprint and start the
   * tick loops. Safe to call once at boot; a no-op when unconfigured.
   */
  start(env: NodeJS.ProcessEnv = process.env): BlueprintSafetyHostStatus {
    this.stop();
    this.rejected = [];

    const document = this.readBindings(env);
    if (!document) return this.getStatus();

    const parsed = blueprintSafetyBindingsSchema.safeParse(document.value);
    if (!parsed.success) {
      this.state = "FAILED";
      this.reason =
        `Blueprint safety bindings from ${document.source} are invalid: ` +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
      logError(new Error(this.reason), "Blueprint safety host");
      return this.getStatus();
    }

    for (const binding of parsed.data.bindings) {
      this.arm(binding, env);
    }

    if (this.hosted.size === 0) {
      this.state = "FAILED";
      this.reason =
        `No blueprint from ${document.source} could be armed; every binding was refused. ` +
        `Safe-state handling is NOT active.`;
    } else {
      this.state = "RUNNING";
      this.reason =
        `${this.hosted.size} blueprint(s) armed from ${document.source}; ` +
        `watchdog tick budgets are being enforced.`;
      log(`Blueprint safety host: ${this.reason}`);
    }
    return this.getStatus();
  }

  /** Stop every tick loop and unregister every watchdog. */
  stop(): void {
    for (const [blueprintId, entry] of this.hosted) {
      clearInterval(entry.timer);
      this.registry.unregister(blueprintId);
    }
    this.hosted.clear();
    this.state = "DISABLED";
    this.source = null;
    this.reason =
      `No blueprint safety bindings configured (${SAFETY_BINDINGS_FILE_ENV} / ${SAFETY_BINDINGS_ENV} unset); no blueprint is loaded.`;
  }

  getStatus(): BlueprintSafetyHostStatus {
    return {
      state: this.state,
      reason: this.reason,
      source: this.source,
      registeredBlueprintIds: [...this.hosted.keys()],
      rejected: this.rejected.map((entry) => ({ ...entry })),
      actuators: [...this.hosted.values()].map((entry) =>
        entry.actuator.getCapabilities(),
      ),
    };
  }

  /** The runtime driven for a blueprint (diagnostics / tests). */
  getRuntime(blueprintId: string): BlueprintRuntime | undefined {
    return this.hosted.get(blueprintId)?.runtime;
  }

  /** The actuator bound to a blueprint (diagnostics / tests). */
  getActuator(blueprintId: string): BlueprintRuntimeActuator | undefined {
    return this.hosted.get(blueprintId)?.actuator;
  }

  /**
   * Run exactly one scan for a hosted blueprint and report its duration to the
   * watchdog. Exposed so the tick path can be exercised deterministically
   * instead of waiting on wall-clock timers.
   */
  async tickOnce(blueprintId: string): Promise<void> {
    const entry = this.hosted.get(blueprintId);
    if (!entry) return;
    // Honour the halt latch: a halted blueprint must not recompute outputs.
    if (entry.actuator.isHalted() || entry.ticking) return;
    entry.ticking = true;
    try {
      await entry.watchdog.runTick(() => entry.runtime.tickFast());
    } catch (error) {
      logError(error, `Blueprint ${blueprintId} tick failed`);
    } finally {
      entry.ticking = false;
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private readBindings(
    env: NodeJS.ProcessEnv,
  ): { source: NonNullable<BlueprintSafetyHostStatus["source"]>; value: unknown } | null {
    const file = env[SAFETY_BINDINGS_FILE_ENV];
    const inline = env[SAFETY_BINDINGS_ENV];
    if (!file && !inline) {
      this.state = "DISABLED";
      this.source = null;
      this.reason =
        `No blueprint safety bindings configured (${SAFETY_BINDINGS_FILE_ENV} / ${SAFETY_BINDINGS_ENV} unset); no blueprint is loaded.`;
      return null;
    }

    const source = file ? SAFETY_BINDINGS_FILE_ENV : SAFETY_BINDINGS_ENV;
    this.source = source;
    try {
      const raw = file ? readFileSync(file, "utf8") : inline!;
      return { source, value: JSON.parse(raw) as unknown };
    } catch (error) {
      this.state = "FAILED";
      this.reason =
        `Blueprint safety bindings from ${source} could not be read: ` +
        (error instanceof Error ? error.message : String(error));
      logError(error, "Blueprint safety host bindings");
      return null;
    }
  }

  private arm(binding: BlueprintSafetyBinding, env: NodeJS.ProcessEnv): void {
    const blueprintId = binding.blueprint.id;
    if (this.hosted.has(blueprintId)) {
      // Refuse the duplicate without disturbing the binding already armed.
      const message =
        `duplicate binding for blueprint ${blueprintId}; each blueprint may be armed exactly once`;
      this.rejected.push({ blueprintId, message });
      logError(new Error(message), "Blueprint safety host");
      return;
    }

    try {
      const compiled = compileBlueprint(binding.blueprint as BlueprintDefinition);
      const runtime = new BlueprintRuntime(compiled);
      const actuator = new BlueprintRuntimeActuator(blueprintId, runtime, {
        siteId: binding.siteId,
        safeRecipes: binding.safeRecipes,
        env,
      });

      // Fail-closed: throws when the declared safe state is not actuatable, so
      // the blueprint below is never started.
      const watchdog = this.registry.register(actuator, binding.safeState);

      const periodMs =
        binding.scanIntervalMs
        ?? binding.blueprint.scanPeriodMs
        ?? DEFAULT_SCAN_PERIOD_MS;
      const timer = setInterval(() => {
        void this.tickOnce(blueprintId);
      }, periodMs);
      // Never keep the process (or a test runner) alive for a control loop.
      timer.unref?.();

      this.hosted.set(blueprintId, {
        binding,
        runtime,
        actuator,
        watchdog,
        timer,
        ticking: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.rejected.push({ blueprintId, message });
      this.registry.unregister(blueprintId);
      logError(error, `Refused to arm blueprint ${blueprintId}`);
    }
  }
}

// ─── Process-wide composition ────────────────────────────────────────────────

/**
 * The single registry shared by the composition root and the HTTP surface, so
 * `/api/blueprint-safe-state` reflects the watchdogs that are really armed.
 */
export const safeStateRegistry = new WatchdogRegistry(
  new BridgeAnchorBackend(),
  new StorageSafeStateAuditSink(),
);

export const blueprintSafetyHost = new BlueprintSafetyHost(safeStateRegistry);
