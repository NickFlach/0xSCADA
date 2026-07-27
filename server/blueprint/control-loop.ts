/**
 * Deterministic Blueprint Runtime — production control-loop host.
 *
 * Issue #457: [wave:2b] Deterministic Blueprint Runtime
 *
 * WHAT THIS IS
 * ------------
 * `BlueprintRuntime` (./runtime.ts) is an allocation-free interpreter, but an
 * interpreter is inert until something drives it. This module is that driver:
 * it loads a blueprint definition from disk, validates it, compiles it ONCE,
 * pre-allocates every buffer at load time, and then drives `tickFast()` on a
 * fixed cadence, recording real scheduling telemetry.
 *
 * WHAT THIS DELIBERATELY IS NOT — READ BEFORE ENABLING
 * ---------------------------------------------------
 * This host EXECUTES control logic; it does NOT ACTUATE anything.
 *
 *   - There is no field-bus, gateway, OPC-UA, Modbus, DNP3 or storage write
 *     anywhere in this file. Enabling the loop creates no plant-output path
 *     that did not already exist; computed outputs stay in the runtime's own
 *     `Float64Array` and are only readable via {@link BlueprintControlLoop.readOutputs}.
 *   - Input tags are only written by an explicit in-process caller of
 *     {@link BlueprintControlLoop.writeInputs}. No IO binding ships in this
 *     module, so on a default deployment the input tags hold their load-time
 *     initial values and the loop is exercising the compiled program and the
 *     scheduler — not closed-loop control of a plant.
 *   - Binding real field IO (and the safety review that must accompany a write
 *     path) is out of scope here on purpose.
 *
 * The loop is OFF unless `BLUEPRINT_CONTROL_LOOP_ENABLED` is exactly the string
 * `"true"` AND `BLUEPRINT_CONTROL_LOOP_DEFINITION` names a readable blueprint
 * file. Any other value leaves it disabled; there is no truthy-ish coercion, so
 * it cannot be switched on by an accidental `1`/`yes`/`on`.
 *
 * HOT-PATH CONTRACT
 * -----------------
 * The measured scan is allocation-free. The timer callback
 * ({@link BlueprintControlLoop.tickOnce}) does only numeric work around
 * `tickFast()` — two `performance.now()` reads plus counter updates and one
 * store into a pre-allocated `Float64Array` ring buffer — and contains no
 * `await`/Promise, so the scan cannot be preempted mid-tick. The callback is
 * bound once in the constructor, so arming the timer allocates no closure.
 *
 * ONE HONEST EXCEPTION. At most once per `metricsPublishIntervalMs` (default
 * 1 s) the callback also runs {@link BlueprintControlLoop.publishMetrics}, and
 * that path DOES allocate: it takes two `subarray` views to sort the sampling
 * window, and the shared registry's `Gauge.set()`/`Counter.inc()` build a label
 * key per call (`labelNames.map(...).join()`). Two consequences, stated rather
 * than glossed:
 *
 *   - It cannot inflate a *measured* scan. Publication runs strictly AFTER the
 *     tick's duration has been recorded, so the exported p50/p99/max describe
 *     `tickFast()` alone.
 *   - It is still work on the scan timer. Those ~1/s allocations are GC
 *     pressure, and the publication itself delays the next timer arm slightly.
 *     If that lateness ever matters it is not hidden — it surfaces as a missed
 *     deadline in `missedDeadlines` / `scada_blueprint_control_loop_missed_deadlines_total`.
 *
 * Moving publication onto its own timer would make the scan callback allocation-
 * free outright; it is left here deliberately so the loop owns exactly one timer.
 */

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { log, logError } from "../logger.js";
import { compileBlueprint } from "./compiler.js";
import { parseBlueprintDefinition } from "./definition-schema.js";
import { BlueprintRuntime } from "./runtime.js";
import type { BlueprintDefinition, CompiledBlueprint } from "./types.js";
import {
  blueprintControlLoopEnabled,
  blueprintControlLoopLastTickMs,
  blueprintControlLoopLoadFailuresTotal,
  blueprintControlLoopMissedDeadlinesTotal,
  blueprintControlLoopOverrunsTotal,
  blueprintControlLoopRunning,
  blueprintControlLoopScanPeriodMs,
  blueprintControlLoopTickMaxMs,
  blueprintControlLoopTickP50Ms,
  blueprintControlLoopTickP99Ms,
  blueprintControlLoopTicksTotal,
  blueprintControlLoopWindowSamples,
} from "./metrics.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when the control loop cannot be configured or cannot load a blueprint. */
export class BlueprintControlLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintControlLoopError";
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Configuration ────────────────────────────────────────────────────────────

