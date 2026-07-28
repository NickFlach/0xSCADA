/**
 * Observed-liveness collector and live source (issue #456).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS OBSERVES, AND WHAT IT DELIBERATELY DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Slashing & Liveness Visualizer's what-if simulator needs "actual history"
 * to replay a proposed rule against. Consensus ATTESTATION DUTY OUTCOMES DO NOT
 * EXIST IN THIS BUILD and cannot be manufactured: the oxscada node `GET /status`
 * surface (`server/blockchain/validator-health.ts`) reports node_id, height,
 * role, order_parameter, mean_phase, local_phase, peer_phases[], peers, mempool
 * and uptime_ticks — no per-slot duty result of any kind. `server/blockchain.ts`
 * is a declared stub. The cross-node state surface (#454) is a point-in-time
 * signed read, not a duty log.
 *
 * So this module does not report attestation. It reports what CAN be truthfully
 * observed by polling each configured node on a cadence and recording the result
 * of every round:
 *
 *   - the node answered, or did not      (a genuine liveness observation)
 *   - the height it reported advanced since the previous observation, or did not
 *
 * `uptime_ticks`, `local_phase`, `mean_phase` and the node's self-reported
 * `node_id` are recorded alongside each row so the classification can be
 * audited, but they do NOT drive it. An advancing `uptime_ticks` adds nothing
 * over the fact that the node answered at all, and Kuramoto phase is a
 * coherence measure with no defensible fault threshold here — inventing one
 * would be exactly the kind of estimate this module refuses to make.
 *
 * Every row it writes is a real measurement taken at a real moment. Nothing is
 * computed, estimated, interpolated or randomised — which is why registering it
 * through `registerLiveAttestationSource()` is legitimate under that seam's
 * contract, and why `synthetic: false` on the response is true.
 *
 * It is still NOT consensus attestation, so the name says "liveness" everywhere
 * (source id, table, types, docs, UI) and every response carries a mandatory
 * {@link AttestationSourceDescriptor} spelling out what each status means. If
 * the node ever exposes a real duty log, implement it as a second source with
 * `kind: "consensus-attestation"` — the seam, the route and the UI serve it
 * unchanged.
 *
 * ── STATUS MAPPING, AND WHY ─────────────────────────────────────────────────
 *
 *   miss — the node did not answer this poll round (transport failure, timeout,
 *          non-2xx, oversized body, or an unparseable /status shape).
 *   hit  — the node answered AND the height it reported was strictly greater
 *          than the height of its previous observation.
 *   late — the node answered but the height did not advance, OR this is the
 *          first observation for that node so there is no previous height to
 *          compare against.
 *
 * The mapping is chosen to line up with how the simulator already treats the
 * three statuses, so the projection means what an operator would expect:
 *
 *   - Only `miss` is slashable in `client/src/lib/slashing-simulator.ts`. "The
 *     node did not answer at all" is the strongest liveness signal this build
 *     can observe, and it is the one an operator would want a liveness rule to
 *     bite on. Nothing weaker is mapped to `miss`.
 *   - `late` counts as participation but is flagged. "Answered, but showed no
 *     progress" is exactly that: the node is alive, yet it did not demonstrate
 *     that the chain moved. It is not evidence of a fault on its own, because
 *     whether a height should have advanced depends on the node's block cadence
 *     versus the operator-configured poll cadence. Mapping it to `miss` would
 *     manufacture penalties out of a fast poll interval.
 *   - The FIRST observation of a node is `late`, never `hit`. A single sample
 *     cannot demonstrate progress, and claiming a `hit` from it would be
 *     asserting something that was not observed. The conservative direction is
 *     the honest one; `detail` records that the row is a baseline.
 *   - A height REGRESSION is also `late`, not `miss` — the node answered, so
 *     calling it a miss would be false. The regression is visible in the row's
 *     `previous_height` / `observed_height` and in `detail`.
 *
 * ── BOUNDING AND GATING ─────────────────────────────────────────────────────
 *
 * Outbound requests reuse the bounded transport that already backs
 * `GET /api/validators` (`./validator-dashboard`): the same URL parsing, node
 * cap, per-request timeout covering the body read, response byte cap,
 * concurrency limit and one-attempt-no-retry policy. There is no second fetch
 * path.
 *
 * OFF BY DEFAULT. Nothing is armed unless `VALIDATOR_LIVENESS_COLLECTOR_ENABLED`
 * is exactly `"true"` AND `ANCHOR_NODE_URLS` names at least one node. With no
 * new environment set, no timer exists, no poll happens, no row is written, and
 * `GET /api/nodes/attestation-history` keeps failing closed with 503 exactly as
 * before.
 */

