/**
 * Replica coordination for alarm correlation
 * ADR-0026 / ADR-0013 [13.2] — Issue #573
 *
 * #213 shipped a correlation engine whose suppression defaults OFF because its
 * state lives in one process's heap. This module is what makes that state
 * durable and agreed across replicas, so suppression can be turned on without
 * an operator losing sight of an alarm.
 *
 * ─── HOW REPLICAS AGREE ────────────────────────────────────────────────────
 *
 * Every correlation-affecting operation is appended to one shared, totally
 * ordered journal (`store.append`). Each replica consumes that journal in `seq`
 * order and applies each entry to its own engine. The engine is deterministic
 * given an ordered operation stream, and group ids are derived from the journal
 * `seq` rather than a per-process random source, so two replicas that have
 * consumed the same prefix hold byte-identical membership, root cause and
 * suppression — including identical group ids.
 *
 * This is convergence by shared log, NOT an order-independent merge. Which
 * replica an HTTP request lands on cannot change the outcome, because the log,
 * not the arrival, defines the order. The engine remains order-sensitive in
 * general (arrival order decides partitioning when a safety cap bites); what
 * this module guarantees is that every replica sees the SAME order.
 *
 * ─── THE SAFETY PROPERTY ───────────────────────────────────────────────────
 *
 * Coordination or storage loss must never hide an alarm. Three mechanisms, in
 * order of importance:
 *
 *   1. `submit()` rethrows on any store failure so the caller falls back to
 *      raw, uncorrelated delivery. An alarm is delivered even when nothing
 *      about it can be persisted.
 *   2. Any failure calls `degrade()`, which immediately forces suppression off
 *      in the engine. That un-suppresses every suppressed member and re-emits
 *      it, so alarms an operator could not see become visible again.
 *   3. Suppression is only ever re-enabled by `syncEnginePolicy()`, which
 *      requires BOTH a healthy coordinator and the operator's persisted intent.
 *      Health alone never enables it, and intent alone never enables it.
 *
 * The asymmetry is deliberate and one-way: losing coordination can only reveal
 * more alarms, never fewer.
 */

import { EventEmitter } from "events";
import { randomUUID } from "node:crypto";
import type {
  AlarmGroup,
  CorrelatedAlarm,
  CorrelationCoordinationHealth,
  CorrelationJournalEntry,
  CorrelationJournalOp,
  CorrelationRule,
  EquipmentNode,
  IngestResult,
  SuppressionPolicy,
} from "@shared/types/alarm-correlation";
import { AlarmCorrelationEngine } from "./engine";
import { CorrelationRulesEngine, DEFAULT_RULES } from "./rules";
import { EquipmentTopology } from "./topology";
import {
  emptyProjectionChanges,
  type CorrelationStore,
  type PersistedAlarm,
  type ProjectionChanges,
} from "./store";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Bounds the transient map that carries per-submit results back to callers. */
const MAX_AWAITED_RESULTS = 1000;

export interface CoordinatorOptions {
  store: CorrelationStore;
  engine?: AlarmCorrelationEngine;
  /** Identifies this replica in journal rows. Diagnostic only — never ordering. */
  instanceId?: string;
  /** How often to pull entries appended by other replicas. */
  pollIntervalMs?: number;
  journalRetentionMs?: number;
  stateRetentionMs?: number;
  pruneIntervalMs?: number;
  clock?: () => number;
  /** Engine construction options other than the seq-derived group id factory. */
  engineOptions?: ConstructorParameters<typeof AlarmCorrelationEngine>[0];
}

export interface SubmitResult<T> {
  seq: number;
  /** False when this exact operation was already in the journal. */
  created: boolean;
  /**
   * Outcome of applying the entry, when this replica was the one that applied
   * it during this call. Absent for a duplicate submission whose entry had
   * already been applied — the caller reads current engine state instead.
   */
  outcome?: T;
}

type ApplyOutcome =
  | { kind: "ingest"; result: IngestResult }
  | { kind: "acknowledge"; acknowledged: boolean }
  | { kind: "clear"; result: ReturnType<AlarmCorrelationEngine["alarmCleared"]> }
  | { kind: "config" };