export const BlueprintControlLoopConfigSchema = z
  .object({
    /** Master switch. Only the exact string "true" sets this (see the loader). */
    enabled: z.boolean().default(false),
    /** Filesystem path of the blueprint definition JSON. Required when enabled. */
    definitionPath: z.string().min(1).nullable().default(null),
    /**
     * Overrides the definition's `scanPeriodMs`. The override is applied to the
     * definition BEFORE compilation so the cadence and the `dt` used by stateful
     * ops (TON) can never disagree.
     */
    periodMsOverride: z.coerce.number().int().min(1).max(3_600_000).nullable().default(null),
    /** Ring-buffer size for the scan-duration sampling window. */
    latencyWindowSamples: z.coerce.number().int().min(16).max(65_536).default(1024),
    /** How often window quantiles are published to Prometheus. */
    metricsPublishIntervalMs: z.coerce.number().int().min(100).max(600_000).default(1_000),
    /**
     * Lateness (ms) tolerated before a scan counts as a missed deadline.
     * Defaults to 25% of the scan period, floored at 1 ms.
     */
    jitterToleranceMsOverride: z.coerce.number().nonnegative().max(60_000).nullable().default(null),
    /** How long a missed deadline keeps the health check in `degraded`. */
    degradedWindowMs: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    /** Hard ceiling on the definition file size, checked before it is read. */
    maxDefinitionBytes: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    /** Hard ceiling on declared tags. */
    maxTags: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
    /** Hard ceiling on declared nodes. */
    maxNodes: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
  })
  .strict();

export type BlueprintControlLoopConfig = z.infer<typeof BlueprintControlLoopConfigSchema>;

/**
 * Build the control-loop configuration from environment variables.
 *
 * @throws {BlueprintControlLoopError} when a supplied value is unusable. The
 *   singleton wrapper below turns that into a disabled, fail-closed loop rather
 *   than letting it propagate into server startup.
 */