import pino from "pino";
import {
  MAX_NODES,
  loadValidatorDashboardConfig,
  mapWithConcurrency,
  parseNodeUrls,
  pollNodeStatus,
  type DashboardFetch,
} from "./validator-dashboard";
import type { ValidatorNodeView } from "@shared/types/services/validator-dashboard";
import {
  MAX_LIVENESS_OBSERVATION_ROWS,
  appendValidatorLivenessObservations,
  getLatestValidatorLivenessHeights,
  getValidatorLivenessRoundSeqHighWaterMark,
  listValidatorLivenessObservations,
  pruneValidatorLivenessObservations,
  type ValidatorLivenessObservationRecord,
} from "../storage";
import {
  clearLiveAttestationSource,
  registerLiveAttestationSource,
  type LiveAttestationSource,
} from "../routes/nodes";
import {
  WINDOW_MS,
  type AttestationSourceDescriptor,
  type AttestationStatus,
  type TimelineWindow,
  type ValidatorHistory,
} from "@shared/types/slashing";
import { registry } from "../metrics/prometheus";

const logger = pino({ name: "validator-liveness-collector" });

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * Stable id of this source. The word "liveness" is load-bearing: it is what the
 * operator sees in the response `source` field and in the UI.
 */
export const OBSERVED_LIVENESS_SOURCE_ID = "oxscada-observed-liveness";

/** Longest column width the observation table accepts for a validator id. */
const MAX_VALIDATOR_ID_LENGTH = 128;

/**
 * Identity of a polled endpoint: `host[:port][/path]` of the configured URL.
 *
 * Derived OFFLINE, without contacting the node, because the observations that
 * matter most are the ones where the node did not answer and therefore reported
 * no `node_id` of its own. Using the node's self-reported id would leave every
 * `miss` row unattributable.
 *
 * Scheme-less by the same reasoning as `nodeLabel` in ./validator-dashboard: the
 * id reaches the browser, so it identifies a node for troubleshooting without
 * handing the browser something it could fetch. The path is retained so two
 * nodes behind one host:port do not collide.
 */
