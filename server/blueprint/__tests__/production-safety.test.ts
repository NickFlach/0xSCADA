import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = new URL("../../../migrations/", import.meta.url);
const SAFE_STATE_MIGRATION = "0009_blueprint_safe_state_log";
const SQL_SUFFIX = ".sql";
/** drizzle-kit tags: a 4-digit ordinal, an underscore, then a snake_case name. */
const TAG_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*$/;

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** Journal entries in declared file order (idx order is asserted separately). */
function readJournalEntries(): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", MIGRATIONS_DIR), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

/**
 * Tags implied by the on-disk migrations, in the order migrations/migrate.ts
 * applies them — it lists the directory and plain-`.sort()`s the `.sql` names,
 * which for zero-padded drizzle-kit tags is numeric order.
 */
function readMigrationTagsFromDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(SQL_SUFFIX))
    .map((file) => file.slice(0, -SQL_SUFFIX.length))
    .sort();
}

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

  it("is registered in the migration journal", () => {
    expect(readJournalEntries().map((entry) => entry.tag)).toContain(
      SAFE_STATE_MIGRATION,
    );
  });
});

/**
 * These guard the journal as a whole, not the safe-state migration specifically
 * (#616). They deliberately assert invariants rather than a literal list of
 * tags: the previous literal `toEqual` had to be hand-edited by every unrelated
 * migration (#613, #614, #615), and it could not detect a `.sql` file that no
 * journal entry referenced. Adding a migration correctly — file plus entry —
 * leaves these green; adding half of one does not.
 */
describe("migration journal integrity", () => {
  it("has exactly one journal entry per migrations/*.sql file, and no entry without a file", () => {
    const fileTags = readMigrationTagsFromDisk();
    const entryTags = readJournalEntries().map((entry) => entry.tag);

    expect(fileTags.length).toBeGreaterThan(0);

    const unjournalled = fileTags.filter((tag) => !entryTags.includes(tag));
    expect(
      unjournalled,
      "migrations/*.sql files with no meta/_journal.json entry — drizzle-kit will never apply them",
    ).toEqual([]);

    const orphaned = entryTags.filter((tag) => !fileTags.includes(tag));
    expect(
      orphaned,
      "journal entries with no matching migrations/<tag>.sql file",
    ).toEqual([]);

    const duplicated = entryTags.filter(
      (tag, index) => entryTags.indexOf(tag) !== index,
    );
    expect(duplicated, "tags listed more than once in the journal").toEqual([]);
  });

  it("numbers entries contiguously from 0, in declared order, with no gaps or duplicates", () => {
    const entries = readJournalEntries();

    // Declared order, not sorted order: drizzle-kit tooling consumes
    // `entries` as written, so a correct `idx` in the wrong array position
    // still applies the DDL out of order.
    expect(entries.map((entry) => entry.idx)).toEqual(
      entries.map((_, position) => position),
    );
  });

  it("orders entries by migration number, matching the order migrate.ts applies them", () => {
    const entries = [...readJournalEntries()].sort((a, b) => a.idx - b.idx);

    // idx order must equal the on-disk apply order, so a mis-numbered entry
    // cannot silently reorder DDL relative to the runner.
    expect(entries.map((entry) => entry.tag)).toEqual(readMigrationTagsFromDisk());

    const ordinals = entries.map((entry) => {
      const match = TAG_PATTERN.exec(entry.tag);
      if (match === null) {
        throw new Error(
          `journal tag "${entry.tag}" is not a drizzle-kit tag (NNNN_snake_case)`,
        );
      }
      return Number.parseInt(match[1], 10);
    });
    // Strictly increasing: no reused ordinal, and no renumbering that would
    // change the meaning of an already-applied migration.
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(
        ordinals[i],
        `migration ${entries[i].tag} does not come after ${entries[i - 1].tag}`,
      ).toBeGreaterThan(ordinals[i - 1]);
    }

    // `when` must stay monotonic so drizzle-kit orders the journal correctly.
    const timestamps = entries.map((entry) => entry.when);
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(
        timestamps[i],
        `${entries[i].tag} has a "when" at or before ${entries[i - 1].tag}`,
      ).toBeGreaterThan(timestamps[i - 1]);
    }
  });
});
