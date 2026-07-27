/**
 * Legacy /api/intelligence surface.
 *
 * Issue #216 (ADR-0013 [13.5]) review: this router shipped as a demo scaffold
 * and every handler fabricated its payload — PRNG-generated risk and health
 * "scores" on a 0..100 scale, hardcoded maintenance recommendations, invented
 * 2024 failure dates, canned ML accuracy figures. It was mounted next to the real
 * APIs at `/api/predictive` (#212) and `/api/twin` (#214) with nothing in the
 * response to tell a caller which surface they had reached. On an
 * operator-facing SCADA system a synthetic "risk score" that reads like a
 * measurement is a safety hazard, and it violates the repository integrity
 * rule ("NO shortcuts, fake data, or false claims").
 *
 * No handler here produces data any more. Each returns an explicit,
 * machine-readable refusal:
 *
 *   410 Gone             `error: "endpoint_retired"` — the capability is
 *                        implemented, on another router. The body carries the
 *                        replacement endpoints and the scopes they require.
 *   501 Not Implemented  `error: "not_implemented"` — nothing on `main`
 *                        implements this capability at all.
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
import type { Response } from "express";

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
// Not implemented on main. The former handler echoed the request back as an
// "interpretation", returned `results: []`, and appended two fixed
// "suggestions" — it never reached a data source.

router.post("/nlquery", (_req, res) => {
  notImplemented(
    res,
    "Natural-language process query is not implemented. The previous handler "
      + "echoed the submitted query back as an interpretation with an empty "
      + "result set; it queried no tags, events, or historian data. Query the "
      + "typed APIs directly (for example GET /api/predictive/alerts or "
      + "GET /api/v2/events) until this is built.",
  );
});

router.get("/nlquery/history", (_req, res) => {
  notImplemented(
    res,
    "Natural-language query history is not implemented. No query history is "
      + "recorded anywhere in this service; the previous handler returned one "
      + "hardcoded example row stamped with the current time.",
  );
});

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
// Not implemented on main. `server/services/ml` exists but is a simulation
// harness — its inference path returns PRNG draws and "training" is a
// setTimeout — so wiring these routes to it would relabel the same fabricated
// numbers rather than remove them. It is deliberately left unexposed over HTTP.

router.post("/ml/pipeline", (_req, res) => {
  notImplemented(
    res,
    "ML pipeline execution is not implemented. The previous handler returned "
      + "pseudo-random values as predictions and fixed accuracy/loss/F1 figures "
      + "for train and evaluate. No model runtime is wired to this service; "
      + "server/services/ml is a simulation harness, not an inference backend.",
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
