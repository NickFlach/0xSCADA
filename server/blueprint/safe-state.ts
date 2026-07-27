/**
 * Blueprint Safe-State Fallback (#459)
 *
 * When a blueprint's deterministic control tick consistently misses its budget,
 * the watchdog (see ./watchdog.ts) halts the blueprint and transitions it to a
 * pre-declared *safe state*. This module owns:
 *
 *   1. The minimal local interfaces this feature depends on (anchor backend,
 *      audit sink, actuation seam) so the core logic is unit-testable without a
 *      live database, chain, or runtime.
 *   2. The {@link SafeStateController} which applies the safe state to a running
 *      blueprint, anchors a CRITICAL `SafeStateEntered` event, and writes an
 *      audit log entry for every entry / exit transition.
 *
 * The production actuator that satisfies {@link SafeStateActuator} lives in
 * ./runtime-actuator.ts and is bound to a real blueprint by ./safety-host.ts.
 *
 * Re-entry to RUNNING is NEVER automatic — it requires an explicit operator
 * `resume()` call, which itself anchors and audits a `SafeStateExited` event.
 *
 * @see server/blueprint/watchdog.ts
 * @see shared/schema.ts (safeStateConfig, blueprint_safe_state_log)
 */

import { randomUUID, createHash } from "crypto";
import type { SafeStateAction, SafeStateConfig } from "@shared/schema";

// ─── Local interface seams ───────────────────────────────────────────────────
// INTEGRATION (#443/#455): the canonical anchor backend lives behind a sibling
// branch. We declare the minimal surface we need here and adapt the real
// backend to it at wiring time, so this module's core logic stays testable.

/** Severity levels recognised by the canonical anchor backend. */
export type AnchorSeverity = "INFO" | "WARNING" | "CRITICAL";

/** An event submitted to the canonical anchor backend for immutable recording. */
export interface AnchorEvent {
  /** Stable event identifier. */
  id: string;
  /** RFC 3339 timestamp of the event. */
  timestamp: string;
  /** Event discriminator, e.g. "SafeStateEntered". */
  eventType: string;
  /** Severity — safe-state transitions are anchored as CRITICAL. */
  severity: AnchorSeverity;
  /** Owning site (optional — blueprints may be site-scoped). */
  siteId?: string;
  /** Human-readable summary. */
  message: string;
  /** Structured payload. Included in the anchored hash. */
  data: Record<string, unknown>;
}

/** Receipt returned by the anchor backend after accepting an event. */
export interface AnchorReceipt {
  /** Deterministic content hash of the anchored event. */
  hash: string;
  /** On-chain transaction hash, if anchored synchronously. */
  txHash?: string;
}

/**
 * Minimal canonical anchor backend.
 *
 * INTEGRATION (#443/#455): adapt the real EventAnchorBridge / integrity pipeline
 * to this interface. The real bridge's `anchor()` is fire-and-forget batched; an
 * adapter should compute the content hash up-front (see {@link computeAnchorHash})
 * and return it as the receipt so safe-state transitions remain auditable even
 * before the batch lands on-chain.
 */
export interface AnchorBackend {
  anchor(event: AnchorEvent): Promise<AnchorReceipt>;
}

/**
 * Audit sink for safe-state transitions. Backed in production by
 * `blueprint_safe_state_log` via server/storage.ts (Drizzle). Kept as an
 * interface so core logic is testable without a live database.
 */
export interface SafeStateAuditSink {
  record(entry: SafeStateAuditEntry): Promise<void>;
}

/** A single audited safe-state transition (entry or exit). */
export interface SafeStateAuditEntry {
  blueprintId: string;
  siteId?: string;
  transition:
    | "ENTERED"
    | "EXIT_REQUESTED"
    | "EXITED"
    | "RESUME_FAILED"
    | "EXIT_ABORTED"
    | "RECOVERY_FAILED";
  safeState: SafeStateAction;
  tickBudgetMs: number;
  consecutiveMisses?: number;
  operator?: string;
  reason: string;
  anchorHash: string;
  anchorTxHash?: string;
  timestamp: string;
}

