/**
 * Alarm API Routes
 * 
 * Issue #42: REST API Baseline (Read-Heavy)
 * 
 * Read endpoints for alarms with filtering by severity, state, time range.
 * Alarms are sourced from:
 *   1. Events table (eventType = 'ALARM') for historical alarms
 *   2. In-memory alarm state from the tag service for active alarms
 */

import { Router, type Request, type Response } from "express";
import { db } from "../db";
import { events } from "@shared/schema";
import { eq, and, gte, lte, desc, asc, count, sql } from "drizzle-orm";
import { parsePagination, paginatedResponse } from "../middleware/pagination";

export const alarmRoutes = Router();

// =============================================================================
// TYPES
// =============================================================================

export type AlarmSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlarmState = "ACTIVE" | "ACKNOWLEDGED" | "CLEARED" | "SHELVED";

export interface ActiveAlarm {
  id: string;
  tag: string;
  assetId?: string;
  severity: AlarmSeverity;
  state: AlarmState;
  message: string;
  value?: number;
  threshold?: number;
  activatedAt: string;
  acknowledgedAt?: string;
  clearedAt?: string;
  acknowledgedBy?: string;
}

// =============================================================================
// IN-MEMORY ALARM STATE (for active/real-time alarms)
// =============================================================================

const activeAlarms = new Map<string, ActiveAlarm>();
let alarmIdCounter = 0;

/** Raise an alarm (called by tag service or other subsystems) */
export function raiseAlarm(alarm: Omit<ActiveAlarm, "id" | "state" | "activatedAt">): ActiveAlarm {
  const id = `ALM-${++alarmIdCounter}`;
  const record: ActiveAlarm = {
    ...alarm,
    id,
    state: "ACTIVE",
    activatedAt: new Date().toISOString(),
  };
  activeAlarms.set(id, record);
  return record;
}

/** Acknowledge an alarm */
export function acknowledgeAlarm(id: string, user: string): ActiveAlarm | null {
  const alarm = activeAlarms.get(id);
  if (!alarm || alarm.state !== "ACTIVE") return null;
  alarm.state = "ACKNOWLEDGED";
  alarm.acknowledgedAt = new Date().toISOString();
  alarm.acknowledgedBy = user;
  return alarm;
}

/** Clear an alarm */
export function clearAlarm(id: string): ActiveAlarm | null {
  const alarm = activeAlarms.get(id);
  if (!alarm) return null;
  alarm.state = "CLEARED";
  alarm.clearedAt = new Date().toISOString();
  return alarm;
}

// =============================================================================
// GET /api/alarms/active — Active alarms (in-memory)
// =============================================================================
alarmRoutes.get("/active", (req: Request, res: Response) => {
  let alarms = Array.from(activeAlarms.values());

  // Filter by severity
  if (req.query.severity) {
    const sev = (req.query.severity as string).toUpperCase();
    alarms = alarms.filter(a => a.severity === sev);
  }

  // Filter by state
  if (req.query.state) {
    const st = (req.query.state as string).toUpperCase();
    alarms = alarms.filter(a => a.state === st);
  }

  // Filter by tag pattern
  if (req.query.tag) {
    const pattern = (req.query.tag as string).toLowerCase();
    alarms = alarms.filter(a => a.tag.toLowerCase().includes(pattern));
  }

  // Sort by activatedAt desc (most recent first)
  alarms.sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));

  res.json({
    data: alarms,
    total: alarms.length,
  });
});

// =============================================================================
// POST /api/alarms/:id/acknowledge
// =============================================================================
alarmRoutes.post("/:id/acknowledge", (req: Request, res: Response) => {
  const user = req.body.user || "anonymous";
  const alarm = acknowledgeAlarm(req.params.id, user);
  if (!alarm) {
    res.status(404).json({ error: "Alarm not found or not in ACTIVE state" });
    return;
  }
  res.json(alarm);
});

// =============================================================================
// POST /api/alarms/:id/clear
// =============================================================================
alarmRoutes.post("/:id/clear", (req: Request, res: Response) => {
  const alarm = clearAlarm(req.params.id);
  if (!alarm) {
    res.status(404).json({ error: "Alarm not found" });
    return;
  }
  res.json(alarm);
});

// =============================================================================
// GET /api/alarms/history — Historical alarms from events table
// =============================================================================
alarmRoutes.get("/history", parsePagination("sourceTimestamp"), async (req: Request, res: Response) => {
  try {
    const p = req.pagination!;
    const conditions = [eq(events.eventType, "ALARM")];

    // Time range filters
    if (p.filters.from) {
      conditions.push(gte(events.sourceTimestamp, new Date(p.filters.from)));
    }
    if (p.filters.to) {
      conditions.push(lte(events.sourceTimestamp, new Date(p.filters.to)));
    }

    // Filter by asset
    if (p.filters.asset_id) {
      conditions.push(eq(events.assetId, p.filters.asset_id));
    }

    // Filter by site
    if (p.filters.site_id) {
      conditions.push(eq(events.siteId, p.filters.site_id));
    }

    // Severity filter via payload JSONB
    if (p.filters.severity) {
      conditions.push(
        sql`${events.payload}->>'severity' = ${p.filters.severity.toUpperCase()}`
      );
    }

    const where = and(...conditions);
    const orderFn = p.sortOrder === "asc" ? asc : desc;
    const sortCol = events.sourceTimestamp;

    const [data, [{ total }]] = await Promise.all([
      db.select().from(events).where(where).orderBy(orderFn(sortCol)).limit(p.limit).offset(p.offset),
      db.select({ total: count() }).from(events).where(where),
    ]);

    res.json(paginatedResponse(data, total, p, "/api/alarms/history"));
  } catch (error) {
    console.error("Error fetching alarm history:", error);
    res.status(500).json({ error: "Failed to fetch alarm history" });
  }
});

// =============================================================================
// GET /api/alarms/summary — Alarm counts by severity
// =============================================================================
alarmRoutes.get("/summary", (_req: Request, res: Response) => {
  const alarms = Array.from(activeAlarms.values());
  const summary = {
    total: alarms.length,
    bySeverity: {
      CRITICAL: alarms.filter(a => a.severity === "CRITICAL").length,
      HIGH: alarms.filter(a => a.severity === "HIGH").length,
      MEDIUM: alarms.filter(a => a.severity === "MEDIUM").length,
      LOW: alarms.filter(a => a.severity === "LOW").length,
      INFO: alarms.filter(a => a.severity === "INFO").length,
    },
    byState: {
      ACTIVE: alarms.filter(a => a.state === "ACTIVE").length,
      ACKNOWLEDGED: alarms.filter(a => a.state === "ACKNOWLEDGED").length,
      CLEARED: alarms.filter(a => a.state === "CLEARED").length,
      SHELVED: alarms.filter(a => a.state === "SHELVED").length,
    },
  };
  res.json(summary);
});
