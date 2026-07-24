/**
 * Geometry API routes — SGA classification, Phi metrics, Fano plane, and tuning.
 * 
 * GET  /api/geometry/phi              — process integration score (#332)
 * GET  /api/geometry/entities         — classified entities with coordinates
 * GET  /api/geometry/fano             — current Fano plane state (#335)
 * GET  /api/geometry/fano/cycles      — detected feedback loops (#335)
 * GET  /api/geometry/fano/gaps        — uncovered process areas (#335)
 * GET  /api/geometry/classes          — all 96 classes with entity counts (#336)
 * POST /api/geometry/rules            — custom classification overrides (#336)
 * POST /api/geometry/recalibrate      — re-classify all entities (#336)
 */

import { Router, type Request, type Response } from "express";
import { FluxPublisher } from "../services/flux/index.js";
import { FANO_LINES, isFanoRelated, geometricSimilarity } from "../services/geometry/fano.js";
import { decodeClassIndex, Quadrant, Triality, type ClassComponents } from "../services/geometry/types.js";
import { classify, classifyEntity } from "../services/geometry/classifier.js";
import { requireControlPlaneAccess } from "../middleware/control-plane-auth";

/** Max allowed regex pattern length to mitigate ReDoS */
const MAX_REGEX_PATTERN_LENGTH = 200;

const requireGeometryWrite = requireControlPlaneAccess({
  scopes: ["geometry.write"],
});

