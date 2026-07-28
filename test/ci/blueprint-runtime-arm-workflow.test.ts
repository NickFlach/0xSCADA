/**
 * Regression guard for issue #457's required ARM performance proxy.
 *
 * The latency benchmark exits non-zero on p99 >= 1 ms, while the isolated
 * allocation probe gates tickFast() with non-vacuous GC-profiler controls.
 * These assertions make sure CI continues to run both gates and the
 * heap-retention invariant on native ARM64, inside the declared one-CPU / 6 GiB
 * constrained shape, and that branch protection cannot report success while
 * the benchmark job failed or was omitted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import { describe, expect, test } from "vitest";

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  needs?: string | string[];
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

const workflowPath = resolve(process.cwd(), ".github/workflows/ci.yml");
const workflow = load(readFileSync(workflowPath, "utf8"), {
  schema: JSON_SCHEMA,
}) as Workflow;

const benchmarkJob = workflow.jobs?.["blueprint-runtime-arm"];
const summaryJob = workflow.jobs?.["ci-complete"];

describe("Blueprint runtime ARM p99 workflow", () => {
  test("runs on native ARM64 with the repository Node major", () => {
    expect(benchmarkJob).toBeDefined();
    expect(benchmarkJob?.name).toBe(
      "Blueprint Runtime ARM p99 + allocation (constrained proxy)",
    );
    expect(benchmarkJob?.["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(benchmarkJob?.["timeout-minutes"]).toBe(15);
    expect(benchmarkJob?.permissions).toEqual({ contents: "read" });

    const setupNode = benchmarkJob?.steps?.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    expect(setupNode?.with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
  });

  test("asserts the one-CPU / 6 GiB shape before running both gates", () => {
    const gate = benchmarkJob?.steps?.find((step) =>
      step.name?.includes("gate the runtime"),
    );
    expect(gate?.run).toBeDefined();

    const command = gate?.run ?? "";
    expect(command).toContain("--cpuset-cpus 0");
    expect(command).toContain("--memory 6g");
    expect(command).toContain("--memory-swap 6g");
    expect(command).toContain("node:20-bookworm-slim");
    expect(command).toContain('test "$arch" = "arm64"');
    expect(command).toContain('test "$node_major" = "20"');
    expect(command).toContain('test "$cpus" = "1"');
    expect(command).toContain('test "$memory_limit" = "6442450944"');
    expect(command).toContain('test "$gc_type" = "function"');
    expect(command).toContain(
      "node_modules/vitest/vitest.mjs run",
    );
    expect(command).toContain(
      "server/blueprint/__tests__/runtime.test.ts",
    );
    const flattenedCommand = command
      .replace(/\\\s+/g, " ")
      .replace(/\s+/g, " ");
    expect(flattenedCommand).toContain(
      "node --expose-gc --max-semi-space-size=1 --import tsx " +
        "bench/blueprint-runtime/allocation.bench.ts",
    );
    expect(flattenedCommand).toContain(
      "node --expose-gc --import tsx " +
        "bench/blueprint-runtime/locked.bench.ts",
    );
    expect(command).toContain("2>&1 | tee blueprint-runtime-arm-gate.txt");
  });

  test("makes the benchmark a required input to CI Complete", () => {
    const needs = Array.isArray(summaryJob?.needs)
      ? summaryJob.needs
      : [summaryJob?.needs].filter((value): value is string => Boolean(value));
    expect(needs).toContain("blueprint-runtime-arm");

    const resultCheck = summaryJob?.steps
      ?.map((step) => step.run ?? "")
      .join("\n");
    expect(resultCheck).toContain("needs.blueprint-runtime-arm.result");
  });
});
