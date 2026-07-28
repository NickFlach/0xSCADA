/**
 * Legacy /api/intelligence surface.
 *
 * ADR-0013 [13.5] is docs/decisions/ADR-0013-autonomous-agent-architecture.md
 * (Accepted, 2026-02-15). The #216 review reported it missing because it
 * checked docs/adr/, which is not where this repository keeps it. The
 * route-level contract for the nlquery pair below — read scope, bounds, data
 * sources, and the decisions on the LLM seam and history durability — is
 * docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 *
 * Issue #216 review: this router shipped as a demo scaffold
 * and every handler fabricated its payload — PRNG-generated risk and health
 * "scores" on a 0..100 scale, hardcoded maintenance recommendations, invented
 * 2024 failure dates, canned ML accuracy figures. It was mounted next to the real
 * APIs at `/api/predictive` (#212) and `/api/twin` (#214) with nothing in the
 * response to tell a caller which surface they had reached. On an
 * operator-facing SCADA system a synthetic "risk score" that reads like a
 * measurement is a safety hazard, and it violates the repository integrity
 * rule ("NO shortcuts, fake data, or false claims").
 *
 * Every handler here except the two natural-language query routes returns an
 * explicit, machine-readable refusal:
 *
 *   410 Gone             `error: "endpoint_retired"` — the capability is
 *                        implemented, on another router. The body carries the
 *                        replacement endpoints and the scopes they require.
 *   501 Not Implemented  `error: "not_implemented"` — nothing on `main`
 *                        implements this capability at all.
 *
 * `POST /nlquery` and `GET /nlquery/history` are the exception: #216 built the
 * capability, so they now serve real answers read from the historian, the live
 * tag stream, and the alarm-correlation engine. Unlike the mock they replace,
 * they carry a route-local `requireControlPlaneAccess({ scopes: ["nlquery.read"] })`
 * guard — which is precisely the property whose absence is the reason the rest
 * of this router refuses to proxy rather than delegating. Their execution is
 * bounded (input length, wall-clock timeout, result and scan caps), and when
 * they cannot reach data they say so instead of producing a number.
 *
 * Why refuse rather than proxy to the real engines: every handler on
 * `/api/predictive` and `/api/twin` carries a per-route
 * `requireControlPlaneAccess` check for a specific scope (`predictive.read`,
 * `twin.read`, ...), while this router carries none. The API gateway does sit
 * in front of both — `apiKeyMiddleware` covers all of `/api/` when
 * `ENABLE_API_KEYS` is on (fail-closed in production), and mutations also pass
 * `mutationAuthorizationMiddleware` — but the gateway only proves a caller
 * holds *some* valid key. Delegating from here would therefore hand predictive
 * assessments and twin state to any key holder, bypassing the fine-grained
 * scopes the real routers require; with API-key auth disabled (the default
 * outside production) it would be an outright unauthenticated read path, since
 * `requireControlPlaneAccess` is what rejects an unkeyed request today. Adding
 * a duplicate guarded copy would just rebuild the two-competing-surfaces
 * problem that this change exists to remove.
 *
 * Why keep the routes rather than delete them: `client/src/pages/intelligence`
 * and the `digital-twin-control` entry in `server/middleware/control-route-policy`
 * still reference these paths. A 410/501 with a pointer is diagnosable; a bare
 * 404 from an unmounted router is not.
 */

import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { fromZodError } from "zod-validation-error/v3";
import { requireControlPlaneAccess } from "../middleware/control-plane-auth";
import {
  exampleQueries,
  nlQueryService,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_PAGE,
  MAX_QUERY_LENGTH,
  MAX_RESOLVER_CANDIDATE_TAGS,
  MAX_RESULT_ITEMS,
  QUERY_TIMEOUT_MS,
} from "../services/nlquery";

const router = Router();

/** Where the decision is recorded, echoed to operators reading logs. */
const ISSUE_REFERENCE = "https://github.com/NickFlach/0xSCADA/issues/216";

/** The implemented surface that supersedes a retired path. */
interface Replacement {
  /** Concrete endpoints a caller should migrate to. */
  endpoints: readonly string[];
  /** Control-plane scopes those endpoints require. */
  scopes: readonly string[];
}

/** Single response envelope for every refusal this router emits. */
interface RefusalBody {
  error: "endpoint_retired" | "not_implemented";
  detail: string;
  reference: string;
  replacement?: Replacement;
}

