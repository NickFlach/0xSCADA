/**
 * Production data port for the NL query engine.
 * Issue #216; contract in docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 *
 * This is what "query REAL data" means for this feature. There are exactly
 * three backing stores on current `main`, and this adapter reads all three:
 *
 *   - **Tag catalogue and history** — the `historian_data` table. There is no
 *     dedicated tag table in `shared/schema.ts`; the tag id space is defined by
 *     what the historian has recorded, which is the same projection
 *     `server/protocols/opcua-server/runtime.ts` uses for its address space.
 *   - **Latest values** — `tagStreamServer.getLatestValues()`, the live stream
 *     the gateway scan loop and the field simulator already publish to. A live
 *     sample is preferred over the newest historian row when one exists,
 *     because it is fresher; the reading records which it came from so the
 *     answer can cite its provenance.
 *   - **Active alarms** — `alarmCorrelationService.engine`, over alarms that
 *     were actually ingested through `/api/alarm-correlation`.
 *
 * What this adapter will NOT do:
 *
 *   - It never constructs SQL from operator text. Every query is a Drizzle
 *     query-builder expression with bound parameters; the operator's string
 *     only ever reaches a parameter slot, never the statement.
 *   - It never fabricates a value. When there is no database, when the SQLite
 *     development fallback is active (it has no `historian_data` table), or
 *     when a query throws, the method returns `available: false` with a reason
 *     and the engine says so in its answer.
 *
 * Bounding: every method takes an explicit cap and pushes it down to the store
 * as a SQL `LIMIT` (fetching cap+1 to detect truncation), so an oversized row
 * set is never materialised in the API process.
 */

import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@shared/schema';
import type {
  ActiveAlarmPage,
  ActiveAlarmSummary,
  HistorySlice,
  NLQueryDataPort,
  PortResult,
  TagCatalogue,
  TagReading,
} from '@shared/types/nl-query';
import { getDatabase, getDatabaseType } from '../../storage';
import { tagStreamServer, type TagUpdate } from '../../websocket/tag-stream';
import { alarmCorrelationService } from '../alarm-correlation';

/** Alarm lifecycle states that mean "still demanding operator attention". */
const ACTIVE_ALARM_STATES = new Set(['active', 'acknowledged', 'unacknowledged']);

/**
 * The historian is Postgres-only. `server/storage.ts` multiplexes a Drizzle
 * Postgres client and a reduced SQLite development stub, and the stub does not
 * carry `historian_data` — the same limitation `opcua-server/runtime.ts`
 * documents. Reporting that plainly is the honest behaviour; inventing a
 * reading to fill the gap is not.
 */
function historianDatabase(): PortResult<NodePgDatabase<typeof schema>> {
  if (getDatabaseType() !== 'postgres') {
    return {
      available: false,
      reason:
        `the historian is not available on the ${getDatabaseType()} development `
        + 'database (no historian_data table)',
    };
  }
  // `getDatabase()` THROWS when the pool was never initialized, and `dbType`
  // defaults to 'postgres' before `initializeDatabase()` runs — so the
  // uninitialized process reaches exactly this line. Catch it here and turn it
  // into a reason string; letting it escape would replace a precise
  // "no database connection" message with the engine's generic failure text.
  try {
    const db = getDatabase();
    if (!db) {
      return { available: false, reason: 'no database connection is configured' };
    }
    return { available: true, value: db as NodePgDatabase<typeof schema> };
  } catch (error) {
    return { available: false, reason: failureReason(error) };
  }
}

function failureReason(error: unknown): string {
  return reasonFragment(error instanceof Error ? error.message : String(error));
}

/**
 * Normalise a reason so it composes into a sentence. Store errors arrive as
 * full sentences ("Database not initialized. Call initializeDatabase() first.");
 * trailing punctuation would produce "... first., and no tags ..." once joined.
 */
function reasonFragment(reason: string): string {
  return reason.trim().replace(/[.\s]+$/, '');
}

/** Map a live tag-stream update onto a reading, or null if not representable. */
function readingFromStream(update: TagUpdate): TagReading | null {
  if (typeof update.value === 'boolean') return null;
  const timestamp = new Date(update.timestamp).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return {
    tagId: update.tagName,
    value: update.value,
    quality: update.quality,
    timestamp,
    source: 'live-stream',
  };
}

/**
 * Historian rows carry either a numeric `value` or a `stringValue`. A row with
 * neither is dropped rather than defaulted to 0.
 */
function readingFromHistorian(
  tagId: string,
  row: { value: number | null; stringValue: string | null; quality: number | null; timestamp: Date },
): TagReading | null {
  const value: number | string | null =
    row.value !== null ? row.value : row.stringValue;
  if (value === null) return null;
  return {
    tagId,
    value,
    quality: row.quality === null ? undefined : String(row.quality),
    timestamp: row.timestamp.getTime(),
    source: 'historian',
  };
}

