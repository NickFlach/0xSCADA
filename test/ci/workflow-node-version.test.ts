/**
 * Guards every Node major that CI installs — in workflows AND in images.
 *
 * Node 20 bundles npm 10.8.2. Dependabot regenerates package-lock.json with a
 * newer npm, and npm 10.8.2 rejects those lockfiles with EUSAGE
 * ("can only install packages when your package.json and package-lock.json are
 * in sync"), so every Dependabot npm PR failed at `npm ci` until someone
 * hand-rebased the lockfile with `npx npm@10.8.2 install --package-lock-only`.
 * Node 22 ships npm 10.9+, which reads them natively.
 *
 * There are two pin surfaces that both run `npm ci`, and #598 only closed one:
 *
 *   1. `actions/setup-node` steps in `.github/workflows/*` — closed by #598.
 *   2. `FROM node:<major>` in the Dockerfiles that ci.yml's `docker` job
 *      builds — still on Node 20 afterwards, so a Dependabot PR passed the
 *      setup-node jobs and failed at `Docker Build` with the same EUSAGE
 *      error (#604).
 *
 * Both surfaces are asserted here so neither can regress on its own. The
 * `docker run ... node:20-bookworm-slim` inside ci.yml's blueprint-runtime-arm
 * job is deliberately excluded: it is a constrained-runtime proxy that runs
 * the workspace's already-installed node_modules read-only and never invokes
 * `npm ci`, and its Node 20 pin is asserted on purpose by
 * test/ci/blueprint-runtime-arm-workflow.test.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
  strategy?: { matrix?: Record<string, unknown> };
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

// ---------------------------------------------------------------------------
// Surface 2: container image bases (#604)
// ---------------------------------------------------------------------------

const repoRoot = resolve(process.cwd());

/** Directories that hold no first-party build inputs (or are install output). */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "cache_forge",
  "artifacts",
]);

/** Repo-relative, forward-slashed path, so failure messages are portable. */
function repoRelative(absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

function walkRepository(predicate: (fileName: string) => boolean): string[] {
  const found: string[] = [];
  const stack: string[] = [repoRoot];

  for (
    let directory = stack.pop();
    directory !== undefined;
    directory = stack.pop()
  ) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          stack.push(absolutePath);
        }
        continue;
      }
      if (entry.isFile() && predicate(entry.name)) {
        found.push(repoRelative(absolutePath));
      }
    }
  }

  return found.sort();
}

function isDockerfileName(fileName: string): boolean {
  return (
    fileName === "Dockerfile" ||
    fileName.startsWith("Dockerfile.") ||
    fileName.endsWith(".Dockerfile")
  );
}

/**
 * `docker-compose.yml`, `compose.yaml`, `docker-compose.<profile>.yml`.
 * `*.generated.*` is skipped: `oxscada deploy compose generate` writes
 * `docker-compose.generated.yml` into the repo root as an untracked build
 * artifact, and a stale copy on a developer's disk is not a repo regression.
 * The generator's own output is asserted in cli/__tests__/commands/deploy.test.ts.
 */
function isComposeFileName(fileName: string): boolean {
  return (
    /^(docker-)?compose(\.[\w-]+)*\.(yml|yaml)$/i.test(fileName) &&
    !/\.generated\./i.test(fileName)
  );
}

/** A reference to the official `node` image, classified by resolvability. */
type NodeBase =
  | { kind: "not-node" }
  | { kind: "resolved"; major: number }
  | { kind: "unresolved"; reason: string };

const NODE_REPOSITORIES = new Set([
  "node",
  "library/node",
  "docker.io/node",
  "docker.io/library/node",
]);

/**
 * Splits an image reference into repository + tag and, when the repository is
 * the official `node` image, extracts the Node major from the tag.
 *
 * Anything that names `node` but whose major cannot be read (`node`,
 * `node:alpine`, `node:lts-alpine`, or a build-arg base like
 * `node:${NODE_TAG}`) is reported as `unresolved` rather than skipped — the
 * assertions below then reject it, so the guard cannot be evaded by making the
 * pin dynamic.
 */
function classifyBaseImage(image: string): NodeBase {
  const withoutDigest = image.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const repository = (
    hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest
  ).toLowerCase();
  const tag = hasTag ? withoutDigest.slice(lastColon + 1) : "";

  if (image.includes("$")) {
    // `FROM ${BASE}` / `image: node:${TAG}` — the effective major lives in an
    // ARG default or a .env file this test does not evaluate.
    return repository.includes("node") || tag.includes("node")
      ? { kind: "unresolved", reason: `interpolated image reference "${image}"` }
      : { kind: "not-node" };
  }

  if (!NODE_REPOSITORIES.has(repository)) {
    return { kind: "not-node" };
  }
  if (!hasTag) {
    return { kind: "unresolved", reason: `"${image}" pins no tag` };
  }

  const major = /^(\d+)(?:[.-]|$)/.exec(tag);
  return major
    ? { kind: "resolved", major: Number.parseInt(major[1], 10) }
    : { kind: "unresolved", reason: `tag "${tag}" has no numeric Node major` };
}