// ─── Actuation seam ──────────────────────────────────────────────────────────

/**
 * The actuation seam the safe-state controller drives.
 *
 * This is deliberately narrower than the deterministic {@link
 * import('./runtime').BlueprintRuntime} class: the controller only needs to be
 * able to stop the loop and command outputs. The production implementation is
 * {@link import('./runtime-actuator').BlueprintRuntimeActuator}, which drives
 * the runtime's tag store (and, when one is bound, a field-output sink).
 *
 * Every implementation MUST make each method either take real effect or throw.
 * A silent no-op here is a safety defect: the controller would report a safe
 * state that was never applied.
 */
export interface SafeStateActuator {
  /** Stable blueprint identifier. */
  readonly blueprintId: string;
  /** Owning site, if any. */
  readonly siteId?: string;
  /**
   * Pre-flight check run at registration time. MUST throw if this actuator
   * cannot physically apply `action`, so a blueprint is never armed with a
   * declared safe state it could not enter.
   */
  assertCanApply(action: SafeStateAction): void;
  /** Halt the deterministic control loop (stop scheduling further ticks). */
  halt(): void;
  /** Resume the deterministic control loop after an operator clears safe state. */
  resume(): void;
  /** Freeze all outputs at their last commanded value. */
  holdLastOutputs(): void;
  /** Drive all outputs to zero / de-energised. */
  forceZeroOutputs(): void;
  /** Load and apply a named, previously-validated safe recipe. */
  applySafeRecipe(recipe: string): void;
}

// ─── Safe-state lifecycle ────────────────────────────────────────────────────

/** Operational state of a blueprint with respect to the watchdog. */
export type BlueprintRunState =
  | "RUNNING"
  | "SAFE_STATE"
  | "RESUMING"
  | "RECOVERING"
  | "RECOVERY_FAILED";

/** Public, serialisable view of a blueprint's safe-state status (for the UI). */
export interface SafeStateStatus {
  blueprintId: string;
  siteId?: string;
  runState: BlueprintRunState;
  /** The safe state that is (or would be) applied. */
  safeState: SafeStateAction;
  /** When the blueprint entered safe state (ISO string), if active. */
  enteredAt?: string;
  /** Why the watchdog tripped. */
  reason?: string;
  /** Consecutive over-budget ticks at the time of the trip. */
  consecutiveMisses?: number;
  /** Content hash of the anchored SafeStateEntered event, if any. */
  anchorHash?: string;
  /** Whether the active safe-state entry has a durable audit row. */
  entryAuditStatus?: "pending" | "durable";
  /** Compensation failures that prevent the controller from claiming safety. */
  recoveryErrors?: string[];
}

/** A short, human-readable label for a {@link SafeStateAction}. */
export function describeSafeState(action: SafeStateAction): string {
  if (action === "hold-last") return "Hold last outputs";
  if (action === "force-zero") return "Force outputs to zero";
  return `Apply safe recipe "${action.recipe}"`;
}

/**
 * Deterministic content hash of an anchor event. Used both as the local audit
 * reference and as the value an anchor-backend adapter can surface as its
 * receipt hash. SHA-256 over a canonical JSON projection (stable key order).
 */
