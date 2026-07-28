/**
 * Agent Marketplace API.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 * Mounted at /api/marketplace; /api/agents and its redirects are untouched.
 *
 * ── Authorization ────────────────────────────────────────────────────────
 * Every route carries an explicit `requireControlPlaneAccess` scope (#576
 * pattern). There is no router-wide permissive guard and no route that falls
 * through to authenticated-is-enough:
 *
 *   GET    /plugins                       marketplace.read
 *   GET    /plugins/:id                   marketplace.read
 *   GET    /installed                     marketplace.read
 *   GET    /plugins/:id/health            marketplace.read
 *   GET    /health                        marketplace.read
 *   GET    /status                        marketplace.read
 *   POST   /plugins                       marketplace.publish
 *   POST   /plugins/:id/install           marketplace.install
 *   POST   /plugins/:id/update            marketplace.install
 *   PUT    /plugins/:id/config            marketplace.install
 *   POST   /plugins/:id/start|stop        marketplace.install
 *   POST   /plugins/:id/enable|disable    marketplace.install
 *   POST   /plugins/:id/invoke            marketplace.invoke
 *   DELETE /plugins/:id                   marketplace.uninstall
 *
 * Lifecycle transitions sit under `marketplace.install` because they change
 * the state of an installed plugin; they are deliberately NOT reachable with
 * `marketplace.invoke`, which only lets a caller run something an operator
 * already installed and started.
 *
 * ── Identity ─────────────────────────────────────────────────────────────
 * The publisher and installer identities come from the authenticated
 * control-plane principal, never from the request body. `ManifestSchema` is
 * strict, so a body that tries to carry a `publisher` field is rejected with
 * 400 instead of being quietly ignored.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error/v3";
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from "../middleware/control-plane-auth";
import { marketplaceService } from "../services/marketplace";
import { isMarketplaceError } from "../services/marketplace/errors";
import type { PluginCategory, PluginManifest } from "@shared/types/marketplace";

const router = Router();
const marketplace = marketplaceService.marketplace;

const requireMarketplaceRead = requireControlPlaneAccess({
  scopes: ["marketplace.read"],
});
const requireMarketplacePublish = requireControlPlaneAccess({
  scopes: ["marketplace.publish"],
});
const requireMarketplaceInstall = requireControlPlaneAccess({
  scopes: ["marketplace.install"],
});
const requireMarketplaceInvoke = requireControlPlaneAccess({
  scopes: ["marketplace.invoke"],
});
const requireMarketplaceUninstall = requireControlPlaneAccess({
  scopes: ["marketplace.uninstall"],
});

/**
 * Map an engine failure onto its declared status and machine code. The engine
 * owns the classification, so the HTTP layer never guesses one by matching an
 * error message.
 */
function handle(fn: (req: Request, res: Response) => Promise<void> | void) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (isMarketplaceError(error)) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid request",
        code: "invalid-request",
      });
    }
  };
}

// ── Schemas ────────────────────────────────────────────────────────────────

const CapabilitySchema = z.enum(["tags:read", "alarms:read", "events:emit", "log"]);

const ConfigValueSchema = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);

const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(256),
  version: z.string().regex(/^v?\d+\.\d+\.\d+$/),
  description: z.string().max(2000).default(""),
  author: z.string().max(256).default("unknown"),
  category: z.enum([
    "intelligence",
    "integration",
    "reporting",
    "safety",
    "optimization",
    "custom",
  ]),
  requiredCapabilities: z.array(CapabilitySchema).max(10).default([]),
  configSchema: z
    .record(
      z.object({
        type: z.enum(["string", "number", "boolean", "select"]),
        description: z.string().max(500),
        default: ConfigValueSchema.optional(),
        required: z.boolean(),
        options: z.array(z.string().max(256)).max(50).optional(),
      }).strict(),
    )
    .default({}),
  dependencies: z.record(z.string().max(64)).default({}),
  tags: z.array(z.string().max(64)).max(20).default([]),
}).strict();

const InstallSchema = z.object({
  config: z.record(ConfigValueSchema).default({}),
  grants: z.array(CapabilitySchema).max(10).optional(),
}).strict();

const ConfigureSchema = z.object({
  config: z.record(ConfigValueSchema),
}).strict();

const InvokeSchema = z.object({
  input: z.unknown().optional(),
}).strict();