type ImagePin = {
  /** Repo-relative file the reference was read from. */
  file: string;
  /** Human-readable location, e.g. `line 2` or `service "hardhat"`. */
  location: string;
  image: string;
  base: NodeBase;
};

/** `FROM [--platform=...] <image> [AS <stage>]`, comments excluded. */
const FROM_PATTERN = /^\s*FROM\s+((?:--\S+\s+)*)(\S+)/i;

function collectDockerfilePins(file: string): ImagePin[] {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  const pins: ImagePin[] = [];

  source.split(/\r?\n/).forEach((text, index) => {
    const match = FROM_PATTERN.exec(text);
    if (!match) {
      return;
    }
    const image = match[2];
    pins.push({
      file,
      location: `line ${index + 1}`,
      image,
      base: classifyBaseImage(image),
    });
  });

  return pins;
}

type ComposeFile = {
  services?: Record<string, { image?: unknown } | null>;
};

function collectComposePins(file: string): ImagePin[] {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  const compose = load(source, { schema: JSON_SCHEMA }) as
    | ComposeFile
    | undefined;
  const pins: ImagePin[] = [];

  for (const [serviceName, service] of Object.entries(
    compose?.services ?? {},
  )) {
    const image = service?.image;
    if (typeof image !== "string") {
      continue;
    }
    pins.push({
      file,
      location: `service "${serviceName}"`,
      image,
      base: classifyBaseImage(image),
    });
  }

  return pins;
}

// One walk, partitioned — the repo tree is scanned once at module load.
const imageFiles = walkRepository(
  (fileName) => isDockerfileName(fileName) || isComposeFileName(fileName),
);
const dockerfiles = imageFiles.filter((file) =>
  isDockerfileName(file.slice(file.lastIndexOf("/") + 1)),
);
const composeFiles = imageFiles.filter((file) =>
  isComposeFileName(file.slice(file.lastIndexOf("/") + 1)),
);
const imagePins = [
  ...dockerfiles.flatMap(collectDockerfilePins),
  ...composeFiles.flatMap(collectComposePins),
];
const nodeImagePins = imagePins.filter((pin) => pin.base.kind !== "not-node");

/** The `docker` job's build matrix — the images CI actually builds. */
function ciDockerMatrixServices(): string[] {
  const source = readFileSync(join(workflowsDir, "ci.yml"), "utf8");
  const workflow = load(source, { schema: JSON_SCHEMA }) as Workflow;
  const services: unknown = workflow.jobs?.docker?.strategy?.matrix?.service;
  if (!Array.isArray(services)) {
    throw new Error(
      "ci.yml no longer exposes jobs.docker.strategy.matrix.service; " +
        "update this guard so the Docker build matrix stays covered.",
    );
  }
  return (services as readonly unknown[]).map((service) => String(service));
}

describe("Container image Node version pins", () => {
  test("every repo Dockerfile is discovered", () => {
    // Sanity check: if the walker stops finding files, every assertion below
    // passes vacuously.
    expect(dockerfiles).toContain("Dockerfile");
    expect(dockerfiles).toContain("docker/server/Dockerfile");
    expect(dockerfiles).toContain("docker/client/Dockerfile");
    expect(dockerfiles).toContain("docker/gateway/Dockerfile");
    expect(dockerfiles).toContain("docker/validator/Dockerfile");
    expect(dockerfiles).toContain("docker/edge/Dockerfile");
    expect(composeFiles).toContain("docker-compose.yml");
    expect(nodeImagePins.length).toBeGreaterThan(0);
  });

  test("every Dockerfile ci.yml builds exists and was scanned", () => {
    const expected = ciDockerMatrixServices().map(
      (service) => `docker/${service}/Dockerfile`,
    );

    expect(expected.length).toBeGreaterThan(0);
    for (const path of expected) {
      expect(dockerfiles).toContain(path);
      expect(
        collectDockerfilePins(path).some((pin) => pin.base.kind !== "not-node"),
      ).toBe(true);
    }
  });

  test("no node image base resolves below Node 22", () => {
    const offenders = nodeImagePins.filter(
      (pin) =>
        pin.base.kind !== "resolved" || pin.base.major < MINIMUM_NODE_MAJOR,
    );

    expect(
      offenders.map((pin) => {
        const detail =
          pin.base.kind === "resolved"
            ? `${pin.image} -> Node ${pin.base.major}`
            : pin.base.kind === "unresolved"
              ? pin.base.reason
              : pin.image;
        return `${pin.file} (${pin.location}): ${detail}`;
      }),
    ).toEqual([]);
  });

  test("package.json engines advertises a Node floor CI actually builds", () => {
    const pkg: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    );
    const engines = (pkg as { engines?: { node?: unknown } }).engines;
    const declared = engines?.node;

    expect(typeof declared).toBe("string");
    const floor = /^>=\s*(\d+)/.exec(typeof declared === "string" ? declared : "");
    expect(floor).not.toBeNull();
    expect(
      Number.parseInt(floor?.[1] ?? "0", 10),
    ).toBeGreaterThanOrEqual(MINIMUM_NODE_MAJOR);
  });
});
