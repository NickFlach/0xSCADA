/**
 * P&ID Diagram API Routes
 *
 * CRUD endpoints for P&ID diagrams (store/retrieve diagram JSON).
 */

import { Router, type Request, type Response } from 'express';
import type { PIDDiagram, CreateDiagramRequest, UpdateDiagramRequest, DiagramListItem } from '../../shared/types/pid';
import { randomUUID } from 'crypto';

// =============================================================================
// IN-MEMORY STORE (replace with DB in production)
// =============================================================================

const diagrams = new Map<string, PIDDiagram>();

// Seed with a demo diagram
diagrams.set('demo', {
  id: 'demo',
  name: 'Demo — Process Unit 100',
  drawingNumber: 'P&ID-100-001',
  revision: 'A',
  canvasSize: { width: 1400, height: 900 },
  gridSize: 20,
  symbols: [],
  connections: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// =============================================================================
// ROUTER
// =============================================================================

const router = Router();

/** List all diagrams */
router.get('/diagrams', (_req: Request, res: Response) => {
  const list: DiagramListItem[] = Array.from(diagrams.values()).map(d => ({
    id: d.id,
    name: d.name,
    drawingNumber: d.drawingNumber,
    revision: d.revision,
    updatedAt: d.updatedAt,
  }));
  res.json(list);
});

/** Get a single diagram */
router.get('/diagrams/:id', (req: Request, res: Response) => {
  const diagram = diagrams.get(req.params.id);
  if (!diagram) {
    return res.status(404).json({ error: 'Diagram not found' });
  }
  res.json(diagram);
});

/** Create a new diagram */
router.post('/diagrams', (req: Request, res: Response) => {
  const body = req.body as CreateDiagramRequest;
  const id = randomUUID();
  const now = new Date().toISOString();

  const diagram: PIDDiagram = {
    id,
    name: body.name || 'Untitled P&ID',
    description: body.description,
    drawingNumber: body.drawingNumber,
    canvasSize: body.canvasSize ?? { width: 1200, height: 800 },
    gridSize: 20,
    symbols: [],
    connections: [],
    createdAt: now,
    updatedAt: now,
  };

  diagrams.set(id, diagram);
  res.status(201).json(diagram);
});

/** Update a diagram */
router.put('/diagrams/:id', (req: Request, res: Response) => {
  const existing = diagrams.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Diagram not found' });
  }

  const body = req.body as UpdateDiagramRequest;
  const updated: PIDDiagram = {
    ...existing,
    ...body,
    id: existing.id, // prevent ID change
    updatedAt: new Date().toISOString(),
  };

  diagrams.set(existing.id, updated);
  res.json(updated);
});

/** Delete a diagram */
router.delete('/diagrams/:id', (req: Request, res: Response) => {
  if (!diagrams.has(req.params.id)) {
    return res.status(404).json({ error: 'Diagram not found' });
  }
  diagrams.delete(req.params.id);
  res.status(204).send();
});

export default router;