export function computeAnchorHash(event: AnchorEvent): string {
  const canonical = JSON.stringify({
    id: event.id,
    timestamp: event.timestamp,
    eventType: event.eventType,
    severity: event.severity,
    siteId: event.siteId ?? null,
    message: event.message,
    data: event.data,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Applies / clears safe state on a blueprint runtime and produces the anchored,
 * audited transition records. Holds no scheduling logic of its own — the
 * {@link import('./watchdog').Watchdog} decides *when* to trip; this controller
 * decides *what happens* on a trip / resume.
 */
export class SafeStateController {
  private status: SafeStateStatus;
  /** Entry that must become durable before any resume can be attempted. */
  private pendingEntryAudit?: SafeStateAuditEntry;
  /** Exact exit-request record retained across an ambiguous write failure. */
  private pendingExitRequestAudit?: SafeStateAuditEntry;
  /**
   * Serialises entry and exit transitions for this blueprint. The queue is
   * always normalised back to a resolved promise so one failed transition does
   * not prevent a later operator action from being evaluated.
   */
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly actuator: SafeStateActuator,
    private readonly config: SafeStateConfig,
    private readonly anchor: AnchorBackend,
    private readonly audit: SafeStateAuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.status = {
      blueprintId: actuator.blueprintId,
      siteId: actuator.siteId,
      runState: "RUNNING",
      safeState: config.safeState,
    };
  }

  /** Current serialisable status (safe to send to the operator UI). */
  getStatus(): SafeStateStatus {
    return { ...this.status };
  }

  /** True once the blueprint has been halted into its safe state. */
  isInSafeState(): boolean {
    return this.status.runState !== "RUNNING";
  }

  /**
   * Halt the blueprint, apply the declared safe state, anchor a CRITICAL
   * `SafeStateEntered` event and write the audit entry. Idempotent: a second
   * call while already in safe state is a no-op (returns the existing status).
   *
   * @param reason            why the watchdog tripped
   * @param consecutiveMisses over-budget tick count at the trip
   */
  enterSafeState(reason: string, consecutiveMisses: number): Promise<SafeStateStatus> {
    return this.runSerializedTransition(() =>
      this.enterSafeStateLocked(reason, consecutiveMisses),
    );
  }

  private async enterSafeStateLocked(
    reason: string,
    consecutiveMisses: number,
  ): Promise<SafeStateStatus> {
    if (this.status.runState === "SAFE_STATE") {
      await this.persistPendingEntryAudit();
      return this.getStatus();
    }

    // 1. Halt scheduling, then drive outputs to the declared safe state.
    this.actuator.halt();
    this.applyAction(this.config.safeState);

    const timestamp = this.now().toISOString();

    // 2. Anchor a CRITICAL SafeStateEntered event via the canonical backend.
    const event: AnchorEvent = {
      id: randomUUID(),
      timestamp,
      eventType: "SafeStateEntered",
      severity: "CRITICAL",
      siteId: this.actuator.siteId,
      message:
        `Blueprint ${this.actuator.blueprintId} entered safe state ` +
        `(${describeSafeState(this.config.safeState)}): ${reason}`,
      data: {
        blueprintId: this.actuator.blueprintId,
        safeState: this.config.safeState,
        tickBudgetMs: this.config.tickBudgetMs,
        consecutiveMisses,
        reason,
      },
    };
    const receipt = await this.safeAnchor(event);

    // 3. Update status and audit the transition.
    this.status = {
      ...this.status,
      runState: "SAFE_STATE",
      enteredAt: timestamp,
      reason,
      consecutiveMisses,
      anchorHash: receipt.hash,
      entryAuditStatus: "pending",
    };

    this.pendingEntryAudit = {
      blueprintId: this.actuator.blueprintId,
      siteId: this.actuator.siteId,
      transition: "ENTERED",
      safeState: this.config.safeState,
      tickBudgetMs: this.config.tickBudgetMs,
      consecutiveMisses,
      reason,
      anchorHash: receipt.hash,
      anchorTxHash: receipt.txHash,
      timestamp,
    };
    await this.persistPendingEntryAudit();

    return this.getStatus();
  }

  /**
   * Operator-initiated exit from safe state. Resumes the deterministic loop,
   * anchors a `SafeStateExited` event and audits the transition. Requires an
   * operator identity — there is no automatic resume.
   *
   * @throws if the blueprint is not currently in safe state.
   */
  resume(operator: string, reason = "Operator resume"): Promise<SafeStateStatus> {
    return this.runSerializedTransition(() =>
      this.resumeLocked(operator, reason),
    );
  }

  private async resumeLocked(
    operator: string,
    reason: string,
  ): Promise<SafeStateStatus> {
    if (!operator || operator.trim() === "") {
      throw new Error("resume() requires an operator identity");
    }
    if (this.status.runState !== "SAFE_STATE") {
      throw new Error(
        `Blueprint ${this.actuator.blueprintId} is not in safe state; cannot resume`,
      );
    }

    // A safe state with an undurable ENTERED record may never be cleared.
    // Retrying this exact entry is idempotent in the production audit sink.
    await this.persistPendingEntryAudit();
    // Reconcile an earlier request whose database result was ambiguous using
    // the exact same hash before accepting a new operator request.
    await this.persistPendingExitRequestAudit();

    const requestedAt = this.now().toISOString();

    const requestEvent: AnchorEvent = {
      id: randomUUID(),
      timestamp: requestedAt,
      eventType: "SafeStateExitRequested",
      severity: "WARNING",
      siteId: this.actuator.siteId,
      message: `Blueprint ${this.actuator.blueprintId} safe-state exit requested by ${operator}: ${reason}`,
      data: {
        blueprintId: this.actuator.blueprintId,
        operator,
        reason,
        previousSafeState: this.config.safeState,
      },
    };
    const requestReceipt = await this.safeAnchor(requestEvent);

    // Persist authorisation before touching the runtime. This record is an
    // intent, not a claim that the control loop has resumed.
    this.pendingExitRequestAudit = {
      blueprintId: this.actuator.blueprintId,
      siteId: this.actuator.siteId,
      transition: "EXIT_REQUESTED",
      safeState: this.config.safeState,
      tickBudgetMs: this.config.tickBudgetMs,
      operator,
      reason,
      anchorHash: requestReceipt.hash,
      anchorTxHash: requestReceipt.txHash,
      timestamp: requestedAt,
    };
    await this.persistPendingExitRequestAudit();

    let runtimeResumed = false;
    try {
      this.actuator.resume();
      runtimeResumed = true;
      // Do not claim SAFE_STATE while the control loop is live and the durable
      // EXITED record is still pending.
      this.status = {
        ...this.status,
        runState: "RESUMING",
        recoveryErrors: undefined,
      };

      const exitedAt = this.now().toISOString();
      const exitedEvent: AnchorEvent = {
        id: randomUUID(),
        timestamp: exitedAt,
        eventType: "SafeStateExited",
        severity: "WARNING",
        siteId: this.actuator.siteId,
        message: `Blueprint ${this.actuator.blueprintId} resumed from safe state by ${operator}: ${reason}`,
        data: {
          blueprintId: this.actuator.blueprintId,
          operator,
          reason,
          previousSafeState: this.config.safeState,
        },
      };
      const exitReceipt = await this.safeAnchor(exitedEvent);

      // EXITED is written only after runtime.resume() succeeds. If this write
      // fails, the catch path immediately re-applies the declared safe state.
      await this.audit.record({
        blueprintId: this.actuator.blueprintId,
        siteId: this.actuator.siteId,
        transition: "EXITED",
        safeState: this.config.safeState,
        tickBudgetMs: this.config.tickBudgetMs,
        operator,
        reason,
        anchorHash: exitReceipt.hash,
        anchorTxHash: exitReceipt.txHash,
        timestamp: exitedAt,
      });

      this.status = {
        blueprintId: this.actuator.blueprintId,
        siteId: this.actuator.siteId,
        runState: "RUNNING",
        safeState: this.config.safeState,
      };

      return this.getStatus();
    } catch (error) {
      // A partially-failed runtime resume or post-resume audit must converge
      // back to the safe state. Halt and safe-output application are attempted
      // independently so one failure never prevents the other.
      const recoveryErrors = this.recoverToSafeState();
      const transition = recoveryErrors.length > 0
        ? "RECOVERY_FAILED"
        : runtimeResumed
          ? "EXIT_ABORTED"
          : "RESUME_FAILED";
      await this.recordRecoveryOutcome(
        transition,
        operator,
        reason,
        error,
        recoveryErrors,
      );
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [
            error,
            ...recoveryErrors.map((message) => new Error(message)),
          ],
          `Blueprint ${this.actuator.blueprintId} resume failed and safety recovery was incomplete`,
        );
      }
      throw error;
    }
  }

  private async persistPendingEntryAudit(): Promise<void> {
    if (!this.pendingEntryAudit) return;
    await this.audit.record(this.pendingEntryAudit);
    this.pendingEntryAudit = undefined;
    this.status = { ...this.status, entryAuditStatus: "durable" };
  }

  private async persistPendingExitRequestAudit(): Promise<void> {
    if (!this.pendingExitRequestAudit) return;
    await this.audit.record(this.pendingExitRequestAudit);
    this.pendingExitRequestAudit = undefined;
  }

  private recoverToSafeState(): string[] {
    this.status = {
      ...this.status,
      runState: "RECOVERING",
      recoveryErrors: undefined,
    };
    const errors: string[] = [];
    try {
      this.actuator.halt();
    } catch (error) {
      errors.push(
        `halt failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      this.applyAction(this.config.safeState);
    } catch (error) {
      errors.push(
        `safe-output application failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.status = {
      ...this.status,
      runState: errors.length === 0 ? "SAFE_STATE" : "RECOVERY_FAILED",
      recoveryErrors: errors.length > 0 ? [...errors] : undefined,
    };
    return errors;
  }

  private async recordRecoveryOutcome(
    transition: "RESUME_FAILED" | "EXIT_ABORTED" | "RECOVERY_FAILED",
    operator: string,
    reason: string,
    cause: unknown,
    recoveryErrors: string[],
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    const detail = cause instanceof Error ? cause.message : String(cause);
    const outcome =
      transition === "RESUME_FAILED"
        ? "resume attempt failed and the declared safe state was re-applied"
        : transition === "EXIT_ABORTED"
          ? "runtime resumed temporarily, but exit durability failed and the declared safe state was re-applied"
          : "resume/exit failed and the declared safe state could not be fully restored";
    const event: AnchorEvent = {
      id: randomUUID(),
      timestamp,
      eventType: transition === "EXIT_ABORTED"
        ? "SafeStateExitAborted"
        : transition === "RECOVERY_FAILED"
          ? "SafeStateRecoveryFailed"
          : "SafeStateResumeFailed",
      severity: "CRITICAL",
      siteId: this.actuator.siteId,
      message: `Blueprint ${this.actuator.blueprintId}: ${outcome}: ${detail}`,
      data: {
        blueprintId: this.actuator.blueprintId,
        operator,
        reason,
        failure: detail,
        recoveryErrors,
        safeState: this.config.safeState,
      },
    };
    const receipt = await this.safeAnchor(event);
    try {
      await this.audit.record({
        blueprintId: this.actuator.blueprintId,
        siteId: this.actuator.siteId,
        transition,
        safeState: this.config.safeState,
        tickBudgetMs: this.config.tickBudgetMs,
        operator,
        reason: `${reason}; ${outcome}: ${detail}`,
        anchorHash: receipt.hash,
        anchorTxHash: receipt.txHash,
        timestamp,
      });
    } catch {
      // Preserve the original resume/audit failure for the caller. Physical
      // outputs are already back in the safe state.
    }
  }

  /**
   * Run one state transition at a time. In particular, a second resume waits
   * for the first transition to finish and then re-checks runState, so it cannot
   * duplicate the audit or race the physical runtime state.
   */
  private runSerializedTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionTail.then(operation);
    this.transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Drive the runtime into the configured safe state. */
  private applyAction(action: SafeStateAction): void {
    if (action === "hold-last") {
      this.actuator.holdLastOutputs();
    } else if (action === "force-zero") {
      this.actuator.forceZeroOutputs();
    } else {
      this.actuator.applySafeRecipe(action.recipe);
    }
  }

  /**
   * Anchor an event, degrading gracefully if the backend is unavailable. The
   * physical safe state has ALREADY been applied by the time we anchor, so an
   * anchoring failure must NOT prevent the blueprint from staying safe — we fall
   * back to the locally-computed content hash so the transition is still
   * auditable and self-verifying.
   */
  private async safeAnchor(event: AnchorEvent): Promise<AnchorReceipt> {
    try {
      return await this.anchor.anchor(event);
    } catch {
      return { hash: computeAnchorHash(event) };
    }
  }
}