export function observedValidatorId(nodeUrl: string): string {
  let raw: string;
  try {
    const parsed = new URL(nodeUrl);
    raw = `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    raw = nodeUrl;
  }
  return raw.slice(0, MAX_VALIDATOR_ID_LENGTH);
}

// ─── Configuration ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS_DEFAULT = 60_000;
const POLL_INTERVAL_MS_MIN = 5_000;
const POLL_INTERVAL_MS_MAX = 3_600_000;

/**
 * Default retention equals the longest window the UI offers (7d). Keeping more
 * than the UI can ask for would grow the table for no operator benefit; keeping
 * less would silently shorten the 7d view.
 */
const RETENTION_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;
const RETENTION_MS_MIN = 60 * 60 * 1000;
const RETENTION_MS_MAX = 30 * 24 * 60 * 60 * 1000;

export interface LivenessCollectorConfig {
  /** True only when explicitly opted in AND at least one node is configured. */
  enabled: boolean;
  /** Operator-readable statement of the enabled/disabled decision. */
  reason: string;
  nodeUrls: string[];
  pollIntervalMs: number;
  retentionMs: number;
  timeoutMs: number;
  maxConcurrency: number;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Read the collector configuration from the environment. Pure in `env`.
 *
 * The opt-in must be exactly the string `"true"`: there is no truthy coercion,
 * so a stray `1` / `yes` / `on` cannot start writing observation rows.
 */
export function loadLivenessCollectorConfig(
  env: NodeJS.ProcessEnv = process.env,
): LivenessCollectorConfig {
  const dashboard = loadValidatorDashboardConfig(env);
  const nodeUrls = parseNodeUrls(env.ANCHOR_NODE_URLS);
  const optedIn = env.VALIDATOR_LIVENESS_COLLECTOR_ENABLED === "true";

  let reason: string;
  if (!optedIn) {
    reason =
      "disabled — set VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true to record observed liveness";
  } else if (nodeUrls.length === 0) {
    // Opted in but nothing to poll. Fail closed and say so rather than arming a
    // timer that would record nothing.
    reason =
      "disabled — VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true but ANCHOR_NODE_URLS names no http(s) node";
  } else {
    reason = `enabled — polling ${nodeUrls.length} node(s) (cap ${MAX_NODES})`;
  }

  return {
    enabled: optedIn && nodeUrls.length > 0,
    reason,
    nodeUrls,
    pollIntervalMs: clampInt(
      env.VALIDATOR_LIVENESS_POLL_INTERVAL_MS,
      POLL_INTERVAL_MS_DEFAULT,
      POLL_INTERVAL_MS_MIN,
      POLL_INTERVAL_MS_MAX,
    ),
    retentionMs: clampInt(
      env.VALIDATOR_LIVENESS_RETENTION_MS,
      RETENTION_MS_DEFAULT,
      RETENTION_MS_MIN,
      RETENTION_MS_MAX,
    ),
    timeoutMs: dashboard.timeoutMs,
    maxConcurrency: dashboard.maxConcurrency,
  };
}

// ─── Storage seam ────────────────────────────────────────────────────────────

/**
 * Persistence the collector needs. Backed by `server/storage.ts` in production
 * (both Postgres and the SQLite dev fallback); injectable so the collector can
 * be driven against a real database in tests without a composition root.
 */
export interface LivenessObservationStore {
  append(rows: readonly ValidatorLivenessObservationRecord[]): Promise<void>;
  since(
    fromMs: number,
    validatorId?: string,
  ): Promise<ValidatorLivenessObservationRecord[]>;
  prune(beforeMs: number): Promise<number>;
  maxRoundSeq(): Promise<number>;
  latestHeights(): Promise<Array<{ validatorId: string; observedHeight: number }>>;
}

export const defaultLivenessObservationStore: LivenessObservationStore = {
  append: appendValidatorLivenessObservations,
  since: listValidatorLivenessObservations,
  prune: pruneValidatorLivenessObservations,
  maxRoundSeq: getValidatorLivenessRoundSeqHighWaterMark,
  latestHeights: getLatestValidatorLivenessHeights,
};

// ─── Classification (pure) ───────────────────────────────────────────────────

export interface ObservationClassification {
  status: AttestationStatus;
  /** Bounded, human-readable justification stored alongside the row. */
  detail: string;
}

/**
 * Classify one polled node view against the height of its previous observation.
 *
 * PURE — it reads only its arguments. See the module header for the reasoning
 * behind each branch. `previousHeight` is `null` when this validator has never
 * been observed answering; that produces a `late` baseline rather than a `hit`,
 * because a single sample demonstrates no progress.
 */
export function classifyObservation(
  view: ValidatorNodeView,
  previousHeight: number | null,
): ObservationClassification {
  if (!view.reachable || view.status === null) {
    return {
      status: "miss",
      detail: `no answer: ${view.error ?? "unknown transport failure"}`.slice(0, 240),
    };
  }

  const height = view.status.height;
  if (previousHeight === null) {
    return {
      status: "late",
      detail:
        `baseline: answered at height ${height}; no previous observation to ` +
        "compare against, so progress was not demonstrated",
    };
  }
  if (height > previousHeight) {
    return {
      status: "hit",
      detail: `height advanced ${previousHeight} -> ${height}`,
    };
  }
  return {
    status: "late",
    detail:
      `answered, but height did not advance (previous ${previousHeight}, ` +
      `observed ${height})`,
  };
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

const livenessRoundsTotal = registry.counter(
  "validator_liveness_rounds_total",
  "Poll rounds whose observations were successfully persisted",
);
const livenessObservationsTotal = registry.counter(
  "validator_liveness_observations_total",
  "Liveness observations persisted, by recorded status",
  ["status"],
);
const livenessStorageFailuresTotal = registry.counter(
  "validator_liveness_storage_failures_total",
  "Poll rounds whose observations could not be persisted",
);
const livenessRetentionFailuresTotal = registry.counter(
  "validator_liveness_retention_failures_total",
  "Retention prunes that failed",
);
const livenessRowsPrunedTotal = registry.counter(
  "validator_liveness_rows_pruned_total",
  "Observation rows deleted by retention",
);
const livenessCollectorRunning = registry.gauge(
  "validator_liveness_collector_running",
  "Whether the observed-liveness collector has a poll timer armed (1/0)",
);

// ─── Collector ───────────────────────────────────────────────────────────────

export interface LivenessCollectorStatus {
  enabled: boolean;
  /** Whether a poll timer is currently armed. */
  running: boolean;
  reason: string;
  sourceId: string;
  nodeCount: number;
  pollIntervalMs: number;
  retentionMs: number;
  /** Rounds whose observations were persisted. */
  roundsRecorded: number;
  /** Rounds skipped because the previous round was still in flight. */
  roundsSkipped: number;
  /** Observations recorded as `miss` (the node did not answer). */
  observedMisses: number;
  /** Rounds whose observations could NOT be persisted. */
  storageFailures: number;
  retentionFailures: number;
  rowsPruned: number;
  lastRoundAt: number | null;
  /** Most recent failure message, retained so a failure is not invisible. */
  lastError: string | null;
}

export interface LivenessCollectorDeps {
  config?: LivenessCollectorConfig;
  store?: LivenessObservationStore;
  /** Injectable transport, forwarded to the shared bounded poller. */
  fetchImpl?: DashboardFetch;
  /** Injectable clock so cadence and retention are testable without sleeping. */
  now?: () => number;
}

/**
 * Polls the configured nodes on a cadence and persists one observation per node
 * per round.
 *
 * Lifecycle contract:
 *   - `start()` is idempotent; calling it twice arms exactly one timer.
 *   - `stop()` clears the timer and awaits any round still in flight, so a test
 *     that stops the collector leaves nothing running and nothing writing.
 *   - a failing node degrades to a `miss` observation; it never throws out of a
 *     round (the shared `pollNodeStatus` never throws by construction).
 *   - a storage failure is logged, counted, exposed on `status()` and exported
 *     as a Prometheus counter — never silently swallowed.
 */
export class ValidatorLivenessCollector {
  private readonly config: LivenessCollectorConfig;
  private readonly store: LivenessObservationStore;
  private readonly fetchImpl: DashboardFetch | undefined;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** The round currently executing, retained so `stop()` can await it. */
  private inFlight: Promise<void> | null = null;
  /** Guard against a timer firing while the previous round is still running. */
  private inFlightRound = false;
  private primed = false;
  private nextRoundSeq = 1;
  /** Last height actually observed per validator; seeded from the store. */
  private readonly lastHeight = new Map<string, number>();

  private roundsRecorded = 0;
  private roundsSkipped = 0;
  private observedMisses = 0;
  private storageFailures = 0;
  private retentionFailures = 0;
  private rowsPruned = 0;
  private lastRoundAt: number | null = null;
  private lastError: string | null = null;

  constructor(deps: LivenessCollectorDeps = {}) {
    this.config = deps.config ?? loadLivenessCollectorConfig();
    this.store = deps.store ?? defaultLivenessObservationStore;
    this.fetchImpl = deps.fetchImpl;
    this.now = deps.now ?? (() => Date.now());
  }

  getConfig(): LivenessCollectorConfig {
    return this.config;
  }

  status(): LivenessCollectorStatus {
    return {
      enabled: this.config.enabled,
      running: this.timer !== null,
      reason: this.config.reason,
      sourceId: OBSERVED_LIVENESS_SOURCE_ID,
      nodeCount: this.config.nodeUrls.length,
      pollIntervalMs: this.config.pollIntervalMs,
      retentionMs: this.config.retentionMs,
      roundsRecorded: this.roundsRecorded,
      roundsSkipped: this.roundsSkipped,
      observedMisses: this.observedMisses,
      storageFailures: this.storageFailures,
      retentionFailures: this.retentionFailures,
      rowsPruned: this.rowsPruned,
      lastRoundAt: this.lastRoundAt,
      lastError: this.lastError,
    };
  }

  /**
   * Prime the round ordinal and the per-validator height baseline from the
   * store. Runs once. Doing this BEFORE the first round is what makes the
   * history continuous across a restart: without it the collector would reuse
   * round ordinals already in the window and would treat every node as a
   * never-before-seen baseline.
   */
  private async prime(): Promise<void> {
    if (this.primed) return;
    const [highWaterMark, heights] = await Promise.all([
      this.store.maxRoundSeq(),
      this.store.latestHeights(),
    ]);
    this.nextRoundSeq = highWaterMark + 1;
    for (const entry of heights) {
      this.lastHeight.set(entry.validatorId, entry.observedHeight);
    }
    this.primed = true;
  }

  /**
   * Arm the poll timer. Idempotent, and a no-op when the feature is not opted
   * in. Priming happens before the timer is armed, so a store that cannot be
   * read leaves the collector unarmed rather than writing from a wrong baseline.
   */
  async start(): Promise<LivenessCollectorStatus> {
    if (this.timer !== null) return this.status();
    if (!this.config.enabled) {
      logger.info({ reason: this.config.reason }, "observed-liveness collector not started");
      return this.status();
    }

    await this.prime();

    this.timer = setInterval(() => {
      // `runRound()` publishes the round it actually starts on `this.inFlight`,
      // so `stop()` awaits a timer-fired round too, not just the first one.
      // Assigning the returned promise here instead would be wrong: a tick that
      // lands while a slow round is still running is SKIPPED and resolves
      // immediately, which would overwrite the real round's promise and let
      // `stop()` return while that round was still writing.
      void this.runRoundSafely();
    }, this.config.pollIntervalMs);
    // Never keep the process alive just to poll.
    this.timer.unref?.();
    livenessCollectorRunning.set(1);

    logger.info(
      {
        nodes: this.config.nodeUrls.length,
        pollIntervalMs: this.config.pollIntervalMs,
        retentionMs: this.config.retentionMs,
        nextRoundSeq: this.nextRoundSeq,
      },
      "observed-liveness collector started (liveness observations only — not consensus attestation)",
    );

    // Record a first round immediately, but do not block startup on it.
    // `runRound()` retains it on `this.inFlight` so `stop()` can await it.
    void this.runRoundSafely();
    return this.status();
  }

  /** Clear the timer and await any in-flight round. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    livenessCollectorRunning.set(0);
    const pending = this.inFlight;
    this.inFlight = null;
    if (pending) await pending;
  }

  private runRoundSafely(): Promise<void> {
    return this.runRound().catch((err: unknown) => {
      // runRound already handles poll and storage failures; reaching here means
      // something unexpected, which must still not kill the timer.
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      logger.error({ err: message }, "observed-liveness round failed unexpectedly");
    });
  }

  /**
   * Poll every configured node once and persist one observation each.
   *
   * Public so tests can drive rounds deterministically instead of waiting on a
   * timer. Overlapping invocations are skipped rather than queued: a fleet that
   * is slower than the poll interval must not accumulate rounds.
   */
  async runRound(): Promise<void> {
    if (this.inFlightRound) {
      this.roundsSkipped += 1;
      return;
    }
    this.inFlightRound = true;
    // Publish the round that is actually starting, so `stop()` awaits THIS one.
    // A skipped tick returns above without touching `inFlight`, so it can never
    // mask a round that is still writing.
    const running = this.executeRound();
    // `stop()` must not reject just because a round did — failures are already
    // counted, logged and exported — so what it awaits is a settled-either-way
    // view of the same round. `await running` below still propagates to a test
    // that drives rounds directly.
    this.inFlight = running.then(
      () => undefined,
      () => undefined,
    );
    await running;
  }

  private async executeRound(): Promise<void> {
    try {
      await this.prime();
      await this.collectAndPersist();
    } finally {
      this.inFlightRound = false;
    }
  }

  private async collectAndPersist(): Promise<void> {
    const roundSeq = this.nextRoundSeq;
    this.nextRoundSeq += 1;
    const observedAtMs = this.now();
    const observedAt = new Date(observedAtMs);

    const views = await mapWithConcurrency(
      this.config.nodeUrls,
      this.config.maxConcurrency,
      (nodeUrl) =>
        pollNodeStatus(nodeUrl, {
          timeoutMs: this.config.timeoutMs,
          fetchImpl: this.fetchImpl,
          now: this.now,
        }),
    );

    const rows: ValidatorLivenessObservationRecord[] = views.map((view, index) => {
      const nodeUrl = this.config.nodeUrls[index];
      const validatorId = observedValidatorId(nodeUrl);
      const previousHeight = this.lastHeight.get(validatorId) ?? null;
      const { status, detail } = classifyObservation(view, previousHeight);
      const observed = view.status;
      return {
        validatorId,
        observedAt,
        roundSeq,
        status,
        sourceNodeUrl: nodeUrl,
        // Absent observations stay absent: nothing is carried forward from an
        // earlier round when the node did not answer.
        observedHeight: observed ? observed.height : null,
        previousHeight,
        observedUptimeTicks: observed ? observed.uptimeTicks : null,
        reportedNodeId: observed ? observed.nodeId.slice(0, 128) : null,
        localPhase: observed ? observed.localPhase : null,
        meanPhase: observed ? observed.reportedMeanPhase : null,
        detail,
      };
    });

    try {
      await this.store.append(rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.storageFailures += 1;
      this.lastError = message;
      livenessStorageFailuresTotal.inc();
      logger.error(
        { err: message, roundSeq, rows: rows.length },
        "observed-liveness observations could not be persisted; this round is lost",
      );
      return;
    }

    // Advance the in-memory baseline only after a successful write, so it can
    // never drift from what the table actually holds.
    for (const row of rows) {
      if (row.observedHeight !== null) {
        this.lastHeight.set(row.validatorId, row.observedHeight);
      }
      livenessObservationsTotal.inc({ status: row.status });
      if (row.status === "miss") this.observedMisses += 1;
    }
    this.roundsRecorded += 1;
    this.lastRoundAt = observedAtMs;
    livenessRoundsTotal.inc();

    await this.pruneRetention(observedAtMs);
  }

  /** Enforce retention so the table cannot grow without bound. */
  private async pruneRetention(nowMs: number): Promise<void> {
    try {
      const deleted = await this.store.prune(nowMs - this.config.retentionMs);
      if (deleted > 0) {
        this.rowsPruned += deleted;
        livenessRowsPrunedTotal.inc({}, deleted);
        logger.debug({ deleted }, "pruned observed-liveness rows beyond retention");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.retentionFailures += 1;
      this.lastError = message;
      livenessRetentionFailuresTotal.inc();
      logger.error({ err: message }, "observed-liveness retention prune failed");
    }
  }
}

// ─── Live source ─────────────────────────────────────────────────────────────

/**
 * Placeholder stake for observed-liveness histories.
 *
 * There is NO stake source in this build — `/status` reports no balance and no
 * staking contract is read anywhere — so a stake figure here would be invented.
 * It is reported as 0 and the descriptor declares `stake.available: false`, and
 * the UI renders the penalty as a percentage only. The percentage is the real
 * output of the simulator; the absolute amount is not computable and is not
 * pretended to be.
 */
const STAKE_NOT_OBSERVED = 0;

/**
 * Group observation rows into the per-validator shape the simulator consumes.
 * PURE. Records come out ascending by round ordinal (and therefore by time).
 */
export function toValidatorHistories(
  rows: readonly ValidatorLivenessObservationRecord[],
): ValidatorHistory[] {
  const byId = new Map<string, ValidatorHistory>();
  for (const row of rows) {
    let history = byId.get(row.validatorId);
    if (!history) {
      history = {
        validatorId: row.validatorId,
        // The suffix survives a screenshot or a copy/paste out of the JSON, the
        // same reasoning as the demo feed's "(demo)".
        label: `${row.validatorId} (observed liveness)`,
        stake: STAKE_NOT_OBSERVED,
        records: [],
      };
      byId.set(row.validatorId, history);
    }
    history.records.push({
      slot: row.roundSeq,
      timestamp: row.observedAt.getTime(),
      status: row.status,
      observedHeight: row.observedHeight,
    });
  }

  const histories = [...byId.values()];
  histories.sort((a, b) => a.validatorId.localeCompare(b.validatorId));
  for (const history of histories) {
    history.records.sort((a, b) => a.slot - b.slot);
  }
  return histories;
}

/**
 * Build the mandatory semantics declaration served with every live response.
 * Pure in its configuration, so the descriptor cannot drift from the cadence
 * and retention actually in force.
 */
export function buildObservedLivenessDescriptor(
  config: LivenessCollectorConfig,
): AttestationSourceDescriptor {
  return {
    kind: "observed-liveness",
    sourceId: OBSERVED_LIVENESS_SOURCE_ID,
    summary:
      "Observed liveness of each configured oxscada node: whether it answered " +
      "each poll round, and whether the chain height it reported advanced. " +
      "These are not consensus attestation duties.",
    method: {
      transport: "http-get",
      endpoint: "/status",
      fields: ["height", "uptime_ticks", "local_phase", "mean_phase", "node_id"],
      pollIntervalMs: config.pollIntervalMs,
      retentionMs: config.retentionMs,
      maxRecordsPerQuery: MAX_LIVENESS_OBSERVATION_ROWS,
    },
    statusSemantics: {
      hit:
        "The node answered this poll round and the chain height it reported was " +
        "strictly greater than the height of its previous observation.",
      miss:
        "The node did not answer this poll round — transport failure, timeout, " +
        "non-2xx response, oversized body, or an unparseable /status payload. " +
        "This is NOT a missed consensus attestation duty; no duty outcome is " +
        "observable in this build.",
      late:
        "The node answered but the height it reported did not advance, or this " +
        "was its first observation so no previous height existed to compare " +
        "against. Whether a stalled height indicates a fault depends on the " +
        "node's block cadence versus the configured poll cadence.",
    },
    roundIdentifier: {
      field: "slot",
      meaning:
        "Monotonic ordinal of the poll round that produced the record — not a " +
        "consensus slot. The chain height actually read is carried separately " +
        "as `observedHeight`, and is null when the node did not answer.",
    },
    stake: {
      available: false,
      note:
        "No stake source exists in this build, so stake is reported as 0 and " +
        "absolute penalty amounts are not computed. Projected penalties are " +
        "meaningful as a percentage of stake only.",
    },
    consensusAttestation: {
      available: false,
      note:
        "Consensus attestation duty history remains unavailable: the oxscada " +
        "/status surface exposes no per-slot duty outcome and nothing else in " +
        "this build records one. If a node ever exposes a duty log, it can be " +
        "served through this same seam with kind 'consensus-attestation' and " +
        "no route or UI change.",
    },
  };
}

/**
 * The registered live source. Reads persisted observations for the requested
 * window; it computes no outcome of its own and substitutes nothing when the
 * table is empty (an empty window is reported as an empty window).
 */
export class ObservedLivenessSource implements LiveAttestationSource {
  readonly id = OBSERVED_LIVENESS_SOURCE_ID;
  readonly descriptor: AttestationSourceDescriptor;

  constructor(
    private readonly store: LivenessObservationStore,
    config: LivenessCollectorConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.descriptor = buildObservedLivenessDescriptor(config);
  }

  async history(
    window: TimelineWindow,
    validatorId?: string,
  ): Promise<ValidatorHistory[]> {
    const fromMs = this.now() - WINDOW_MS[window];
    const rows = await this.store.since(fromMs, validatorId);
    if (rows.length >= MAX_LIVENESS_OBSERVATION_ROWS) {
      logger.warn(
        { window, rows: rows.length, cap: MAX_LIVENESS_OBSERVATION_ROWS },
        "observed-liveness window hit the row cap; the oldest part of the window is not included",
      );
    }
    return toValidatorHistories(rows);
  }
}

// ─── Composition root ────────────────────────────────────────────────────────

let activeCollector: ValidatorLivenessCollector | null = null;

export type StartLivenessCollectorOptions = LivenessCollectorDeps;

/**
 * Start the collector and, only if it actually started, register its source so
 * `GET /api/nodes/attestation-history` serves it with `synthetic: false`.
 *
 * With no new environment set this returns a disabled status, registers
 * nothing, and the live route keeps failing closed with 503.
 */
export async function startValidatorLivenessCollector(
  options: StartLivenessCollectorOptions = {},
): Promise<LivenessCollectorStatus> {
  if (activeCollector) return activeCollector.status();

  const config = options.config ?? loadLivenessCollectorConfig();
  const collector = new ValidatorLivenessCollector({ ...options, config });
  if (!config.enabled) {
    logger.info({ reason: config.reason }, "observed-liveness collector disabled");
    return collector.status();
  }

  const status = await collector.start();
  activeCollector = collector;

  const store = options.store ?? defaultLivenessObservationStore;
  registerLiveAttestationSource(
    new ObservedLivenessSource(store, config, options.now ?? (() => Date.now())),
  );
  logger.info(
    { source: OBSERVED_LIVENESS_SOURCE_ID },
    "registered observed-liveness source for GET /api/nodes/attestation-history",
  );
  return status;
}

/** Stop the collector and unregister its source. Safe to call when never started. */
export async function stopValidatorLivenessCollector(): Promise<void> {
  const collector = activeCollector;
  activeCollector = null;
  if (collector) await collector.stop();
  clearLiveAttestationSource();
}

/** Current collector status, or null when nothing was started. */
export function getValidatorLivenessCollectorStatus(): LivenessCollectorStatus | null {
  return activeCollector ? activeCollector.status() : null;
}