export class ProcessDataPort implements NLQueryDataPort {
  /**
   * Union of the historian's recorded tag ids and the tags currently on the
   * live stream, capped at `limit`.
   *
   * The live stream alone is a valid catalogue when the historian is
   * unavailable — a dev box running the simulator has real tags with no
   * database — so the catalogue is only reported unavailable when BOTH sources
   * are empty and the historian could not be consulted.
   */
  async listTags(limit: number): Promise<PortResult<TagCatalogue>> {
    const cap = Math.max(0, limit);
    const liveTags = [...tagStreamServer.getLatestValues().keys()];

    const db = historianDatabase();
    if (!db.available) {
      if (liveTags.length === 0) {
        return {
          available: false,
          reason: `${db.reason}; no tags are on the live stream either`,
        };
      }
      const tagIds = liveTags.slice(0, cap).sort();
      return {
        available: true,
        value: { tagIds, truncated: liveTags.length > cap },
      };
    }

    try {
      // Fetch cap+1 so truncation is detected without a second COUNT query.
      const rows = await db.value
        .selectDistinct({ tagId: schema.historianData.tagId })
        .from(schema.historianData)
        .orderBy(schema.historianData.tagId)
        .limit(cap + 1);

      const merged = new Set<string>(rows.map((r) => r.tagId));
      const historianTruncated = rows.length > cap;
      // Merge at most cap+1 live tag ids. The historian side is already
      // bounded by its SQL LIMIT, but `liveTags` is the whole live-stream map,
      // which on a large site is far larger than `cap` — merging and sorting
      // all of it would do unbounded per-request work for a result that is
      // sliced back to `cap` anyway. One extra element is enough to detect
      // that the union overflowed.
      const liveTruncated = liveTags.length > cap;
      for (const tagId of liveTags.slice(0, cap + 1)) merged.add(tagId);

      const all = [...merged].sort();
      return {
        available: true,
        value: {
          tagIds: all.slice(0, cap),
          truncated: historianTruncated || liveTruncated || all.length > cap,
        },
      };
    } catch (error) {
      if (liveTags.length > 0) {
        const tagIds = liveTags.slice(0, cap).sort();
        return {
          available: true,
          value: { tagIds, truncated: liveTags.length > cap },
        };
      }
      return {
        available: false,
        reason: `historian tag catalogue query failed: ${failureReason(error)}`,
      };
    }
  }

  /**
   * Prefer the live stream (freshest), fall back to the newest historian row.
   * `available: true` with `value: null` means "consulted, nothing recorded" —
   * distinct from `available: false`, "could not consult".
   */
  async readLatest(tagId: string): Promise<PortResult<TagReading | null>> {
    const live = tagStreamServer.getLatestValues().get(tagId);
    if (live) {
      const reading = readingFromStream(live);
      if (reading) return { available: true, value: reading };
    }

    const db = historianDatabase();
    if (!db.available) return db;

    try {
      const rows = await db.value
        .select({
          value: schema.historianData.value,
          stringValue: schema.historianData.stringValue,
          quality: schema.historianData.quality,
          timestamp: schema.historianData.timestamp,
        })
        .from(schema.historianData)
        .where(eq(schema.historianData.tagId, tagId))
        .orderBy(desc(schema.historianData.timestamp))
        .limit(1);

      const row = rows[0];
      if (!row) return { available: true, value: null };
      return { available: true, value: readingFromHistorian(tagId, row) };
    } catch (error) {
      return {
        available: false,
        reason: `historian read failed: ${failureReason(error)}`,
      };
    }
  }

  async readHistory(
    tagId: string,
    startMs: number,
    endMs: number,
    maxSamples: number,
  ): Promise<PortResult<HistorySlice>> {
    const db = historianDatabase();
    if (!db.available) return db;

    const cap = Math.max(0, maxSamples);
    try {
      const rows = await db.value
        .select({
          value: schema.historianData.value,
          stringValue: schema.historianData.stringValue,
          quality: schema.historianData.quality,
          timestamp: schema.historianData.timestamp,
        })
        .from(schema.historianData)
        .where(
          and(
            eq(schema.historianData.tagId, tagId),
            gte(schema.historianData.timestamp, new Date(startMs)),
            lte(schema.historianData.timestamp, new Date(endMs)),
          ),
        )
        .orderBy(schema.historianData.timestamp)
        // cap+1 detects truncation; the extra row is dropped below.
        .limit(cap + 1);

      const truncated = rows.length > cap;
      const samples: TagReading[] = [];
      for (const row of rows.slice(0, cap)) {
        const reading = readingFromHistorian(tagId, row);
        if (reading) samples.push(reading);
      }
      return { available: true, value: { samples, truncated } };
    } catch (error) {
      return {
        available: false,
        reason: `historian history query failed: ${failureReason(error)}`,
      };
    }
  }

  /**
   * Active alarms from the correlation engine — real alarms that were ingested
   * through `/api/alarm-correlation`, not a synthesised list.
   */
  async listActiveAlarms(limit: number): Promise<PortResult<ActiveAlarmPage>> {
    const cap = Math.max(0, limit);
    try {
      const groups = alarmCorrelationService.engine.getGroups({ state: 'open' });
      const alarms: ActiveAlarmSummary[] = [];
      let truncated = false;

      for (const group of groups) {
        for (const alarm of group.alarms) {
          if (!ACTIVE_ALARM_STATES.has(alarm.state)) continue;
          if (alarms.length >= cap) {
            truncated = true;
            break;
          }
          alarms.push({
            id: alarm.id,
            name: alarm.name,
            tagId: alarm.tagId,
            severity: alarm.severity,
            state: alarm.state,
            message: alarm.message,
            timestamp: alarm.timestamp,
          });
        }
        if (truncated) break;
      }

      return { available: true, value: { alarms, truncated } };
    } catch (error) {
      return {
        available: false,
        reason: `alarm correlation read failed: ${failureReason(error)}`,
      };
    }
  }
}
