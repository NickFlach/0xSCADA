/**
 * Geometry API routes — exposes SGA classification and Phi metrics.
 * 
 * GET /api/geometry/phi          — current process integration score
 * GET /api/geometry/entities     — all classified entities with coordinates
 * GET /api/geometry/classify/:id — classify a single entity
 */

import { Router, type Request, type Response } from "express";
import { FluxPublisher } from "../services/flux/index.js";

export function geometryRoutes(fluxPublisher: FluxPublisher | null): Router {
  const router = Router();

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

  router.get("/entities", (_req: Request, res: Response) => {
    if (!fluxPublisher) {
      return res.status(503).json({ error: "Flux publisher not configured" });
    }

    const entities = fluxPublisher.getClassifiedEntities();
    res.json({
      count: entities.length,
      entities: entities.map((e) => ({
        id: e.id,
        quadrant: ["sensor", "control", "alarm", "maintenance"][e.coords.h2],
        triality: ["site", "asset", "event"][e.coords.d],
        classIndex: e.coords.classIndex,
        slot: e.coords.l,
        amplitude: e.coords.amplitude,
        phase: e.coords.phase,
        links: e.linkCount,
        lastSeen: new Date(e.lastSeen).toISOString(),
      })),
    });
  });

  return router;
}
