import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("safe-state audit migration alignment", () => {
  it("creates every durable column and index declared by the Drizzle table", () => {
    const sql = readFileSync(
      new URL("../../../migrations/0009_blueprint_safe_state_log.sql", import.meta.url),
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

  it("declares the same table for the SQLite development fallback", () => {
    const storageSource = readFileSync(
      new URL("../../storage.ts", import.meta.url),
      "utf8",
    );

    expect(storageSource).toContain(
      "CREATE TABLE IF NOT EXISTS blueprint_safe_state_log",
    );
    expect(storageSource).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_safe_state_log_anchor_hash",
    );
  });

  it("appends the safe-state migration to the existing journal without renumbering", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../../../migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };

    expect(journal.entries.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 0, tag: "0001_initial_schema" },
      { idx: 1, tag: "0002_seed_rbac_defaults" },
      { idx: 2, tag: "0003_blueprint_persistence" },
      { idx: 3, tag: "0006_blueprint_instance_identity" },
      { idx: 4, tag: "0007_validator_registry" },
      { idx: 5, tag: "0008_modbus_register_map" },
      { idx: 6, tag: "0009_blueprint_safe_state_log" },
      { idx: 7, tag: "0010_pid_tuning_audit" },
      { idx: 8, tag: "0011_agent_marketplace" },
      { idx: 9, tag: "0012_validator_liveness_observations" },
    ]);
    // `when` must stay monotonic so drizzle-kit orders the journal correctly.
    const timestamps = journal.entries.map((e) => e.when);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });
});