export function loadBlueprintControlLoopConfig(
  env: NodeJS.ProcessEnv = process.env,
): BlueprintControlLoopConfig {
  const parsed = BlueprintControlLoopConfigSchema.safeParse({
    // Exact-match only: an accidental "1"/"yes"/"TRUE" leaves the loop OFF.
    enabled: env.BLUEPRINT_CONTROL_LOOP_ENABLED === "true",
    definitionPath: env.BLUEPRINT_CONTROL_LOOP_DEFINITION || undefined,
    periodMsOverride: env.BLUEPRINT_CONTROL_LOOP_PERIOD_MS || undefined,
    latencyWindowSamples: env.BLUEPRINT_CONTROL_LOOP_WINDOW_SAMPLES || undefined,
    metricsPublishIntervalMs: env.BLUEPRINT_CONTROL_LOOP_METRICS_INTERVAL_MS || undefined,
    jitterToleranceMsOverride: env.BLUEPRINT_CONTROL_LOOP_JITTER_MS || undefined,
    degradedWindowMs: env.BLUEPRINT_CONTROL_LOOP_DEGRADED_WINDOW_MS || undefined,
    maxDefinitionBytes: env.BLUEPRINT_CONTROL_LOOP_MAX_BYTES || undefined,
    maxTags: env.BLUEPRINT_CONTROL_LOOP_MAX_TAGS || undefined,
    maxNodes: env.BLUEPRINT_CONTROL_LOOP_MAX_NODES || undefined,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new BlueprintControlLoopError(`invalid blueprint control-loop configuration — ${detail}`);
  }
  return parsed.data;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export type BlueprintControlLoopState = "disabled" | "stopped" | "running" | "failed";

/**
 * Point-in-time view of the loop. Declared as a type alias (not an interface) so
 * it is assignable to `Record<string, unknown>` for the health surface.
 */
export type BlueprintControlLoopStatus = {
  readonly state: BlueprintControlLoopState;
  /** Configuration asked for the loop. */
  readonly enabled: boolean;
  /** The scan timer is currently armed. */
  readonly running: boolean;
  readonly definitionPath: string | null;
  readonly blueprintId: string | null;
  readonly blueprintName: string | null;
  readonly scanPeriodMs: number | null;
  readonly ticks: number;
  readonly lastTickDurationMs: number | null;
  readonly missedDeadlines: number;
  /** A deadline was missed recently enough to still count as degraded. */
  readonly missedDeadlineRecently: boolean;
  readonly overruns: number;
  readonly windowSamples: number;
  readonly p50Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
  readonly loadFailures: number;
  readonly lastError: string | null;
  /**
   * Always false. The host executes compiled control logic but has no field
   * write path — see the module header. Reported so operators can confirm the
   * boundary from /health instead of having to read the source.
   */
  readonly actuatesOutputs: false;
};

// ─── The host ─────────────────────────────────────────────────────────────────

export class BlueprintControlLoop {
  private readonly config: BlueprintControlLoopConfig;
  private readonly configError: string | null;

  private state: BlueprintControlLoopState;
  private program: CompiledBlueprint | null = null;
  private runtime: BlueprintRuntime | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Bound once in the constructor: the timer must not allocate a closure per arm. */
  private readonly onTimer: () => void;

  private periodMs = 0;
  private jitterToleranceMs = 0;

  // ── Telemetry (plain numbers; updated from the hot callback) ──
  private tickCount = 0;
  private lastTickDurationMs = Number.NaN;
  private missedDeadlines = 0;
  private overruns = 0;
  private loadFailures = 0;
  private lastError: string | null = null;
  private nextDeadlineAt = 0;
  private lastMissedDeadlineAt = Number.NaN;
  private lastPublishAt = 0;

  // ── Pre-allocated sampling window (allocated once, never resized) ──
  private readonly window: Float64Array;
  private readonly windowScratch: Float64Array;
  private windowHead = 0;
  private windowCount = 0;

  // ── Metric bookkeeping ──
  /** Reused label object so publication does not allocate one per cycle. */
  private metricLabels: { blueprint: string } = { blueprint: "" };
  private publishedTicks = 0;
  private publishedMissed = 0;
  private publishedOverruns = 0;
  private publishedLoadFailures = 0;
  private disabledLogged = false;

  constructor(config: BlueprintControlLoopConfig, configError: string | null = null) {
    this.config = config;
    this.configError = configError;
    if (configError !== null) {
      this.state = "failed";
      this.lastError = configError;
      this.loadFailures = 1;
    } else {
      this.state = config.enabled ? "stopped" : "disabled";
    }
    this.window = new Float64Array(config.latencyWindowSamples);
    this.windowScratch = new Float64Array(config.latencyWindowSamples);
    this.onTimer = () => {
      this.tickOnce();
    };
  }

  /**
   * A loop that could not even parse its own configuration. It is permanently
   * disabled and reports the reason; it exists so a bad env var degrades to
   * "off, and here is why" instead of an exception during module wiring.
   */
  static failedToConfigure(err: unknown): BlueprintControlLoop {
    return new BlueprintControlLoop(
      BlueprintControlLoopConfigSchema.parse({}),
      describeError(err),
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Load (once) and arm the scan timer.
   *
   * Idempotent: calling it on a running loop is a no-op that returns `true`.
   *
   * @returns `true` when the loop is running on return; `false` when it is
   *   disabled by configuration or permanently misconfigured.
   * @throws {BlueprintControlLoopError} when enabled but the blueprint cannot be
   *   loaded. The loop fails CLOSED: it stays stopped and no timer is armed.
   *   Use {@link tryStart} at composition sites that must not be taken down by a
   *   bad blueprint.
   */
  start(): boolean {
    if (this.state === "running") return true;

    if (this.configError !== null) {
      this.publishMetrics();
      return false;
    }

    if (!this.config.enabled) {
      if (!this.disabledLogged) {
        this.disabledLogged = true;
        log(
          "Blueprint control loop disabled (set BLUEPRINT_CONTROL_LOOP_ENABLED=true and " +
            "BLUEPRINT_CONTROL_LOOP_DEFINITION=<path to blueprint json> to enable)",
        );
      }
      this.publishMetrics();
      return false;
    }

    if (this.runtime === null) {
      try {
        this.load();
      } catch (err) {
        this.state = "failed";
        this.lastError = describeError(err);
        this.loadFailures++;
        this.publishMetrics();
        throw err instanceof BlueprintControlLoopError
          ? err
          : new BlueprintControlLoopError(this.lastError);
      }
    }

    const now = performance.now();
    this.nextDeadlineAt = now + this.periodMs;
    this.lastPublishAt = now;
    this.state = "running";
    this.lastError = null;
    this.timer = setInterval(this.onTimer, this.periodMs);
    this.publishMetrics();

    log(
      `Blueprint control loop started: blueprint="${this.program?.id ?? "?"}" ` +
        `period=${this.periodMs}ms instructions=${this.program?.instructionCount ?? 0} ` +
        `tags=${this.program?.tagCount ?? 0} (execution only — no field write path)`,
    );
    return true;
  }

  /**
   * Start, failing closed. A configuration or blueprint-load error is recorded,
   * logged and swallowed so a malformed blueprint can never take down server
   * startup. This is the entry point server composition uses.
   */
  tryStart(): boolean {
    try {
      return this.start();
    } catch (err) {
      logError(err, "Blueprint control loop refused to start (failing closed; loop is OFF)");
      return false;
    }
  }

  /**
   * Disarm the scan timer. Idempotent.
   *
   * Draining is trivially complete on return: `tickFast()` is fully synchronous
   * and JavaScript is single-threaded, so no scan can be in flight once
   * `clearInterval` has run. Counters and the compiled program are retained so
   * post-stop health/metrics still report truthfully what happened.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.state === "running") {
      this.state = "stopped";
      log(`Blueprint control loop stopped after ${this.tickCount} scan(s)`);
    }
    this.publishMetrics();
  }

  // ─── Load ───────────────────────────────────────────────────────────────────

  /**
   * Read → size-check → validate → compile → pre-allocate. Every failure mode
   * raises {@link BlueprintControlLoopError} naming the file and the reason.
   */
  private load(): void {
    const path = this.config.definitionPath;
    if (path === null) {
      throw new BlueprintControlLoopError(
        "BLUEPRINT_CONTROL_LOOP_ENABLED=true requires BLUEPRINT_CONTROL_LOOP_DEFINITION " +
          "to point at a blueprint definition JSON file",
      );
    }

    let byteSize: number;
    try {
      byteSize = statSync(path).size;
    } catch (err) {
      throw new BlueprintControlLoopError(
        `cannot stat blueprint definition "${path}": ${describeError(err)}`,
      );
    }
    if (byteSize > this.config.maxDefinitionBytes) {
      throw new BlueprintControlLoopError(
        `blueprint definition "${path}" is ${byteSize} bytes, exceeding the configured ` +
          `maximum of ${this.config.maxDefinitionBytes} bytes`,
      );
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      throw new BlueprintControlLoopError(
        `cannot read blueprint definition "${path}": ${describeError(err)}`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      throw new BlueprintControlLoopError(
        `blueprint definition "${path}" is not valid JSON: ${describeError(err)}`,
      );
    }

    let def: BlueprintDefinition;
    try {
      def = parseBlueprintDefinition(raw, {
        maxTags: this.config.maxTags,
        maxNodes: this.config.maxNodes,
      });
    } catch (err) {
      throw new BlueprintControlLoopError(
        `blueprint definition "${path}" rejected: ${describeError(err)}`,
      );
    }

    if (this.config.periodMsOverride !== null) {
      def = { ...def, scanPeriodMs: this.config.periodMsOverride };
    }

    let program: CompiledBlueprint;
    try {
      program = compileBlueprint(def);
    } catch (err) {
      throw new BlueprintControlLoopError(
        `blueprint "${def.id}" from "${path}" failed to compile: ${describeError(err)}`,
      );
    }

    // Everything below allocates ONCE, here, at load time.
    this.program = program;
    this.runtime = new BlueprintRuntime(program);
    this.periodMs = program.scanPeriodMs;
    this.jitterToleranceMs =
      this.config.jitterToleranceMsOverride ?? Math.max(1, this.periodMs * 0.25);
    this.metricLabels = { blueprint: program.id };
  }

  // ─── Hot path ───────────────────────────────────────────────────────────────

  /**
   * One scheduled scan.
   *
   * Everything up to and including the `this.window[head] = durationMs` store is
   * allocation-free: numeric locals, typed-array writes and counter increments
   * only. The trailing `publishMetrics()` call is throttled to at most once per
   * `metricsPublishIntervalMs` and DOES allocate (subarray views + registry
   * label keys) — see the module header. It runs after the scan duration has
   * already been recorded, so it can never inflate a measured scan.
   */
  private tickOnce(): void {
    const rt = this.runtime;
    if (rt === null) return;

    const startedAt = performance.now();

    // A missed deadline is an inter-arrival gap larger than period + tolerance;
    // the reference is the previous callback entry, so one late scan is counted
    // once rather than poisoning every subsequent scan.
    if (startedAt - this.nextDeadlineAt > this.jitterToleranceMs) {
      this.missedDeadlines++;
      this.lastMissedDeadlineAt = startedAt;
    }

    rt.tickFast();

    const durationMs = performance.now() - startedAt;
    this.lastTickDurationMs = durationMs;
    this.tickCount++;
    if (durationMs > this.periodMs) this.overruns++;

    const head = this.windowHead;
    this.window[head] = durationMs;
    this.windowHead = head + 1 === this.window.length ? 0 : head + 1;
    if (this.windowCount < this.window.length) this.windowCount++;

    this.nextDeadlineAt = startedAt + this.periodMs;

    if (startedAt - this.lastPublishAt >= this.config.metricsPublishIntervalMs) {
      this.lastPublishAt = startedAt;
      this.publishMetrics();
    }
  }

  // ─── IO surface (called between scans, never inside one) ────────────────────

  /**
   * Bulk-write the input tags, in `inputSlots` order. Allocation-free.
   *
   * Safe to call from anywhere on the event loop: `tickFast()` is synchronous,
   * so a caller necessarily runs BETWEEN scans and can never observe or produce
   * a half-updated tag buffer.
   *
   * This is the field-IN direction only. There is no corresponding field-OUT
   * (actuation) method anywhere in this class — see the module header.
   */
  writeInputs(values: Float64Array): void {
    this.requireRuntime().writeInputs(values);
  }

  /** Bulk-read the output tags into a caller-supplied buffer. Allocation-free. */
  readOutputs(destination: Float64Array): void {
    this.requireRuntime().readOutputs(destination);
  }

  /** Read a single tag by name (diagnostics — uses the name→slot Map). */
  getTagValue(name: string): number {
    return this.requireRuntime().get(name);
  }

  /** Number of input slots of the loaded blueprint (buffer sizing). */
  get inputCount(): number {
    return this.requireRuntime().inputCount;
  }

  /** Number of output slots of the loaded blueprint (buffer sizing). */
  get outputCount(): number {
    return this.requireRuntime().outputCount;
  }

  get isRunning(): boolean {
    return this.state === "running";
  }

  private requireRuntime(): BlueprintRuntime {
    const rt = this.runtime;
    if (rt === null) {
      throw new BlueprintControlLoopError("blueprint control loop has no loaded blueprint");
    }
    return rt;
  }

  // ─── Observability ──────────────────────────────────────────────────────────

  /** Point-in-time snapshot. Safe to call at any time; does not perturb the loop. */
  status(): BlueprintControlLoopStatus {
    const samples = this.sortWindowIntoScratch();
    return {
      state: this.state,
      enabled: this.config.enabled,
      running: this.state === "running",
      definitionPath: this.config.definitionPath,
      blueprintId: this.program?.id ?? null,
      blueprintName: this.program?.name ?? null,
      scanPeriodMs: this.program === null ? null : this.periodMs,
      ticks: this.tickCount,
      lastTickDurationMs: Number.isNaN(this.lastTickDurationMs) ? null : this.lastTickDurationMs,
      missedDeadlines: this.missedDeadlines,
      missedDeadlineRecently: this.missedDeadlineRecently(),
      overruns: this.overruns,
      windowSamples: samples,
      p50Ms: this.quantile(samples, 50),
      p99Ms: this.quantile(samples, 99),
      maxMs: samples === 0 ? null : this.windowScratch[samples - 1],
      loadFailures: this.loadFailures,
      lastError: this.lastError,
      actuatesOutputs: false,
    };
  }

  private missedDeadlineRecently(): boolean {
    if (Number.isNaN(this.lastMissedDeadlineAt)) return false;
    return performance.now() - this.lastMissedDeadlineAt <= this.config.degradedWindowMs;
  }

  /**
   * Copy the valid part of the ring buffer into the pre-allocated scratch array
   * and sort it in place. Returns the sample count.
   *
   * The ring fills from index 0 and only wraps once full, so the valid region is
   * always `[0, windowCount)`. Called from status()/publishMetrics() only —
   * never from the tick.
   */
  private sortWindowIntoScratch(): number {
    const n = this.windowCount;
    if (n === 0) return 0;
    const view = this.windowScratch.subarray(0, n);
    view.set(this.window.subarray(0, n));
    view.sort();
    return n;
  }

  /** Nearest-rank percentile over the already-sorted scratch prefix. */
  private quantile(sampleCount: number, percentile: number): number | null {
    if (sampleCount === 0) return null;
    const rank = Math.ceil((percentile / 100) * sampleCount);
    const index = Math.min(sampleCount - 1, Math.max(0, rank - 1));
    return this.windowScratch[index];
  }

  /**
   * Mirror the loop's numeric state onto the shared Prometheus registry.
   * Deliberately NOT called per tick — see ./metrics.ts for why.
   */
  private publishMetrics(): void {
    blueprintControlLoopEnabled.set(this.config.enabled ? 1 : 0);
    blueprintControlLoopRunning.set(this.state === "running" ? 1 : 0);

    const loadFailureDelta = this.loadFailures - this.publishedLoadFailures;
    if (loadFailureDelta > 0) {
      blueprintControlLoopLoadFailuresTotal.inc({}, loadFailureDelta);
      this.publishedLoadFailures = this.loadFailures;
    }

    if (this.program === null) return;
    const labels = this.metricLabels;

    const tickDelta = this.tickCount - this.publishedTicks;
    if (tickDelta > 0) {
      blueprintControlLoopTicksTotal.inc(labels, tickDelta);
      this.publishedTicks = this.tickCount;
    }
    const missedDelta = this.missedDeadlines - this.publishedMissed;
    if (missedDelta > 0) {
      blueprintControlLoopMissedDeadlinesTotal.inc(labels, missedDelta);
      this.publishedMissed = this.missedDeadlines;
    }
    const overrunDelta = this.overruns - this.publishedOverruns;
    if (overrunDelta > 0) {
      blueprintControlLoopOverrunsTotal.inc(labels, overrunDelta);
      this.publishedOverruns = this.overruns;
    }

    blueprintControlLoopScanPeriodMs.set(this.periodMs, labels);
    if (!Number.isNaN(this.lastTickDurationMs)) {
      blueprintControlLoopLastTickMs.set(this.lastTickDurationMs, labels);
    }

    const samples = this.sortWindowIntoScratch();
    blueprintControlLoopWindowSamples.set(samples, labels);
    if (samples > 0) {
      blueprintControlLoopTickP50Ms.set(this.quantile(samples, 50) ?? 0, labels);
      blueprintControlLoopTickP99Ms.set(this.quantile(samples, 99) ?? 0, labels);
      blueprintControlLoopTickMaxMs.set(this.windowScratch[samples - 1], labels);
    }
  }
}

// ─── Health surface ───────────────────────────────────────────────────────────

export interface BlueprintControlLoopHealth {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly message: string;
}

/**
 * Map a status snapshot onto the health vocabulary used by server/health.
 *
 * Rules, chosen so the report is truthful rather than flattering:
 *   - not configured to run        → healthy ("off" is not a fault)
 *   - configuration/load failed    → unhealthy, carrying the reason
 *   - asked to run but not running → degraded
 *   - running, deadline missed recently → degraded (self-clears after the window)
 *   - running cleanly              → healthy
 */
export function describeBlueprintControlLoopHealth(
  status: BlueprintControlLoopStatus,
): BlueprintControlLoopHealth {
  if (status.state === "failed") {
    return {
      status: "unhealthy",
      message: status.lastError ?? "blueprint control loop failed to load",
    };
  }
  if (!status.enabled) {
    return {
      status: "healthy",
      message: "disabled (set BLUEPRINT_CONTROL_LOOP_ENABLED=true to enable)",
    };
  }
  if (!status.running) {
    return { status: "degraded", message: "enabled by configuration but not running" };
  }
  if (status.missedDeadlineRecently) {
    return {
      status: "degraded",
      message: `running with ${status.missedDeadlines} missed scan deadline(s)`,
    };
  }
  return {
    status: "healthy",
    message: `running ${status.blueprintId ?? "?"} every ${status.scanPeriodMs ?? 0}ms (execution only, no actuation)`,
  };
}

// ─── Singleton wiring (mirrors server/services/flux/index.ts) ─────────────────

let _loop: BlueprintControlLoop | null = null;

/**
 * Get or create the process-wide control loop. Never throws: an unparseable
 * configuration yields a permanently-disabled loop that reports why.
 */
export function getBlueprintControlLoop(): BlueprintControlLoop {
  if (_loop === null) {
    try {
      _loop = new BlueprintControlLoop(loadBlueprintControlLoopConfig());
    } catch (err) {
      logError(err, "Blueprint control loop configuration rejected (loop stays OFF)");
      _loop = BlueprintControlLoop.failedToConfigure(err);
    }
  }
  return _loop;
}

/**
 * Start the control loop if configuration enables it. Fails closed and never
 * throws, so server startup cannot be taken down by a bad blueprint.
 */
export function startBlueprintControlLoop(): BlueprintControlLoop {
  const loop = getBlueprintControlLoop();
  loop.tryStart();
  return loop;
}
