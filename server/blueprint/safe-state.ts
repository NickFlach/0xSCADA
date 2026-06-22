/**
 * Blueprint Safe-State Fallback (#459)
 *
 * When a blueprint's deterministic control tick consistently misses its budget,
 * the watchdog (see ./watchdog.ts) halts the blueprint and transitions it to a
 * pre-declared *safe state*. This module owns:
 *
 *   1. The minimal local interfaces this feature depends on (anchor backend,
 *      blueprint runtime / tick) so the core logic is unit-testable WITHOUT the
 *      sibling integrity-pipeline / runtime branches present.
 *   2. The {@link SafeStateController} which applies the safe state to a running
 *      blueprint, anchors a CRITICAL `SafeStateEntered` event, and writes an
 *      audit log entry for every entry / exit transition.
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
  transition: "ENTERED" | "EXITED";
  safeState: SafeStateAction;
  tickBudgetMs: number;
  consecutiveMisses?: number;
  operator?: string;
  reason: string;
  anchorHash?: string;
  anchorTxHash?: string;
  timestamp: string;
}

// INTEGRATION (#1 Deterministic Runtime): the real blueprint runtime exposes a
// richer control surface. We depend only on the operations needed to enforce a
// safe state, declared minimally here.

/** The minimal blueprint runtime surface the safe-state controller drives. */
export interface BlueprintRuntime {
  /** Stable blueprint identifier. */
  readonly blueprintId: string;
  /** Owning site, if any. */
  readonly siteId?: string;
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
export type BlueprintRunState = "RUNNING" | "SAFE_STATE";

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

  constructor(
    private readonly runtime: BlueprintRuntime,
    private readonly config: SafeStateConfig,
    private readonly anchor: AnchorBackend,
    private readonly audit: SafeStateAuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.status = {
      blueprintId: runtime.blueprintId,
      siteId: runtime.siteId,
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
    return this.status.runState === "SAFE_STATE";
  }

  /**
   * Halt the blueprint, apply the declared safe state, anchor a CRITICAL
   * `SafeStateEntered` event and write the audit entry. Idempotent: a second
   * call while already in safe state is a no-op (returns the existing status).
   *
   * @param reason            why the watchdog tripped
   * @param consecutiveMisses over-budget tick count at the trip
   */
  async enterSafeState(reason: string, consecutiveMisses: number): Promise<SafeStateStatus> {
    if (this.status.runState === "SAFE_STATE") {
      return this.getStatus();
    }

    // 1. Halt scheduling, then drive outputs to the declared safe state.
    this.runtime.halt();
    this.applyAction(this.config.safeState);

    const timestamp = this.now().toISOString();

    // 2. Anchor a CRITICAL SafeStateEntered event via the canonical backend.
    const event: AnchorEvent = {
      id: randomUUID(),
      timestamp,
      eventType: "SafeStateEntered",
      severity: "CRITICAL",
      siteId: this.runtime.siteId,
      message:
        `Blueprint ${this.runtime.blueprintId} entered safe state ` +
        `(${describeSafeState(this.config.safeState)}): ${reason}`,
      data: {
        blueprintId: this.runtime.blueprintId,
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
    };

    await this.audit.record({
      blueprintId: this.runtime.blueprintId,
      siteId: this.runtime.siteId,
      transition: "ENTERED",
      safeState: this.config.safeState,
      tickBudgetMs: this.config.tickBudgetMs,
      consecutiveMisses,
      reason,
      anchorHash: receipt.hash,
      anchorTxHash: receipt.txHash,
      timestamp,
    });

    return this.getStatus();
  }

  /**
   * Operator-initiated exit from safe state. Resumes the deterministic loop,
   * anchors a `SafeStateExited` event and audits the transition. Requires an
   * operator identity — there is no automatic resume.
   *
   * @throws if the blueprint is not currently in safe state.
   */
  async resume(operator: string, reason = "Operator resume"): Promise<SafeStateStatus> {
    if (!operator || operator.trim() === "") {
      throw new Error("resume() requires an operator identity");
    }
    if (this.status.runState !== "SAFE_STATE") {
      throw new Error(
        `Blueprint ${this.runtime.blueprintId} is not in safe state; cannot resume`,
      );
    }

    this.runtime.resume();
    const timestamp = this.now().toISOString();

    const event: AnchorEvent = {
      id: randomUUID(),
      timestamp,
      eventType: "SafeStateExited",
      // Exiting safe state is itself a notable control-integrity event; recorded
      // as WARNING (return to nominal) rather than CRITICAL.
      severity: "WARNING",
      siteId: this.runtime.siteId,
      message: `Blueprint ${this.runtime.blueprintId} resumed from safe state by ${operator}: ${reason}`,
      data: {
        blueprintId: this.runtime.blueprintId,
        operator,
        reason,
        previousSafeState: this.config.safeState,
      },
    };
    const receipt = await this.safeAnchor(event);

    await this.audit.record({
      blueprintId: this.runtime.blueprintId,
      siteId: this.runtime.siteId,
      transition: "EXITED",
      safeState: this.config.safeState,
      tickBudgetMs: this.config.tickBudgetMs,
      operator,
      reason,
      anchorHash: receipt.hash,
      anchorTxHash: receipt.txHash,
      timestamp,
    });

    this.status = {
      blueprintId: this.runtime.blueprintId,
      siteId: this.runtime.siteId,
      runState: "RUNNING",
      safeState: this.config.safeState,
    };

    return this.getStatus();
  }

  /** Drive the runtime into the configured safe state. */
  private applyAction(action: SafeStateAction): void {
    if (action === "hold-last") {
      this.runtime.holdLastOutputs();
    } else if (action === "force-zero") {
      this.runtime.forceZeroOutputs();
    } else {
      this.runtime.applySafeRecipe(action.recipe);
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
