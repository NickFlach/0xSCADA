/**
 * Cross-Fork Artifact Pipeline Routes
 * 
 * VERITY Architecture - Phase α.2: Cross-Fork Artifact Pipeline
 * 
 * HTTP API endpoints for:
 * - Artifact ingestion from all three forks
 * - Cross-fork dependency linking
 * - Artifact lineage queries
 * - Pipeline statistics
 */

import { Router, Request, Response } from "express";
import { z } from "zod";

import { crossForkPipeline } from "../services/cross-fork-pipeline";
import type { ContentHash } from "@shared/artifact";
import {
  createKernelTraceInputSchema,
  createSensorBurstInputSchema,
  createFirmwareImageInputSchema,
  createDeviceStateSnapshotInputSchema,
} from "@shared/linux-artifact";

const router = Router();

// =============================================================================
// AGENTIC-QE INPUT SCHEMAS
// =============================================================================

const ingestAgentDecisionSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  siteId: z.string().optional(),
  assetIds: z.array(z.string()).optional(),
  inputArtifacts: z.array(z.string()),
  contextHash: z.string(),
  constraintsHash: z.string(),
  chainOfThoughtHash: z.string(),
  model: z.string(),
  temperature: z.number(),
  tokens: z.number().int(),
  decisionText: z.string(),
  action: z.unknown().optional(),
  confidence: z.number().min(0).max(1),
  automatedChecks: z.array(z.unknown()).optional(),
  safetyScore: z.number().optional(),
});

const ingestWorldModelSchema = z.object({
  agentId: z.string(),
  modelType: z.string(),
  version: z.string(),
  inputArtifacts: z.array(z.string()),
  modelData: z.union([z.string(), z.instanceof(Buffer), z.instanceof(Uint8Array)]),
  metadata: z.record(z.unknown()).optional(),
  siteId: z.string().optional(),
});

const ingestEmbeddingSchema = z.object({
  agentId: z.string(),
  sourceArtifacts: z.array(z.string()),
  modelName: z.string(),
  dimensions: z.number().int().positive(),
  embeddingData: z.union([z.string(), z.instanceof(Buffer), z.instanceof(Uint8Array)]),
  metadata: z.record(z.unknown()).optional(),
  siteId: z.string().optional(),
});

// =============================================================================
// LINUX FORK ROUTES
// =============================================================================

/**
 * POST /api/artifacts/linux/kernel-trace
 * Ingest a kernel trace artifact (ftrace, eBPF, etc.)
 */