/** Alarm shape as stored in a journal payload. Mirrors CorrelatedAlarm. */
function serializeAlarm(alarm: CorrelatedAlarm): Record<string, unknown> {
  return { ...alarm };
}

/**
 * Rebuild a CorrelatedAlarm field by field rather than casting the row. The
 * payload is this codebase's own serialisation, but it has been through a
 * database, and a cast would let anything that ever got into that row become a
 * live alarm object.
 */
function deserializeAlarm(payload: Record<string, unknown>): CorrelatedAlarm | null {
  const id = payload.id;
  const timestamp = payload.timestamp;
  if (typeof id !== "string" || id === "") return null;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const optionalString = (raw: unknown): string | undefined =>
    (typeof raw === "string" && raw !== "" ? raw : undefined);
  const scalar = (raw: unknown): number | string | undefined =>
    (typeof raw === "number" || typeof raw === "string" ? raw : undefined);
  return {
    id,
    name: typeof payload.name === "string" ? payload.name : id,
    tagId: typeof payload.tagId === "string" ? payload.tagId : "",
    equipmentId: optionalString(payload.equipmentId),
    siteId: optionalString(payload.siteId),
    processArea: optionalString(payload.processArea),
    severity: severityOrFloor(payload.severity),
    state: lifecycleStateOrActive(payload.state),
    message: typeof payload.message === "string" ? payload.message : "",
    timestamp,
    value: scalar(payload.value),
    limit: scalar(payload.limit),
    source: optionalString(payload.source),
    acknowledgedBy: optionalString(payload.acknowledgedBy),
    clearedBy: optionalString(payload.clearedBy),
  };
}

const SEVERITIES: readonly CorrelatedAlarm["severity"][] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

const LIFECYCLE_STATES: readonly CorrelatedAlarm["state"][] = [
  "active",
  "acknowledged",
  "cleared",
  "shelved",
  "suppressed",
];

/**
 * An unrecognised severity becomes `critical` — the never-suppress floor. A
 * cast would let an out-of-vocabulary value reach the severity comparison the
 * suppression decision is made on, where it compares as neither above nor below
 * the floor. Failing to the floor keeps the alarm visible.
 */
function severityOrFloor(raw: unknown): CorrelatedAlarm["severity"] {
  return SEVERITIES.find((candidate) => candidate === raw) ?? "critical";
}

/** An unrecognised lifecycle state becomes `active`: visible and actionable. */
function lifecycleStateOrActive(raw: unknown): CorrelatedAlarm["state"] {
  return LIFECYCLE_STATES.find((candidate) => candidate === raw) ?? "active";
}

export class AlarmCorrelationCoordinator extends EventEmitter {
  readonly engine: AlarmCorrelationEngine;
  readonly instanceId: string;

  private readonly store: CorrelationStore;
  private readonly pollIntervalMs: number;
  private readonly journalRetentionMs: number;
  private readonly stateRetentionMs: number;
  private readonly pruneIntervalMs: number;
  private readonly clock: () => number;

  private started = false;
  private healthy = false;
  private lastError: string | null = null;
  private lastHealthyAt: number | null = null;
  private suppressionDisabledByHealth = false;

  /** Highest journal seq this replica has applied to its own engine. */
  private appliedSeq = 0;
  /** Watermark of the shared materialised projection, as last observed. */
  private materializedSeq = 0;

  /** Operator's persisted intent, independent of whether it is being honoured. */
  private policyIntent: SuppressionPolicy = {
    enabled: false,
    neverSuppressAtOrAbove: "critical",
    unsuppressOnRootClear: true,
  };

  /** alarmId → journal seq that ingested it (persisted on the alarm row). */
  private ingestSeqByAlarm = new Map<string, number>();
  /** alarmId → journal seq of its latest state change, for wire de-duplication. */
  private stateSeqByAlarm = new Map<string, number>();

  /** Seq currently being applied — the source of deterministic group ids. */
  private applyingSeq = 0;
  private groupsFormedInEntry = 0;

