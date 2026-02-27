/**
 * Flux Integration API Routes
 * 
 * GET  /api/flux/status     — Publisher status
 * GET  /api/flux/entities    — List all SCADA entities in Flux
 * GET  /api/flux/entities/:id — Read a specific SCADA entity
 * POST /api/flux/publish     — Force-publish pending events
 */

import { Router, type Request, type Response } from "express";
import { getFluxPublisher } from "../services/flux";

export const fluxRoutes = Router();

/** Publisher status */
fluxRoutes.get("/status", (_req: Request, res: Response) => {
  const publisher = getFluxPublisher();
  res.json(publisher.getStatus());
});

/** List all SCADA entities from Flux */
fluxRoutes.get("/entities", async (_req: Request, res: Response) => {
  try {
    const publisher = getFluxPublisher();
    const entities = await publisher.listEntities();
    res.json({ count: entities.length, entities });
  } catch (error) {
    res.status(500).json({ error: "Failed to list Flux entities" });
  }
});

/** Read a specific SCADA entity */
fluxRoutes.get("/entities/:id(*)", async (req: Request, res: Response) => {
  try {
    const publisher = getFluxPublisher();
    const entity = await publisher.getEntity(req.params.id);
    if (!entity) {
      res.status(404).json({ error: "Entity not found" });
      return;
    }
    res.json(entity);
  } catch (error) {
    res.status(500).json({ error: "Failed to read Flux entity" });
  }
});

/** Force flush pending events */
fluxRoutes.post("/publish", async (_req: Request, res: Response) => {
  try {
    const publisher = getFluxPublisher();
    await publisher.flush();
    res.json({ success: true, status: publisher.getStatus() });
  } catch (error) {
    res.status(500).json({ error: "Failed to publish" });
  }
});
