/**
 * Guards the Node major that CI installs.
 *
 * Node 20 bundles npm 10.8.2. Dependabot regenerates package-lock.json with a
 * newer npm, and npm 10.8.2 rejects those lockfiles with EUSAGE
 * ("can only install packages when your package.json and package-lock.json are
 * in sync"), so every Dependabot npm PR failed at `npm ci` until someone
 * hand-rebased the lockfile with `npx npm@10.8.2 install --package-lock-only`.
 * Node 22 ships npm 10.9+, which reads them natively.
 *
 * This test fails if any workflow reintroduces a setup-node pin below Node 22,
 * which is the exact regression that brings the toil back.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import { describe, expect, test } from "vitest";

/** Lowest Node major whose bundled npm accepts current Dependabot lockfiles. */
const MINIMUM_NODE_MAJOR = 22;

type WorkflowStep = {
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type Workflow = {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
};

type NodePin = {
  workflow: string;
  job: string;
  /** The literal written in YAML, e.g. `22` or `${{ env.NODE_VERSION }}`. */
  raw: string;
  /** `raw` after substituting workflow/job-level `env`. */
  resolved: string;
};

const workflowsDir = resolve(process.cwd(), ".github/workflows");

const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

/**
 * Substitutes `${{ env.NAME }}` from the job-level then workflow-level `env`
 * maps. GitHub Actions supports several other expression contexts; anything we
 * cannot resolve is returned unchanged so the assertions below reject it rather
 * than silently passing an unknown pin.
 */
function resolveEnvExpression(
  value: string,
  scopes: ReadonlyArray<Record<string, unknown> | undefined>,
): string {
  return value.replace(
    /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (unresolved, name: string) => {
      for (const scope of scopes) {
        const candidate = scope?.[name];
        if (typeof candidate === "string" || typeof candidate === "number") {
          return String(candidate);
        }
      }
      return unresolved;
    },
  );
}

function collectNodePins(fileName: string): NodePin[] {
  const source = readFileSync(join(workflowsDir, fileName), "utf8");
  // JSON_SCHEMA keeps `node-version: 22` (unquoted) a string rather than
  // coercing it to a number, so quoted and unquoted pins compare identically.
  const workflow = load(source, { schema: JSON_SCHEMA }) as Workflow | undefined;
  const pins: NodePin[] = [];

  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith("actions/setup-node@")) {
        continue;
      }
      const pin = step.with?.["node-version"];
      // A setup-node step with no scalar `node-version` (omitted entirely, or
      // swapped for `node-version-file`) must NOT be skipped: skipping it would
      // let someone reintroduce Node 20 in a form this collector cannot see.
      // Record it with an unresolvable marker so the assertions flag it.
      const raw =
        typeof pin === "string" || typeof pin === "number"
          ? String(pin)
          : `<no scalar node-version: ${JSON.stringify(step.with ?? null)}>`;
      pins.push({
        workflow: fileName,
        job: jobName,
        raw,
        resolved: resolveEnvExpression(raw, [job.env, workflow?.env]),
      });
    }
  }

  return pins;
}

const nodePins = workflowFiles.flatMap(collectNodePins);

describe("CI workflow Node version pins", () => {
  test("every workflow file is parseable YAML", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const fileName of workflowFiles) {
      const source = readFileSync(join(workflowsDir, fileName), "utf8");
      expect(() => load(source, { schema: JSON_SCHEMA })).not.toThrow();
    }
  });

  test("at least one setup-node pin is discovered", () => {
    // Sanity check: if the collector silently stopped matching (renamed action,
    // restructured steps), the version assertion below would vacuously pass.
    expect(nodePins.length).toBeGreaterThan(0);
  });

  test("no setup-node pin resolves below Node 22", () => {
    const offenders = nodePins.filter((pin) => {
      const major = Number.parseInt(pin.resolved, 10);
      return !Number.isFinite(major) || major < MINIMUM_NODE_MAJOR;
    });

    expect(
      offenders.map(
        (pin) =>
          `${pin.workflow} job "${pin.job}": ${pin.raw} -> ${pin.resolved}`,
      ),
    ).toEqual([]);
  });

  test("ci.yml drives every setup-node step from the shared NODE_VERSION", () => {
    const source = readFileSync(join(workflowsDir, "ci.yml"), "utf8");
    const workflow = load(source, { schema: JSON_SCHEMA }) as Workflow;

    expect(String(workflow.env?.NODE_VERSION)).toBe("22");

    const ciPins = nodePins.filter((pin) => pin.workflow === "ci.yml");
    expect(ciPins.length).toBeGreaterThan(0);
    for (const pin of ciPins) {
      expect(pin.raw).toBe("${{ env.NODE_VERSION }}");
      expect(pin.resolved).toBe("22");
    }
  });
});