  private dirtyAlarmIds = new Set<string>();
  private dirtyGroupIds = new Set<string>();
  private removedAlarmIds = new Set<string>();
  private removedGroupIds = new Set<string>();
  private entryChanges: ProjectionChanges | null = null;
  /**
   * Seq whose projection failed and has not yet been re-projected.
   *
   * The row changes for an entry are collected from the engine events it emits
   * while being applied. Re-applying is idempotent AT THE ENGINE, which means a
   * retry emits nothing — so a retry that started from empty dirty sets would
   * advance the watermark having written no rows, and the alarm that entry
   * carried would be absent from the projection for good. A restarting replica
   * adopts the projection at that watermark and never replays the entry, so the
   * alarm would simply be gone — exactly the "storage hiccup hides an alarm"
   * outcome this subsystem must never produce. Keeping the dirty sets alive
   * across the failure makes the retry re-read and re-write those same rows.
   */
  private unprojectedSeq: number | null = null;

  private awaitedSeqs = new Set<number>();
  private results = new Map<number, ApplyOutcome>();

  private pollTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private pumping: Promise<void> = Promise.resolve();

  constructor(options: CoordinatorOptions) {
    super();
    this.store = options.store;
    this.instanceId = options.instanceId ?? randomUUID();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.journalRetentionMs = options.journalRetentionMs ?? DEFAULT_JOURNAL_RETENTION_MS;
    this.stateRetentionMs = options.stateRetentionMs ?? DEFAULT_STATE_RETENTION_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
    this.engine = options.engine ?? new AlarmCorrelationEngine({
      ...options.engineOptions,
      groupIdFactory: () => this.nextGroupId(),
    });
    this.subscribeToEngine();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Open the store, adopt the durable projection, and start consuming the
   * journal. Throws if the store cannot be reached — the caller must then run
   * process-local with suppression off rather than pretend coordination works.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.store.ready();
    await this.rehydrate();
    this.started = true;
    this.healthy = true;
    this.lastError = null;
    this.lastHealthyAt = this.clock();
    this.suppressionDisabledByHealth = false;
    this.syncEnginePolicy();
    await this.pump();

    this.pollTimer = setInterval(() => {
      void this.pump().catch(() => undefined);
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();

    this.pruneTimer = setInterval(() => {
      void this.prune().catch(() => undefined);
    }, this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.started = false;
    this.healthy = false;
    await this.pumping.catch(() => undefined);
    await this.store.close();
  }

  // ── Health ───────────────────────────────────────────────────────────────

  health(): CorrelationCoordinationHealth {
    return {
      healthy: this.healthy,
      // A degraded coordinator is not coordinating. Reporting `durable` while
      // its state may be stale would be the exact false claim this issue is
      // about, and consumers key their trust in suppression off this field.
      mode: this.healthy ? "durable" : "process-local",
      backend: this.store.backend(),
      appliedSeq: this.appliedSeq,
      materializedSeq: this.materializedSeq,
      policyEnabledIntent: this.policyIntent.enabled,
      suppressionActive: this.engine.getSuppressionPolicy().enabled,
      suppressionDisabledByHealth: this.suppressionDisabledByHealth,
      lastError: this.lastError,
      lastHealthyAt: this.lastHealthyAt,
      instanceId: this.instanceId,
    };
  }

  /** Journal seq of an alarm's latest state change, for wire de-duplication. */
  alarmSeq(alarmId: string): number | null {
    return this.stateSeqByAlarm.get(alarmId) ?? null;
  }

  /**
   * Force the fail-safe path: suppression off, every suppressed alarm restored
   * and re-emitted, health reported degraded. Idempotent.
   */
  degrade(reason: string): void {
    this.lastError = reason;
    if (!this.healthy) return;
    this.healthy = false;
    this.suppressionDisabledByHealth = true;
    try {
      // Un-suppresses every member of every open group and emits the updates,
      // so a consumer that had hidden them shows them again.
      this.engine.setSuppressionPolicy({ enabled: false });
    } catch {
      // Restoring visibility must not be blocked by a policy validation error.
    }
    this.emit("degraded", { reason });
  }

  // ── Submission ───────────────────────────────────────────────────────────

  async submitIngest(
    alarm: CorrelatedAlarm,
    principal: string,
  ): Promise<SubmitResult<IngestResult>> {
    // One alarm id is ingested exactly once, ever. A retried or cross-replica
    // duplicate delivery collapses onto the entry already recorded.
    const submitted = await this.submit(
      "ingest",
      `ingest:${alarm.id}`,
      serializeAlarm(alarm),
      principal,
    );
    const outcome = submitted.outcome;
    return {
      seq: submitted.seq,
      created: submitted.created,
      outcome: outcome?.kind === "ingest" ? outcome.result : undefined,
    };
  }

  async submitAcknowledge(
    alarmId: string,
    principal: string,
  ): Promise<SubmitResult<boolean>> {
    const submitted = await this.submit(
      "acknowledge",
      `acknowledge:${alarmId}`,
      { alarmId },
      principal,
    );
    const outcome = submitted.outcome;
    return {
      seq: submitted.seq,
      created: submitted.created,
      outcome: outcome?.kind === "acknowledge" ? outcome.acknowledged : undefined,
    };
  }

  /**
   * Journal one idle-group sweep.
   *
   * Sweeping per replica would break convergence: closing an idle group
   * un-suppresses its members, so a sweep that ran on one replica and not
   * another leaves the two disagreeing about what an operator can see. The
   * entry carries the sweep clock, so every replica makes the identical
   * decision no matter when it consumes the entry.
   *
   * The idempotency key buckets by `bucketMs`, so several replicas whose sweep
   * timers fire in the same interval produce one entry rather than N.
   */
  async submitSweep(nowMs: number, bucketMs: number): Promise<SubmitResult<void>> {
    const bucket = Math.floor(nowMs / Math.max(1, bucketMs));
    const submitted = await this.submit(
      "sweep",
      `sweep:${bucket}`,
      { nowMs },
      "system",
    );
    return { seq: submitted.seq, created: submitted.created };
  }

  async submitClear(
    alarmId: string,
    principal: string,
  ): Promise<SubmitResult<ReturnType<AlarmCorrelationEngine["alarmCleared"]>>> {
    const submitted = await this.submit(
      "clear",
      `clear:${alarmId}`,
      { alarmId },
      principal,
    );
    const outcome = submitted.outcome;
    return {
      seq: submitted.seq,
      created: submitted.created,
      outcome: outcome?.kind === "clear" ? outcome.result : undefined,
    };
  }

  /**
   * Configuration mutations (rules, topology, suppression policy).
   *
   * Unlike alarm lifecycle operations these have no natural idempotency key —
   * editing a rule to A, then B, then back to A is three distinct operations,
   * so a content-derived key would silently drop the third. The caller supplies
   * `idempotencyKey` (routes take it from an `Idempotency-Key` header) to make
   * a retry safe; without one each request is its own operation.
   */
  async submitConfig(
    op: Extract<
      CorrelationJournalOp,
      | "rule-upsert"
      | "rule-remove"
      | "rule-enabled"
      | "topology-upsert"
      | "topology-remove"
      | "policy-set"
    >,
    payload: Record<string, unknown>,
    principal: string,
    idempotencyKey?: string,
  ): Promise<SubmitResult<void>> {
    const key = idempotencyKey ? `${op}:${idempotencyKey}` : `${op}:${randomUUID()}`;
    const submitted = await this.submit(op, key, payload, principal);
    return { seq: submitted.seq, created: submitted.created };
  }

  private async submit(
    op: CorrelationJournalOp,
    idempotencyKey: string,
    payload: Record<string, unknown>,
    principal: string,
  ): Promise<SubmitResult<ApplyOutcome>> {
    let appended: { seq: number; created: boolean };
    try {
      appended = await this.store.append({
        idempotencyKey,
        op,
        payload,
        principal,
        originInstance: this.instanceId,
      });
    } catch (error) {
      // Fail safe, then rethrow: the caller must fall back to raw delivery so
      // the alarm still reaches the operator uncorrelated.
      this.degrade(`journal append failed: ${describe(error)}`);
      throw error;
    }

    this.awaitedSeqs.add(appended.seq);
    try {
      await this.pump();
    } finally {
      this.awaitedSeqs.delete(appended.seq);
    }
    const outcome = this.results.get(appended.seq);
    this.results.delete(appended.seq);
    return { seq: appended.seq, created: appended.created, outcome };
  }

  // ── Journal consumption ──────────────────────────────────────────────────

  /**
   * Apply every journal entry above this replica's watermark, in seq order.
   * Serialised so two callers cannot interleave applications; a failure marks
   * the coordinator degraded and leaves the watermark where it was, so the
   * entry is retried on the next pump.
   */
  pump(): Promise<void> {
    const run = this.pumping.then(() => this.drain(), () => this.drain());
    this.pumping = run.catch(() => undefined);
    return run;
  }

  private async drain(): Promise<void> {
    for (;;) {
      let entries: CorrelationJournalEntry[];
      try {
        entries = await this.store.read(this.appliedSeq);
      } catch (error) {
        this.degrade(`journal read failed: ${describe(error)}`);
        throw error;
      }
      if (entries.length === 0) {
        this.markHealthy();
        return;
      }
      for (const entry of entries) {
        await this.applyEntry(entry);
      }
      this.markHealthy();
    }
  }

  private markHealthy(): void {
    this.lastHealthyAt = this.clock();
    if (this.healthy) return;
    this.healthy = true;
    this.lastError = null;
    this.suppressionDisabledByHealth = false;
    // Re-enable suppression only now that coordination works again, and only
    // to the extent the operator's persisted intent asks for.
    this.syncEnginePolicy();
    this.emit("recovered", this.health());
  }

  /**
   * Apply one entry to the engine, then project its row changes.
   *
   * If the projection fails, the watermark is NOT advanced, so the next pump
   * replays this entry against an engine that already applied it. That is safe
   * because every operation is idempotent at the engine: a repeated `ingest`
   * returns `duplicate` without re-counting, `acknowledge`/`clear` are guarded
   * by the alarm's current state, `sweep` is a pure function of the clock it
   * carries, and rule/topology/policy writes are upserts.
   */
  private async applyEntry(entry: CorrelationJournalEntry): Promise<void> {
    this.beginEntry(entry);
    let outcome: ApplyOutcome = { kind: "config" };
    try {
      outcome = this.applyToEngine(entry);
    } catch (error) {
      // A malformed or unapplicable entry must not wedge the log forever: the
      // watermark still advances so later operations are not blocked behind it,
      // and the failure is surfaced rather than swallowed.
      this.emit("apply-failed", { seq: entry.seq, reason: describe(error) });
    }

    const changes = this.finishEntry(entry);
    try {
      const projected = await this.store.project(entry.seq, changes);
      if (projected) this.materializedSeq = entry.seq;
      else this.materializedSeq = Math.max(this.materializedSeq, entry.seq);
    } catch (error) {
      // Keep this entry's row changes so the retry re-projects them; the engine
      // will not re-emit them, because applying it again is a no-op there.
      this.unprojectedSeq = entry.seq;
      this.degrade(`projection of seq ${entry.seq} failed: ${describe(error)}`);
      throw error;
    }
    this.unprojectedSeq = null;

    this.appliedSeq = entry.seq;
    for (const alarmId of changes.deletedAlarmIds) {
      this.stateSeqByAlarm.delete(alarmId);
      this.ingestSeqByAlarm.delete(alarmId);
    }

    if (this.awaitedSeqs.has(entry.seq)) {
      if (this.results.size >= MAX_AWAITED_RESULTS) this.results.clear();
      this.results.set(entry.seq, outcome);
    }
    this.emit("applied", { seq: entry.seq, op: entry.op });
  }

  private applyToEngine(entry: CorrelationJournalEntry): ApplyOutcome {
    switch (entry.op) {
      case "ingest": {
        const alarm = deserializeAlarm(entry.payload);
        if (!alarm) throw new Error(`entry ${entry.seq} carries no usable alarm`);
        if (!this.ingestSeqByAlarm.has(alarm.id)) {
          this.ingestSeqByAlarm.set(alarm.id, entry.seq);
        }
        return { kind: "ingest", result: this.engine.ingest(alarm) };
      }
      case "acknowledge": {
        const alarmId = String(entry.payload.alarmId ?? "");
        return {
          kind: "acknowledge",
          acknowledged: this.engine.alarmAcknowledged(alarmId, entry.principal),
        };
      }
      case "clear": {
        const alarmId = String(entry.payload.alarmId ?? "");
        return {
          kind: "clear",
          result: this.engine.alarmCleared(alarmId, entry.principal),
        };
      }
      case "sweep": {
        const nowMs = entry.payload.nowMs;
        if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
          throw new Error(`sweep entry ${entry.seq} carries no usable clock`);
        }
        this.engine.sweep(nowMs);
        return { kind: "config" };
      }
      case "rule-upsert": {
        const rule = entry.payload.rule as CorrelationRule;
        const stored = this.engine.rules.upsert(rule);
        this.entryChanges?.upsertRules.push(stored);
        return { kind: "config" };
      }
      case "rule-remove": {
        const ruleId = String(entry.payload.ruleId ?? "");
        this.engine.rules.remove(ruleId);
        this.entryChanges?.removedRuleIds.push(ruleId);
        return { kind: "config" };
      }
      case "rule-enabled": {
        const ruleId = String(entry.payload.ruleId ?? "");
        const enabled = entry.payload.enabled === true;
        const stored = this.engine.rules.setEnabled(ruleId, enabled);
        if (stored) this.entryChanges?.upsertRules.push(stored);
        return { kind: "config" };
      }
      case "topology-upsert": {
        const nodes = (entry.payload.nodes ?? []) as EquipmentNode[];
        const stored = this.engine.topology.upsertMany(nodes);
        this.entryChanges?.upsertEquipment.push(...stored);
        this.engine.reconcileTopology();
        return { kind: "config" };
      }
      case "topology-remove": {
        const equipmentId = String(entry.payload.equipmentId ?? "");
        this.engine.topology.remove(equipmentId);
        this.entryChanges?.removedEquipmentIds.push(equipmentId);
        this.engine.reconcileTopology();
        return { kind: "config" };
      }
      case "policy-set": {
        const requested = entry.payload.policy as Partial<SuppressionPolicy>;
        this.policyIntent = {
          ...this.policyIntent,
          ...requested,
          // Never persistable as false: a group that closes without restoring
          // its suppressed members would hide them permanently.
          unsuppressOnRootClear: true,
        };
        this.syncEnginePolicy();
        if (this.entryChanges) this.entryChanges.policy = { ...this.policyIntent };
        return { kind: "config" };
      }
    }
  }

  /**
   * Suppression is active only when coordination is healthy AND the operator's
   * persisted intent asks for it. Neither condition alone is enough, and this
   * is the only place suppression is ever turned on.
   */
  private syncEnginePolicy(): void {
    this.engine.setSuppressionPolicy({
      neverSuppressAtOrAbove: this.policyIntent.neverSuppressAtOrAbove,
      unsuppressOnRootClear: true,
      enabled: this.healthy && this.policyIntent.enabled,
    });
  }

  // ── Deterministic group ids ──────────────────────────────────────────────

  /**
   * `ACG-<seq>` for the first group formed while applying an entry, then
   * `ACG-<seq>-<n>`. Derived entirely from the shared journal position, so
   * every replica names the same group identically, and monotonic-never-reused
   * `seq` allocation rules out reuse. Falls back to a random id only when no
   * entry is being applied, which cannot happen on the coordinated path but
   * must not silently produce a colliding constant if it ever did.
   */
  private nextGroupId(): string {
    if (this.applyingSeq === 0) return `ACG-local-${randomUUID()}`;
    const suffix = this.groupsFormedInEntry === 0 ? "" : `-${this.groupsFormedInEntry}`;
    this.groupsFormedInEntry++;
    return `ACG-${this.applyingSeq}${suffix}`;
  }

  // ── Dirty tracking → projection changes ──────────────────────────────────

  /**
   * Mark an alarm as changed by the entry being applied.
   *
   * The seq is recorded HERE rather than after the projection commits, because
   * the engine emits its change events synchronously during apply and the
   * snapshots built from them must already carry the seq — a snapshot that went
   * out with a null seq could not be recognised as a duplicate by the instance
   * that receives its cross-instance echo.
   */
  private touchAlarm(alarmId: string): void {
    this.dirtyAlarmIds.add(alarmId);
    this.removedAlarmIds.delete(alarmId);
    if (this.applyingSeq > 0) this.stateSeqByAlarm.set(alarmId, this.applyingSeq);
  }

  private subscribeToEngine(): void {
    const touchGroup = (group: AlarmGroup): void => {
      this.dirtyGroupIds.add(group.id);
      this.removedGroupIds.delete(group.id);
      for (const alarm of group.alarms) this.touchAlarm(alarm.id);
    };
    for (const event of ["group-created", "group-updated", "group-closed"]) {
      this.engine.on(event, touchGroup);
    }
    this.engine.on("alarm-updated", (alarm: CorrelatedAlarm) => {
      this.touchAlarm(alarm.id);
    });
    this.engine.on("alarm-suppressed", (payload: { alarmId: string }) => {
      this.touchAlarm(payload.alarmId);
    });
    this.engine.on("alarms-unsuppressed", (payload: { alarmIds: string[] }) => {
      for (const alarmId of payload.alarmIds) this.touchAlarm(alarmId);
    });
    // Eviction and pruning are the engine forgetting state under its retention
    // caps. The projection must forget exactly the same rows, or a restart
    // would resurrect groups this engine no longer believes in.
    this.engine.on("group-evicted", (payload: { groupId: string; alarmIds: string[] }) => {
      this.removedGroupIds.add(payload.groupId);
      this.dirtyGroupIds.delete(payload.groupId);
      for (const alarmId of payload.alarmIds) {
        this.removedAlarmIds.add(alarmId);
        this.dirtyAlarmIds.delete(alarmId);
      }
    });
    this.engine.on("pending-pruned", (payload: { alarmIds?: string[] }) => {
      for (const alarmId of payload.alarmIds ?? []) {
        this.removedAlarmIds.add(alarmId);
        this.dirtyAlarmIds.delete(alarmId);
      }
    });
  }

  private beginEntry(entry: CorrelationJournalEntry): void {
    this.applyingSeq = entry.seq;
    this.groupsFormedInEntry = 0;
    // Retrying an entry whose projection failed keeps the ids that attempt
    // collected; anything else starts clean.
    if (this.unprojectedSeq !== entry.seq) {
      this.dirtyAlarmIds.clear();
      this.dirtyGroupIds.clear();
      this.removedAlarmIds.clear();
      this.removedGroupIds.clear();
    }
    this.entryChanges = emptyProjectionChanges(
      this.engine.getCounters(),
      entry.principal,
    );
  }

  private finishEntry(entry: CorrelationJournalEntry): ProjectionChanges {
    const changes = this.entryChanges
      ?? emptyProjectionChanges(this.engine.getCounters(), entry.principal);
    this.entryChanges = null;
    this.applyingSeq = 0;
    changes.metrics = this.engine.getCounters();

    for (const groupId of this.dirtyGroupIds) {
      const group = this.engine.getGroup(groupId);
      // Formed then evicted while applying one entry: nothing to persist, and
      // the delete below removes any earlier row.
      if (!group) {
        this.removedGroupIds.add(groupId);
        continue;
      }
      changes.groups.push(group);
    }

    for (const alarmId of this.dirtyAlarmIds) {
      const persisted = this.persistedAlarm(alarmId, entry.seq);
      if (!persisted) {
        this.removedAlarmIds.add(alarmId);
        continue;
      }
      changes.alarms.push(persisted);
    }

    changes.deletedGroupIds = [...this.removedGroupIds];
    changes.deletedAlarmIds = [...this.removedAlarmIds];
    return changes;
  }

  private persistedAlarm(alarmId: string, seq: number): PersistedAlarm | null {
    const alarm = this.engine.getAlarm(alarmId);
    if (!alarm) return null;
    const group = this.engine.getGroupForAlarm(alarmId);
    return {
      alarm,
      groupId: group?.id ?? null,
      suppressed: group?.suppressedAlarmIds.includes(alarmId) ?? false,
      isRootCause: group?.rootCauseAlarmId === alarmId,
      joinedViaRuleId: group?.joinedVia[alarmId] ?? null,
      ingestSeq: this.ingestSeqByAlarm.get(alarmId) ?? seq,
    };
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  /**
   * Adopt the durable projection: rules, topology, suppression policy, open
   * groups (with their suppression records), ungrouped alarms, lifecycle
   * attribution, and the cumulative counters.
   *
   * Rules fall back to DEFAULT_RULES only when the store holds none at all —
   * an empty rule table means "never configured", whereas an operator who
   * deliberately removed every rule keeps at least the disabled rows.
   */
  private async rehydrate(): Promise<void> {
    const snapshot = await this.store.load();

    const rules = snapshot.rules.length > 0 ? snapshot.rules : DEFAULT_RULES;
    // Constructing a rules engine validates every stored rule before any of it
    // reaches the live engine, so a corrupted row fails recovery loudly instead
    // of quietly changing which alarms get grouped.
    const validated = new CorrelationRulesEngine(rules).list();
    replaceRules(this.engine.rules, validated);

    const topology = new EquipmentTopology();
    topology.upsertMany(snapshot.equipment);
    replaceTopology(this.engine.topology, topology.list());

    this.engine.hydrate({
      groups: snapshot.groups,
      pending: snapshot.pending,
      metrics: snapshot.metrics,
    });

    this.policyIntent = { ...snapshot.policy, unsuppressOnRootClear: true };
    this.appliedSeq = snapshot.appliedSeq;
    this.materializedSeq = snapshot.appliedSeq;

    this.ingestSeqByAlarm = new Map();
    this.stateSeqByAlarm = new Map(snapshot.alarmSeq);
    for (const group of snapshot.groups) {
      for (const alarm of group.alarms) {
        this.ingestSeqByAlarm.set(
          alarm.id,
          snapshot.alarmSeq.get(alarm.id) ?? snapshot.appliedSeq,
        );
      }
    }
    for (const alarm of snapshot.pending) {
      this.ingestSeqByAlarm.set(
        alarm.id,
        snapshot.alarmSeq.get(alarm.id) ?? snapshot.appliedSeq,
      );
    }
  }

  /** Apply retention. Never touches unprojected journal entries or open groups. */
  async prune(): Promise<{ journalEntries: number; groups: number; alarms: number }> {
    try {
      const result = await this.store.prune({
        journalOlderThanMs: this.journalRetentionMs,
        closedGroupsOlderThanMs: this.stateRetentionMs,
        now: this.clock(),
      });
      this.emit("pruned", result);
      return result;
    } catch (error) {
      this.degrade(`retention pass failed: ${describe(error)}`);
      throw error;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The rules engine and topology are owned by the correlation engine and have no
 * "replace everything" operation, because normal operation only ever upserts.
 * Recovery genuinely needs one: whatever the process started with must give way
 * to what the store holds, including rules an operator deleted.
 */
function replaceRules(target: CorrelationRulesEngine, rules: CorrelationRule[]): void {
  for (const existing of target.list()) {
    if (!rules.some((rule) => rule.id === existing.id)) target.remove(existing.id);
  }
  for (const rule of rules) target.upsert(rule);
}

function replaceTopology(target: EquipmentTopology, nodes: EquipmentNode[]): void {
  for (const existing of target.list()) {
    if (!nodes.some((node) => node.equipmentId === existing.equipmentId)) {
      target.remove(existing.equipmentId);
    }
  }
  if (nodes.length > 0) target.upsertMany(nodes);
}