/**
 * The capability exists — on a different, authenticated router.
 * 410 rather than 501: the server implements the function, this URL is gone.
 */
function retired(res: Response, detail: string, replacement: Replacement): void {
  const body: RefusalBody = {
    error: "endpoint_retired",
    detail,
    reference: ISSUE_REFERENCE,
    replacement,
  };
  res.status(410).json(body);
}

/** Nothing on `main` implements this capability, here or anywhere else. */
function notImplemented(res: Response, detail: string): void {
  const body: RefusalBody = {
    error: "not_implemented",
    detail,
    reference: ISSUE_REFERENCE,
  };
  res.status(501).json(body);
}

const PREDICTIVE_REPLACEMENT: Replacement = {
  endpoints: [
    "POST /api/predictive/ingest",
    "GET /api/predictive/analyze/:tagId",
    "GET /api/predictive/prediction/:tagId",
    "GET /api/predictive/alerts",
  ],
  scopes: ["predictive.ingest", "predictive.read", "predictive.recommend"],
};

const TWIN_REPLACEMENT: Replacement = {
  endpoints: [
    "POST /api/twin/models",
    "POST /api/twin/models/:modelId/step",
    "GET /api/twin/models/:modelId/state",
    "POST /api/twin/scenarios",
  ],
  scopes: ["twin.read", "twin.configure", "twin.operate", "twin.simulate"],
};

// ── Natural-language query (ADR-0013 [13.5], #216) ─────────────────────────
//
// These two routes are the one implemented surface on this router. They
// replace the 501 stubs that stood here while the capability did not exist:
// the engine now reads the historian (`historian_data`), the live tag stream,
// and the alarm-correlation engine, and refuses to answer when it cannot.
//
// AUTHORIZATION (#576 pattern). Both routes require `nlquery.read`, a READ
// scope. `POST /nlquery` is a POST for transport reasons only — the question
// is free text that would otherwise sit in a URL, and therefore in access
// logs, proxy logs, and browser history — and it mutates nothing. It must
// therefore never require or imply write privilege: a key holding only
// `nlquery.read` can ask questions, and a key holding `write` (but not
// `nlquery.read`) cannot. That second half matters, because the gateway's
// default mutation policy would otherwise treat this POST as a generic write;
// `server/middleware/control-route-policy.ts` carries an explicit
// `nl-query-read` entry so the gateway floor for this prefix is the read
// scope rather than `write`.
//
// Rationale and the full bounds table: docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.

const requireNlQueryRead = requireControlPlaneAccess({ scopes: ["nlquery.read"] });

/** Express 4 does not catch async rejections — wrap every async handler. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal error" });
      }
      console.error("[nlquery] handler error:", error);
    });
  };
}

/**
 * Over-long input is REJECTED, not truncated. Answering a question the
 * operator did not finish asking is the failure mode this surface must not
 * have, so a 400 that names the limit is the only safe response.
 */
const NlQuerySchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
});

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_PAGE).default(MAX_HISTORY_PAGE),
});

/** The bounds every response advertises, so a caller can see what shaped it. */
const NLQUERY_LIMITS = Object.freeze({
  maxQueryLength: MAX_QUERY_LENGTH,
  queryTimeoutMs: QUERY_TIMEOUT_MS,
  maxResolverCandidateTags: MAX_RESOLVER_CANDIDATE_TAGS,
  maxResultItems: MAX_RESULT_ITEMS,
  maxHistoryEntries: MAX_HISTORY_ENTRIES,
});

/**
 * Stated on every history response and on each query result. History is a
 * bounded in-process ring buffer: it is lost on restart and is not shared
 * between replicas. Saying so is part of the contract — an operator must not
 * mistake this for a durable audit trail (control-plane audit lives in
 * `audit_logs`, and this surface performs no mutation to audit).
 */
const HISTORY_PERSISTENCE = "process-local" as const;
const HISTORY_PERSISTENCE_NOTE =
  "Query history is held in a bounded in-memory ring buffer in this process. "
  + "It is lost on restart and is not shared across replicas or persisted to "
  + "the database.";

