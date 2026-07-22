/**
 * Agent Marketplace API
 * ADR-0013 [13.6] — Issue #217
 *
 * REST surface for the plugin registry and lifecycle. Mounted at
 * /api/marketplace — /api/agents (and its /agent-outputs, /agent-proposals
 * redirects) remain untouched.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { marketplaceService } from "../services/marketplace";
import type { PluginCategory, PluginManifest } from "@shared/types/marketplace";

const router = Router();
const marketplace = marketplaceService.marketplace;

// Auth middleware placeholder — same pattern as other protected routes
function requireAuth(req: Request, res: Response, next: NextFunction) {
  // TODO: implement real auth check (JWT / session validation)
  next();
}
router.use(requireAuth);

/** Engine lifecycle errors map to 400s with the engine's message */
function handle(fn: (req: Request, res: Response) => void | Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────

const CapabilitySchema = z.enum(["tags:read", "alarms:read", "events:emit", "log"]);

const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(256),
  version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  description: z.string().max(2000).default(""),
  author: z.string().max(256).default("unknown"),
  category: z.enum(["intelligence", "integration", "reporting", "safety", "optimization", "custom"]),
  requiredCapabilities: z.array(CapabilitySchema).max(10).default([]),
  configSchema: z
    .record(
      z.object({
        type: z.enum(["string", "number", "boolean", "select"]),
        description: z.string().max(500),
        default: z.union([z.string(), z.number(), z.boolean()]).optional(),
        required: z.boolean(),
        options: z.array(z.string()).max(50).optional(),
      })
    )
    .default({}),
  dependencies: z.record(z.string().max(64)).default({}),
  tags: z.array(z.string().max(64)).max(20).default([]),
});

const InstallSchema = z.object({
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  grants: z.array(CapabilitySchema).optional(),
});

const ConfigSchema = z.object({
  config: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

const InvokeSchema = z.object({
  input: z.unknown().optional(),
});

// ── Registry ───────────────────────────────────────────────────────────────

router.get("/plugins", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  const category =
    typeof req.query.category === "string" ? (req.query.category as PluginCategory) : undefined;
  res.json({ plugins: marketplace.search(query, category) });
});

router.post("/plugins", handle((req, res) => {
  const parsed = ManifestSchema.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  const entry = marketplace.publish(parsed.data as PluginManifest);
  res.status(201).json(entry);
}));

router.get("/plugins/:pluginId", (req, res) => {
  const entry = marketplace.getEntry(req.params.pluginId);
  if (!entry) return res.status(404).json({ error: `Plugin ${req.params.pluginId} not found` });
  res.json(entry);
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

router.get("/installed", (_req, res) => {
  res.json({ plugins: marketplace.listInstalled() });
});

router.post("/plugins/:pluginId/install", handle((req, res) => {
  const parsed = InstallSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return void res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.status(201).json(
    marketplace.install(req.params.pluginId, parsed.data.config, parsed.data.grants)
  );
}));

router.post("/plugins/:pluginId/update", handle((req, res) => {
  res.json(marketplace.update(req.params.pluginId));
}));

router.put("/plugins/:pluginId/config", handle((req, res) => {
  const parsed = ConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(marketplace.configure(req.params.pluginId, parsed.data.config));
}));

router.post("/plugins/:pluginId/start", handle((req, res) => {
  res.json(marketplace.start(req.params.pluginId));
}));

router.post("/plugins/:pluginId/stop", handle((req, res) => {
  res.json(marketplace.stop(req.params.pluginId));
}));

router.post("/plugins/:pluginId/enable", handle((req, res) => {
  res.json(marketplace.enable(req.params.pluginId));
}));

router.post("/plugins/:pluginId/disable", handle((req, res) => {
  res.json(marketplace.disable(req.params.pluginId));
}));

router.delete("/plugins/:pluginId", handle((req, res) => {
  marketplace.uninstall(req.params.pluginId);
  res.json({ uninstalled: true });
}));

// ── Execution & health ─────────────────────────────────────────────────────

router.post("/plugins/:pluginId/invoke", handle(async (req, res) => {
  const parsed = InvokeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return void res.status(400).json({ error: fromZodError(parsed.error).message });
  }
  res.json(await marketplace.invoke(req.params.pluginId, parsed.data.input));
}));

router.get("/plugins/:pluginId/health", (req, res) => {
  const health = marketplace.getHealth(req.params.pluginId);
  if (!health) return res.status(404).json({ error: `Plugin ${req.params.pluginId} not installed` });
  res.json(health);
});

router.get("/health", (_req, res) => {
  res.json({ plugins: marketplace.getAllHealth() });
});

router.get("/status", async (_req, res) => {
  const health = await marketplaceService.healthCheck();
  res.json({ ...marketplace.getStatus(), ...health });
});

export { router as marketplaceRoutes };