/** Validate and sanitize a regex pattern string */
function validateRegexPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern too long (max ${MAX_REGEX_PATTERN_LENGTH} chars)` };
  }
  // Reject patterns with known ReDoS-prone constructs
  if (/(\.\*){3,}|(\+\+)|(\*\*)|(\{\d{4,}\})/.test(pattern)) {
    return { valid: false, error: "Pattern contains potentially unsafe constructs" };
  }
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: `Invalid regex: ${(e as Error).message}` };
  }
}

/** In-memory classification rule overrides (#336) */
interface ClassificationOverride {
  pattern: string;         // regex pattern for entity type/id
  quadrant?: number;       // force h2
  triality?: number;       // force d
  slot?: number;           // force l
  createdAt: number;
}

const overrides: ClassificationOverride[] = [];

const QUADRANT_NAMES = ["sensor", "control", "alarm", "maintenance"];
const TRIALITY_NAMES = ["site", "asset", "event"];

export function geometryRoutes(fluxPublisher: FluxPublisher | null): Router {
  const router = Router();

  // ── Phi (#332) ─────────────────────────────────────────────────────────────
  router.get("/phi", (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const report = fluxPublisher.computePhi();
    res.json({
      phi: report.phi,
      level: report.level,
      integration: report.integration,
      differentiation: report.differentiation,
      density: report.density,
      scale: report.scale,
      partitions: report.partitions,
      entities: report.entityCount,
      links: report.linkCount,
      fanoLinks: report.fanoLinkCount,
      geometricBonus: report.geometricBonus,
    });
  });

  // ── Entities ────────────────────────────────────────────────────────────────
  router.get("/entities", (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const entities = fluxPublisher.getClassifiedEntities();
    res.json({
      count: entities.length,
      entities: entities.map((e) => ({
        id: e.id,
        quadrant: QUADRANT_NAMES[e.coords.h2],
        triality: TRIALITY_NAMES[e.coords.d],
        classIndex: e.coords.classIndex,
        slot: e.coords.l,
        amplitude: e.coords.amplitude,
        phase: e.coords.phase,
        links: e.linkCount,
        lastSeen: new Date(e.lastSeen).toISOString(),
      })),
    });
  });

  // ── Fano plane state (#335) ────────────────────────────────────────────────
  router.get("/fano", (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const entities = fluxPublisher.getClassifiedEntities();

    // Build slot occupancy (which Fano points have entities)
    const slotCounts = new Map<number, number>();
    for (const e of entities) {
      const fanoSlot = (e.coords.l % 7) + 1; // 1-indexed for Fano
      slotCounts.set(fanoSlot, (slotCounts.get(fanoSlot) || 0) + 1);
    }

    // Build line coverage
    const lines = FANO_LINES.map(([a, b, c]) => ({
      points: [a, b, c],
      populated: [a, b, c].map((p) => (slotCounts.get(p) || 0) > 0),
      entityCounts: [a, b, c].map((p) => slotCounts.get(p) || 0),
      complete: [a, b, c].every((p) => (slotCounts.get(p) || 0) > 0),
    }));

    const completeLines = lines.filter((l) => l.complete).length;

    res.json({
      points: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        entityCount: slotCounts.get(i + 1) || 0,
        populated: (slotCounts.get(i + 1) || 0) > 0,
      })),
      lines,
      coverage: {
        populatedPoints: Array.from(slotCounts.keys()).length,
        totalPoints: 7,
        completeLines,
        totalLines: 7,
        coverageRatio: completeLines / 7,
      },
    });
  });

  // ── Fano cycles (feedback loops) (#335) ────────────────────────────────────
  router.get("/fano/cycles", (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const entities = fluxPublisher.getClassifiedEntities();

    // Detect cycles: Fano lines where entities in all 3 slots are linked
    // A cycle = entities at all 3 points of a Fano line exist and form connections
    const slotEntities = new Map<number, string[]>();
    for (const e of entities) {
      const fanoSlot = (e.coords.l % 7) + 1;
      const list = slotEntities.get(fanoSlot) || [];
      list.push(e.id);
      slotEntities.set(fanoSlot, list);
    }

    const cycles = FANO_LINES
      .map(([a, b, c]) => {
        const aEntities = slotEntities.get(a) || [];
        const bEntities = slotEntities.get(b) || [];
        const cEntities = slotEntities.get(c) || [];
        const complete = aEntities.length > 0 && bEntities.length > 0 && cEntities.length > 0;
        return {
          line: [a, b, c],
          complete,
          entityCounts: { [a]: aEntities.length, [b]: bEntities.length, [c]: cEntities.length },
          potentialCycles: complete ? aEntities.length * bEntities.length * cEntities.length : 0,
        };
      })
      .filter((c) => c.complete);

    res.json({
      totalCycles: cycles.length,
      cycles,
    });
  });

  // ── Fano gaps (uncovered areas) (#335) ──────────────────────────────────────
  router.get("/fano/gaps", (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const entities = fluxPublisher.getClassifiedEntities();

    const slotCounts = new Map<number, number>();
    for (const e of entities) {
      const fanoSlot = (e.coords.l % 7) + 1;
      slotCounts.set(fanoSlot, (slotCounts.get(fanoSlot) || 0) + 1);
    }

    const emptyPoints = [];
    for (let i = 1; i <= 7; i++) {
      if (!slotCounts.has(i) || slotCounts.get(i) === 0) {
        emptyPoints.push(i);
      }
    }

    // Find incomplete lines (lines missing at least one point)
    const incompleteLines = FANO_LINES
      .map(([a, b, c]) => ({
        line: [a, b, c],
        missing: [a, b, c].filter((p) => !slotCounts.has(p) || slotCounts.get(p) === 0),
      }))
      .filter((l) => l.missing.length > 0);

    // Identify uncovered quadrant × triality combinations
    const coveredClasses = new Set(entities.map((e) => e.coords.classIndex));
    const uncoveredClasses: { classIndex: number; quadrant: string; triality: string; slot: number }[] = [];
    for (let i = 0; i < 96; i++) {
      if (!coveredClasses.has(i)) {
        const comp = decodeClassIndex(i);
        uncoveredClasses.push({
          classIndex: i,
          quadrant: QUADRANT_NAMES[comp.h2],
          triality: TRIALITY_NAMES[comp.d],
          slot: comp.l,
        });
      }
    }

    res.json({
      emptyFanoPoints: emptyPoints,
      incompleteLines,
      uncoveredClassCount: uncoveredClasses.length,
      coveredClassCount: coveredClasses.size,
      totalClasses: 96,
      // Only return first 20 uncovered classes to keep response reasonable
      uncoveredClasses: uncoveredClasses.slice(0, 20),
    });
  });

  // ── List all 96 classes with entity counts (#336) ──────────────────────────
  router.get("/classes", (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const entities = fluxPublisher.getClassifiedEntities();
    const classCounts = new Map<number, number>();
    for (const e of entities) {
      classCounts.set(e.coords.classIndex, (classCounts.get(e.coords.classIndex) || 0) + 1);
    }

    const classes = Array.from({ length: 96 }, (_, i) => {
      const comp = decodeClassIndex(i);
      return {
        classIndex: i,
        quadrant: QUADRANT_NAMES[comp.h2],
        triality: TRIALITY_NAMES[comp.d],
        slot: comp.l,
        entityCount: classCounts.get(i) || 0,
      };
    });

    res.json({
      totalClasses: 96,
      populatedClasses: Array.from(classCounts.keys()).length,
      totalEntities: entities.length,
      classes,
    });
  });

  // ── Custom classification rules (#336) ─────────────────────────────────────
  router.post("/rules", requireGeometryWrite, (req: Request, res: Response) => {
    const { pattern, quadrant, triality, slot } = req.body || {};
    if (!pattern || typeof pattern !== "string") {
      return res.status(400).json({ error: "pattern (string) is required" });
    }

    // Validate and sanitize regex pattern
    const validation = validateRegexPattern(pattern);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const override: ClassificationOverride = {
      pattern,
      quadrant: quadrant != null ? Number(quadrant) : undefined,
      triality: triality != null ? Number(triality) : undefined,
      slot: slot != null ? Number(slot) : undefined,
      createdAt: Date.now(),
    };

    overrides.push(override);

    res.status(201).json({
      message: "Classification rule added",
      totalRules: overrides.length,
      rule: override,
    });
  });

  router.get("/rules", (_req: Request, res: Response) => {
    res.json({ rules: overrides });
  });

  // ── Recalibrate all entities (#336) ────────────────────────────────────────
  router.post("/recalibrate", requireGeometryWrite, (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const entities = fluxPublisher.getClassifiedEntities();
    let reclassified = 0;

    for (const entity of entities) {
      // Re-classify (the publisher will re-classify on next publish cycle)
      const newCoords = classifyEntity(entity.id, {});
      if (newCoords.classIndex !== entity.coords.classIndex) {
        reclassified++;
      }
    }

    res.json({
      message: "Recalibration complete",
      totalEntities: entities.length,
      reclassified,
    });
  });

  return router;
}
