/**
 * Production wiring for the blueprint watchdog / safe-state core (#459).
 *
 * The core ({@link ../safe-state}, {@link ../watchdog}) is deliberately
 * dependency-free and unit-testable. This module adapts the real systems —
 * the canonical anchor backend and the Drizzle audit table — to the minimal
 * interfaces the core consumes.
 *
 * Keeping these adapters separate means the trip logic can be exercised in unit
 * tests with in-memory fakes, while production code composes the real backends.
 */

import { getDatabase, getDatabaseType } from "../storage";
import { eventAnchorBridge } from "../bridge/event-anchor";
import { log, logError } from "../logger";
import { blueprintSafeStateLog } from "@shared/schema";
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
 * INTEGRATION (#443/#455): when the canonical anchor backend lands, swap the
 * bridge call below for it. The contract this adapter must uphold: submit the
 * event for anchoring and return a content hash immediately so the transition
 * is auditable before the batch is mined.
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

/**
 * Persists safe-state transitions to the `blueprint_safe_state_log` table via
 * the shared Drizzle handle. DB access goes through server/storage.ts per repo
 * convention.
 */
export class DrizzleSafeStateAuditSink implements SafeStateAuditSink {
  constructor(
    private readonly dependencies: {
      getDatabase: typeof getDatabase;
      getDatabaseType: typeof getDatabaseType;
    } = { getDatabase, getDatabaseType },
  ) {}

  async record(entry: SafeStateAuditEntry): Promise<void> {
    try {
      // The development SQLite "Drizzle-compatible" wrapper intentionally
      // implements only a subset of tables and its generic insert is a no-op.
      // Refuse that path so an operator can never mistake a discarded audit
      // transition for a durable write.
      if (this.dependencies.getDatabaseType() !== "postgres") {
        throw new Error(
          "blueprint safe-state audit requires PostgreSQL; the SQLite fallback has no durable audit-table adapter",
        );
      }

      await this.dependencies
        .getDatabase()
        .insert(blueprintSafeStateLog)
        .values({
          blueprintId: entry.blueprintId,
          siteId: entry.siteId,
          transition: entry.transition,
          safeState: entry.safeState as unknown as Record<string, unknown>,
          tickBudgetMs: entry.tickBudgetMs,
          consecutiveMisses: entry.consecutiveMisses,
          operator: entry.operator,
          reason: entry.reason,
          anchorHash: entry.anchorHash,
          anchorTxHash: entry.anchorTxHash,
          createdAt: new Date(entry.timestamp),
        })
        .onConflictDoNothing({ target: blueprintSafeStateLog.anchorHash });
      log(
        `Safe-state ${entry.transition} audited for blueprint ${entry.blueprintId} ` +
          `(anchor ${entry.anchorHash ?? "n/a"})`,
      );
    } catch (error) {
      logError(error, `Failed to persist safe-state audit for ${entry.blueprintId}`);
      // The physical safe state has already been applied on ENTERED. Propagate
      // persistence failure so callers/health cannot report an audited
      // transition that was silently discarded.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Safe-state audit persistence failed for ${entry.blueprintId}: ${detail}`,
      );
    }
  }
}
