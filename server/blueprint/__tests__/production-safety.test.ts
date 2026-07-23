import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  BLUEPRINT_PRODUCTION_HOLD_CODE,
  createBlueprintProductionHoldMiddleware,
  getBlueprintProductionSafetyStatus,
} from "../production-safety";

describe("production blueprint safety hold", () => {
  it("reports every unbound safe-state capability explicitly", () => {
    expect(getBlueprintProductionSafetyStatus()).toMatchObject({
      state: "HELD",
      code: BLUEPRINT_PRODUCTION_HOLD_CODE,
      capabilities: {
        deployedBlueprintBound: false,
        watchdogRegistered: false,
        outputActuatorBound: false,
      },
    });
  });

  it("fails the production API closed with a machine-visible 503", () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const next = vi.fn();
    const middleware = createBlueprintProductionHoldMiddleware();

    middleware({} as never, { status } as never, next);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: BLUEPRINT_PRODUCTION_HOLD_CODE,
        safetyRuntime: expect.objectContaining({ state: "HELD" }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe("safe-state audit migration alignment", () => {
  it("creates every durable column and index declared by the Drizzle table", () => {
    const sql = readFileSync(
      new URL("../../../migrations/0005_blueprint_safe_state_log.sql", import.meta.url),
      "utf8",
    );

    for (const column of [
      "blueprint_id",
      "site_id",
      "transition",
      "safe_state",
      "tick_budget_ms",
      "consecutive_misses",
      "operator",
      "reason",
      "anchor_hash",
      "anchor_tx_hash",
      "metadata",
      "created_at",
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sql).toContain("idx_safe_state_log_blueprint_id");
    expect(sql).toContain("idx_safe_state_log_transition");
    expect(sql).toContain("idx_safe_state_log_created_at");
    expect(sql).toContain("UNIQUE INDEX IF NOT EXISTS idx_safe_state_log_anchor_hash");
  });

  it("registers only the scoped safe-state migration after the existing base", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../../../migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 0, tag: "0001_initial_schema" },
      { idx: 1, tag: "0002_seed_rbac_defaults" },
      { idx: 2, tag: "0005_blueprint_safe_state_log" },
    ]);
  });
});
