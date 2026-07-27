/**
 * Production wiring for the blueprint watchdog / safe-state core (#459).
 *
 * The core ({@link ../safe-state}, {@link ../watchdog}) is deliberately
 * dependency-free and unit-testable. This module adapts the real systems —
 * the event-anchor bridge and the durable audit table — to the minimal
 * interfaces the core consumes.
 *
 * Keeping these adapters separate means the trip logic can be exercised in unit
 * tests with in-memory fakes, while production code composes the real backends.
 */

import {
  insertBlueprintSafeStateLog,
  type SafeStateLogInsert,
} from "../storage";
import { eventAnchorBridge } from "../bridge/event-anchor";
import { log, logError } from "../logger";
import {
  computeAnchorHash,
  type AnchorBackend,
  type AnchorEvent,
  type AnchorReceipt,
  type SafeStateAuditSink,
  type SafeStateAuditEntry,
} from "./safe-state";

/**
 * Adapts the existing {@link eventAnchorBridge} (fire-and-forget, batched) to
 * the synchronous {@link AnchorBackend} the safe-state controller expects.
 *
 * The contract this adapter upholds: submit the event for anchoring and return
 * a content hash immediately so the transition is auditable before the batch is
 * mined.
 */
export class BridgeAnchorBackend implements AnchorBackend {
  async anchor(event: AnchorEvent): Promise<AnchorReceipt> {
    const hash = computeAnchorHash(event);
    // The bridge batches and anchors asynchronously; map our CRITICAL severity
    // to its lowercase severity vocabulary.
    await eventAnchorBridge.anchor({
      id: event.id,
      timestamp: new Date(event.timestamp),
      eventType: event.eventType,
      siteId: event.siteId ?? "unknown",
      severity: event.severity.toLowerCase() as "critical" | "warning" | "info",
      message: event.message,
      data: { ...event.data, contentHash: hash },
    });
    return { hash };
  }
}

/** Injectable persistence seam, so the sink can be unit-tested without a DB. */
export type SafeStateLogWriter = (entry: SafeStateLogInsert) => Promise<void>;

/**
 * Persists safe-state transitions to `blueprint_safe_state_log`.
 *
 * Both dialects are durable: PostgreSQL via the Drizzle table created by
 * migrations/0009_blueprint_safe_state_log.sql, SQLite via the table in
 * `blueprintSqliteSchema` (applied on every database open). The write is
 * idempotent on `anchor_hash`, so the controller's retry of an ambiguous entry
 * cannot duplicate a row.
 */
export class StorageSafeStateAuditSink implements SafeStateAuditSink {
  constructor(
    private readonly write: SafeStateLogWriter = insertBlueprintSafeStateLog,
  ) {}

  async record(entry: SafeStateAuditEntry): Promise<void> {
    try {
      await this.write({
        blueprintId: entry.blueprintId,
        siteId: entry.siteId,
        transition: entry.transition,
        safeState: entry.safeState,
        tickBudgetMs: entry.tickBudgetMs,
        consecutiveMisses: entry.consecutiveMisses,
        operator: entry.operator,
        reason: entry.reason,
        anchorHash: entry.anchorHash,
        anchorTxHash: entry.anchorTxHash,
        createdAt: new Date(entry.timestamp),
      });
      log(
        `Safe-state ${entry.transition} audited for blueprint ${entry.blueprintId} ` +
          `(anchor ${entry.anchorHash})`,
      );
    } catch (error) {
      logError(error, `Failed to persist safe-state audit for ${entry.blueprintId}`);
      // The physical safe state has already been applied on ENTERED. Propagate
      // the persistence failure so callers/health cannot report an audited
      // transition that was silently discarded.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Safe-state audit persistence failed for ${entry.blueprintId}: ${detail}`,
      );
    }
  }
}