router.post(
  "/nlquery",
  requireNlQueryRead,
  asyncHandler(async (req, res) => {
    const parsed = NlQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        detail: fromZodError(parsed.error).message,
        limits: NLQUERY_LIMITS,
        examples: exampleQueries(),
      });
      return;
    }

    const result = await nlQueryService.engine.execute(parsed.data.query);
    res.json({
      ...result,
      limits: NLQUERY_LIMITS,
      historyPersistence: HISTORY_PERSISTENCE,
    });
  }),
);

router.get(
  "/nlquery/history",
  requireNlQueryRead,
  asyncHandler(async (req, res) => {
    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        detail: fromZodError(parsed.error).message,
        limits: NLQUERY_LIMITS,
      });
      return;
    }

    const history = nlQueryService.engine.getHistory(parsed.data.limit);
    res.json({
      history,
      count: history.length,
      persistence: HISTORY_PERSISTENCE,
      persistenceNote: HISTORY_PERSISTENCE_NOTE,
      limits: NLQUERY_LIMITS,
    });
  }),
);

// ── Predictive maintenance — superseded by /api/predictive (#212) ──────────
// The former handlers returned a PRNG draw scaled to 0..100 as `riskScore` and
// `healthScore`, plus fixed recommendations and a fixed `nextFailure` date.

router.post("/maintenance/analyze", (_req, res) => {
  retired(
    res,
    "Mock endpoint removed. It returned a pseudo-random 0..100 draw as a risk "
      + "score with hardcoded recommendations and a fixed failure date, none of "
      + "which were derived from asset data. Real analysis runs on the predictive "
      + "maintenance engine, which is tag-scoped rather than asset-scoped: "
      + "ingest the asset's tag series, then request its assessment or failure "
      + "prediction.",
    PREDICTIVE_REPLACEMENT,
  );
});

router.get("/maintenance/insights/:assetId", (_req, res) => {
  retired(
    res,
    "Mock endpoint removed. It returned a pseudo-random 0..100 draw as a health "
      + "score with fixed performance trends and a fixed vibration alert. Real "
      + "detector output and alerts come from the predictive maintenance "
      + "engine, keyed by tag id.",
    PREDICTIVE_REPLACEMENT,
  );
});

// ── Digital twin — superseded by /api/twin (#214) ──────────────────────────
// The former handlers reported `status: "completed"` for every operation and
// returned fixed strings ("Expected performance: 95%", "12% efficiency
// improvement", accuracy 94.5) without running a simulation.

router.post("/digitaltwin/operate", (_req, res) => {
  retired(
    res,
    "Mock endpoint removed. It reported every operation as completed and "
      + "returned fixed simulation, prediction, and optimization strings "
      + "without stepping a model. Real simulation, what-if scenarios, and "
      + "rollback analysis run on the digital twin runtime.",
    TWIN_REPLACEMENT,
  );
});

router.get("/digitaltwin/status/:assetId", (_req, res) => {
  retired(
    res,
    "Mock endpoint removed. It reported a fixed 'synchronized' status, a fixed "
      + "94.5 accuracy figure, and a fixed session count for any asset id, "
      + "including ids with no twin. Real model state and runtime status come "
      + "from the digital twin runtime.",
    TWIN_REPLACEMENT,
  );
});

// ── ML pipeline ────────────────────────────────────────────────────────────
// Not implemented on main. The `server/services/ml` simulation harness that
// used to sit behind these paths was deleted in #605 — its inference path
// returned PRNG draws and its "training" was a setTimeout, so wiring these
// routes to it would have relabelled fabricated numbers rather than removed
// them. There is now no ML service in the process at all.

router.post("/ml/pipeline", (_req, res) => {
  notImplemented(
    res,
    "ML pipeline execution is not implemented. The previous handler returned "
      + "pseudo-random values as predictions and fixed accuracy/loss/F1 figures "
      + "for train and evaluate. No model runtime exists in this process: the "
      + "simulation harness that stood in for one was removed in #605.",
  );
});

router.get("/ml/models", (_req, res) => {
  notImplemented(
    res,
    "There is no model registry. The previous handler returned two invented "
      + "models with fixed accuracy figures and 2024 training dates.",
  );
});

router.get("/ml/pipeline/status/:jobId", (_req, res) => {
  notImplemented(
    res,
    "There is no pipeline job store. The previous handler reported any job id "
      + "as completed at 100% with fixed 2024 start and end timestamps, "
      + "including ids that were never submitted.",
  );
});

export { router as intelligenceRoutes };
