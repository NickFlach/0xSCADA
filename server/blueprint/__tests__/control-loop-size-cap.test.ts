/**
 * The definition byte cap must bind on what was READ, not on what stat said
 * (CodeQL js/file-system-race #142).
 *
 * `load()` used to `statSync(path)` for the size, check it, then
 * `readFileSync(path)`. That checks one file and reads whatever is at that name
 * a moment later. The cap exists to bound how much this control-plane process
 * pulls into memory, and a file that grows between the two calls — or a path
 * swapped for a larger one — walks straight through it.
 *
 * Proving that needs `fstat` to under-report while the bytes on disk are over
 * the cap, which is the same observation a grow-after-stat produces without
 * having to win a race in a test. `node:fs` is an ESM namespace and cannot be
 * spied on in place, so this lives in its own file where `vi.mock` can replace
 * the module without touching the 32 real-fs cases in `control-loop.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set to a number to make every `fstatSync` report that size instead. */
let forcedSize: number | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    fstatSync: (fd: number, ...rest: unknown[]) => {
      const stats = (actual.fstatSync as (...args: unknown[]) => import("node:fs").Stats)(
        fd,
        ...rest,
      );
      if (forcedSize !== null) {
        Object.defineProperty(stats, "size", { value: forcedSize, configurable: true });
      }
      return stats;
    },
  };
});

const { BlueprintControlLoop, BlueprintControlLoopError, loadBlueprintControlLoopConfig } =
  await import("../control-loop");

const tempDirs: string[] = [];

function writeOversizedDefinition(): string {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-size-cap-"));
  tempDirs.push(dir);
  const path = join(dir, "blueprint.json");
  // Structurally irrelevant — it must never get as far as being parsed.
  writeFileSync(path, JSON.stringify({ pad: "x".repeat(4_000) }), "utf8");
  return path;
}

beforeEach(() => {
  forcedSize = null;
});

afterEach(() => {
  forcedSize = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("blueprint definition byte cap", () => {
  function loadWithCap(path: string, maxBytes: string): void {
    new BlueprintControlLoop(
      loadBlueprintControlLoopConfig({
        BLUEPRINT_CONTROL_LOOP_ENABLED: "true",
        BLUEPRINT_CONTROL_LOOP_DEFINITION: path,
        BLUEPRINT_CONTROL_LOOP_MAX_BYTES: maxBytes,
      }),
    ).start();
  }

  it("rejects an oversized file when stat tells the truth", () => {
    const path = writeOversizedDefinition();
    expect(() => loadWithCap(path, "1024")).toThrow(BlueprintControlLoopError);
    expect(() => loadWithCap(path, "1024")).toThrow(/1024 bytes/);
  });

  it("still rejects it when stat under-reports the size", () => {
    // The stat-then-read version accepted this: the check saw 10 bytes and the
    // read then pulled in 4kB. Failing here is the whole point of the change.
    const path = writeOversizedDefinition();
    forcedSize = 10;
    expect(() => loadWithCap(path, "1024")).toThrow(BlueprintControlLoopError);
    expect(() => loadWithCap(path, "1024")).toThrow(
      /exceeds the configured maximum of 1024 bytes/,
    );
  });

  it("accepts a file within the cap when stat under-reports", () => {
    // The bound is on bytes actually read, so an honest small file is fine
    // regardless of what stat claimed — this is not just "always reject".
    const dir = mkdtempSync(join(tmpdir(), "blueprint-size-cap-"));
    tempDirs.push(dir);
    const path = join(dir, "blueprint.json");
    writeFileSync(path, "{ not valid json but small }", "utf8");
    forcedSize = 0;

    // It gets past the size gate and fails at parsing instead.
    expect(() => loadWithCap(path, "1024")).toThrow(/not valid JSON/);
  });
});