const SearchSchema = z.object({
  q: z.string().max(256).optional(),
  category: z
    .enum(["intelligence", "integration", "reporting", "safety", "optimization", "custom"])
    .optional(),
}).strict();

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: fromZodError(error).message, code: "invalid-request" });
}

// ── Registry (read) ────────────────────────────────────────────────────────

router.get("/plugins", requireMarketplaceRead, handle((req, res) => {
  const parsed = SearchSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  const category = parsed.data.category as PluginCategory | undefined;
  res.json({ plugins: marketplace.search(parsed.data.q ?? "", category) });
}));

router.get("/plugins/:pluginId", requireMarketplaceRead, handle((req, res) => {
  const entry = marketplace.getEntry(req.params.pluginId);
  if (!entry) {
    res.status(404).json({
      error: `Plugin ${req.params.pluginId} not found`,
      code: "not-found",
    });
    return;
  }
  res.json(entry);
}));

// ── Registry (publish) ─────────────────────────────────────────────────────

router.post("/plugins", requireMarketplacePublish, handle(async (req, res) => {
  const parsed = ManifestSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);

  // Ownership is bound to the authenticated principal. A body-supplied
  // publisher is impossible here: ManifestSchema is strict and rejects it.
  const publisher = controlPlanePrincipal(req).name;
  const entry = await marketplace.publish(parsed.data as PluginManifest, publisher);
  res.status(201).json(entry);
}));

// ── Installation lifecycle ────────────────────────────────────────────────

router.get("/installed", requireMarketplaceRead, handle((_req, res) => {
  res.json({ plugins: marketplace.listInstalled() });
}));

router.post("/plugins/:pluginId/install", requireMarketplaceInstall, handle(async (req, res) => {
  const parsed = InstallSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error);
  const installed = await marketplace.install(req.params.pluginId, {
    config: parsed.data.config,
    grants: parsed.data.grants,
    installedBy: controlPlanePrincipal(req).name,
  });
  res.status(201).json(installed);
}));

router.post("/plugins/:pluginId/update", requireMarketplaceInstall, handle(async (req, res) => {
  res.json(await marketplace.update(req.params.pluginId));
}));

router.put("/plugins/:pluginId/config", requireMarketplaceInstall, handle(async (req, res) => {
  const parsed = ConfigureSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  res.json(await marketplace.configure(req.params.pluginId, parsed.data.config));
}));

router.post("/plugins/:pluginId/start", requireMarketplaceInstall, handle(async (req, res) => {
  res.json(await marketplace.start(req.params.pluginId));
}));

router.post("/plugins/:pluginId/stop", requireMarketplaceInstall, handle(async (req, res) => {
  res.json(await marketplace.stop(req.params.pluginId));
}));

router.post("/plugins/:pluginId/enable", requireMarketplaceInstall, handle(async (req, res) => {
  res.json(await marketplace.enable(req.params.pluginId));
}));

router.post("/plugins/:pluginId/disable", requireMarketplaceInstall, handle(async (req, res) => {
  res.json(await marketplace.disable(req.params.pluginId));
}));

router.delete("/plugins/:pluginId", requireMarketplaceUninstall, handle(async (req, res) => {
  await marketplace.uninstall(req.params.pluginId);
  res.json({ uninstalled: true, pluginId: req.params.pluginId });
}));

// ── Execution ─────────────────────────────────────────────────────────────

router.post("/plugins/:pluginId/invoke", requireMarketplaceInvoke, handle(async (req, res) => {
  const parsed = InvokeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error);
  const result = await marketplace.invoke(req.params.pluginId, parsed.data.input);
  // The result carries a machine-readable `code`; a plugin-level failure is
  // reported as 200 with success:false so callers can distinguish it from a
  // transport or authorization failure.
  res.json(result);
}));

// ── Health ────────────────────────────────────────────────────────────────

router.get("/plugins/:pluginId/health", requireMarketplaceRead, handle((req, res) => {
  const health = marketplace.getHealth(req.params.pluginId);
  if (!health) {
    res.status(404).json({
      error: `Plugin ${req.params.pluginId} not installed`,
      code: "not-installed",
    });
    return;
  }
  res.json(health);
}));

router.get("/health", requireMarketplaceRead, handle((_req, res) => {
  res.json({ plugins: marketplace.getAllHealth() });
}));

router.get("/status", requireMarketplaceRead, handle(async (_req, res) => {
  const health = await marketplaceService.healthCheck();
  res.json({ ...marketplace.getStatus(), ...health });
}));

export { router as marketplaceRoutes };