router.post("/linux/kernel-trace", async (req: Request, res: Response) => {
  try {
    const input = createKernelTraceInputSchema.parse(req.body);
    const result = await crossForkPipeline.ingestKernelTrace(input);
    
    res.status(201).json({
      success: true,
      artifact: {
        hash: result.artifact.id,
        timestamp: result.artifact.timestamp,
        summary: result.artifact.summary,
      },
      traceId: (result.linuxMetadata as { trace: { traceId: string } }).trace.traceId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

/**
 * POST /api/artifacts/linux/sensor-burst
 * Ingest a sensor burst artifact
 */
router.post("/linux/sensor-burst", async (req: Request, res: Response) => {
  try {
    const input = createSensorBurstInputSchema.parse(req.body);
    const result = await crossForkPipeline.ingestSensorBurst(input);
    
    res.status(201).json({
      success: true,
      artifact: {
        hash: result.artifact.id,
        timestamp: result.artifact.timestamp,
        summary: result.artifact.summary,
      },
      burstId: (result.linuxMetadata as { burst: { burstId: string } }).burst.burstId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

/**
 * POST /api/artifacts/linux/firmware
 * Ingest a firmware image artifact
 */
router.post("/linux/firmware", async (req: Request, res: Response) => {
  try {
    const input = createFirmwareImageInputSchema.parse(req.body);
    const result = await crossForkPipeline.ingestFirmwareImage(input);
    
    res.status(201).json({
      success: true,
      artifact: {
        hash: result.artifact.id,
        timestamp: result.artifact.timestamp,
        summary: result.artifact.summary,
      },
      imageId: (result.linuxMetadata as { firmware: { imageId: string } }).firmware.imageId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

/**
 * POST /api/artifacts/linux/device-state
 * Ingest a device state snapshot artifact
 */
router.post("/linux/device-state", async (req: Request, res: Response) => {
  try {
    const input = createDeviceStateSnapshotInputSchema.parse(req.body);
    const result = await crossForkPipeline.ingestDeviceState(input);
    
    res.status(201).json({
      success: true,
      artifact: {
        hash: result.artifact.id,
        timestamp: result.artifact.timestamp,
        summary: result.artifact.summary,
      },
      snapshotId: (result.linuxMetadata as { snapshot: { snapshotId: string } }).snapshot.snapshotId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

// =============================================================================
// AGENTIC-QE FORK ROUTES
// =============================================================================

/**
 * POST /api/artifacts/agentic/decision
 * Ingest an agent decision artifact
 */
router.post("/agentic/decision", async (req: Request, res: Response) => {
  try {
    const input = ingestAgentDecisionSchema.parse(req.body);
    const result = await crossForkPipeline.ingestAgentDecision(input);
    
    res.status(201).json({
      success: true,
      artifact: {
        hash: result.id,
        timestamp: result.timestamp,
        summary: result.summary,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

/**
 * POST /api/artifacts/agentic/world-model
 * Ingest a world model artifact
 */
router.post("/agentic/world-model", async (req: Request, res: Response) => {
  try {
    const input = ingestWorldModelSchema.parse(req.body);
    const result = await crossForkPipeline.ingestWorldModel(input);
    
    res.status(201).json({
      success: true,
      artifact: {
        hash: result.id,
        timestamp: result.timestamp,
        summary: result.summary,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

/**
 * POST /api/artifacts/agentic/embedding
 * Ingest an embedding artifact
 */
router.post("/agentic/embedding", async (req: Request, res: Response) => {
  try {
    const input = ingestEmbeddingSchema.parse(req.body);
    const result = await crossForkPipeline.ingestEmbedding(input);
    
    res.status(201).json({
      success: true,
      artifact: {
        hash: result.id,
        timestamp: result.timestamp,
        summary: result.summary,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Validation failed",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

// =============================================================================
// CROSS-FORK QUERY ROUTES
// =============================================================================

/**
 * GET /api/artifacts/lineage/:hash
 * Get the full lineage of an artifact
 */
router.get("/lineage/:hash", async (req: Request, res: Response) => {
  try {
    const { hash } = req.params;
    const lineage = await crossForkPipeline.getArtifactLineage(hash as ContentHash);
    
    if (!lineage) {
      res.status(404).json({
        success: false,
        error: "Artifact not found",
      });
      return;
    }
    
    res.json({
      success: true,
      lineage: {
        root: lineage.root,
        artifacts: Array.from(lineage.artifacts.entries()).map(([h, info]) => ({
          hash: h,
          fork: info.fork,
          type: info.type,
        })),
        dependencies: lineage.dependencies,
        depth: lineage.depth,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/artifacts/dependents/:hash
 * Get all artifacts that depend on the given artifact
 */
router.get("/dependents/:hash", async (req: Request, res: Response) => {
  try {
    const { hash } = req.params;
    const dependents = crossForkPipeline.getDependents(hash as ContentHash);
    
    res.json({
      success: true,
      hash,
      dependents,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/artifacts/stats
 * Get pipeline statistics
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const stats = await crossForkPipeline.getStats();
    
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// =============================================================================
// ADMIN ROUTES
// =============================================================================

/**
 * POST /api/artifacts/dependencies
 * Create a cross-fork dependency
 */
router.post("/dependencies", async (req: Request, res: Response) => {
  try {
    const { fromHash, fromFork, toHash, toFork, relationship } = req.body;
    
    const dependency = crossForkPipeline.addDependency(
      fromHash,
      fromFork,
      toHash,
      toFork,
      relationship
    );
    
    res.status(201).json({
      success: true,
      dependency,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/artifacts/validate
 * Validate dependencies for a set of artifacts
 */
router.post("/validate", async (req: Request, res: Response) => {
  try {
    const { dependencies } = req.body;
    
    if (!Array.isArray(dependencies)) {
      res.status(400).json({
        success: false,
        error: "dependencies must be an array",
      });
      return;
    }
    
    const result = await crossForkPipeline.validateDependencies(dependencies);
    
    res.json({
      success: true,
      valid: result.valid,
      missing: result.missing,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
