import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

describe("blueprint latency harness GC accounting", () => {
  test("flushes GC performance entries before disconnecting", () => {
    const harnessUrl = pathToFileURL(
      resolve(process.cwd(), "bench/blueprint-runtime/harness.ts"),
    ).href;
    const probe = `
      import { runLatencyBench } from ${JSON.stringify(harnessUrl)};
      const stats = await runLatencyBench({
        label: "forced-gc",
        warmup: 0,
        iterations: 4,
        tick: () => {
          const retainedForTick = new Array(10_000).fill({});
          globalThis.gc();
          if (retainedForTick.length !== 10_000) throw new Error("unreachable");
        },
      });
      process.stdout.write(JSON.stringify({
        gcCount: stats.gcCount,
        gcTotalMs: stats.gcTotalMs,
      }));
    `;

    const output = execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", probe],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    const observed = JSON.parse(output) as {
      gcCount?: number;
      gcTotalMs?: number;
    };

    expect(observed.gcCount).toBeGreaterThanOrEqual(4);
    expect(observed.gcTotalMs).toBeGreaterThan(0);
  });
});
