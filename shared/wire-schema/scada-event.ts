/**
 * Canonical NATS wire schema for `scada.events` (issue #440)
 *
 * This is the single source of truth for the payload the TS server publishes
 * and the Rust node (`0xSCADA-node/src/bridge.rs` `ScadaEvent`) consumes.
 * Field names are snake_case BY CONTRACT — the Rust consumer derives
 * serde with snake_case fields, and a camelCase payload deserializes to
 * nothing (see the drift this issue fixed).
 *
 * Rules:
 * - Every field added here must either be added to the Rust struct or be
 *   safe for serde to ignore (extras are ignored by default).
 * - The contract is pinned by twin fixtures asserted byte-for-byte on both
 *   sides: `shared/wire-schema/__tests__/scada-event.test.ts` (TS) and
 *   `0xSCADA-node/src/bridge.rs` tests (Rust).
 */

import { z } from 'zod';

/** NATS subject the Rust node subscribes to. */
export const SCADA_EVENTS_SUBJECT = 'scada.events';

export const scadaEventWireSchema = z
  .object({
    /** Asset name or tag, e.g. "TR-MAIN-01" */
    asset: z.string().min(1),
    /** Event type, e.g. "BREAKER_TRIP" */
    event_type: z.string().min(1),
    /** Site identifier */
    site_id: z.string().min(1),
    /** ISO 8601 timestamp */
    timestamp: z.string().datetime({ offset: true }),
    /** Arbitrary event payload; blake3-hashed by the node into the anchor merkle root */
    payload: z.unknown().optional(),
    /** Optional context — ignored by the Rust consumer */
    site_name: z.string().optional(),
    asset_type: z.string().optional(),
    details: z.string().optional(),
  })
  // strict() so accidental camelCase or new unagreed fields fail at the
  // publisher instead of silently vanishing at the consumer
  .strict();

export type ScadaEventWire = z.infer<typeof scadaEventWireSchema>;

/** Validate an event against the wire contract; throws ZodError on drift. */
export function buildScadaEventWire(event: ScadaEventWire): ScadaEventWire {
  return scadaEventWireSchema.parse(event);
}

/**
 * Legacy camelCase event shape (`server/bridge/event-anchor.ts`
 * AnchorableEvent). Publishing this shape raw is exactly the bug #440
 * describes — convert with {@link fromAnchorableEvent} instead.
 */
export interface LegacyAnchorableEvent {
  id: string;
  timestamp: Date | string;
  eventType: string;
  siteId: string;
  severity: 'info' | 'warning' | 'alarm' | 'critical';
  message: string;
  data?: Record<string, unknown>;
}

/** Map the legacy camelCase shape onto the canonical wire schema. */
export function fromAnchorableEvent(
  event: LegacyAnchorableEvent,
  asset: string
): ScadaEventWire {
  return buildScadaEventWire({
    asset,
    event_type: event.eventType,
    site_id: event.siteId,
    timestamp:
      event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
    payload: { ...event.data, severity: event.severity, id: event.id },
    details: event.message,
  });
}
