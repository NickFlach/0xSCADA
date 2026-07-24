import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dump, load, loadAll } from "js-yaml";
import { describe, expect, it } from "vitest";

interface ChartValues {
  gateway?: {
    podSecurityContext?: Record<string, unknown>;
    securityContext?: Record<string, unknown>;
  };
  securityContext?: Record<string, unknown>;
  containerSecurityContext?: Record<string, unknown>;
}

interface ContainerManifest {
  name?: string;
  env?: Array<{ name?: string; value?: string }>;
  ports?: Array<{ containerPort?: number; name?: string }>;
  securityContext?: Record<string, unknown>;
  livenessProbe?: { httpGet?: { path?: string; port?: number } };
  readinessProbe?: { httpGet?: { path?: string; port?: number } };
}

interface KubernetesManifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    template?: {
      spec?: {
        securityContext?: Record<string, unknown>;
        containers?: ContainerManifest[];
      };
    };
  };
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function readValues(path: string): ChartValues {
  return load(readFileSync(join(repositoryRoot, path), "utf8")) as ChartValues;
}

function renderChart(
  releaseName: string,
  chartPath: string,
  overrides: string[] = [],
): KubernetesManifest[] {
  const helmBinary = process.env.HELM_BINARY || "helm";
  const rendered = execFileSync(
    helmBinary,
    [
      "template",
      releaseName,
      chartPath,
      ...overrides,
    ],
    { encoding: "utf8" },
  );
  const manifests: KubernetesManifest[] = [];
  loadAll(rendered, (manifest) => {
    if (manifest && typeof manifest === "object") {
      manifests.push(manifest as KubernetesManifest);
    }
  });
  return manifests;
}

function gatewayDeployment(manifests: KubernetesManifest[]): KubernetesManifest {
  const matches = manifests.filter(
    (manifest) =>
      manifest.kind === "Deployment"
      && manifest.spec?.template?.spec?.containers?.some(
        (container) => container.name === "gateway",
      ),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function gatewayContainer(deployment: KubernetesManifest): ContainerManifest {
  const matches = deployment.spec?.template?.spec?.containers?.filter(
    (container) => container.name === "gateway",
  ) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function environment(
  container: ContainerManifest,
): Record<string, string | undefined> {
  return Object.fromEntries(
    (container.env ?? []).map((entry) => [entry.name, entry.value]),
  );
}

function expectGatewayRuntime(
  deployment: KubernetesManifest,
  port: number,
  serverUrl: string,
): void {
  const container = gatewayContainer(deployment);
  expect(deployment.spec?.template?.spec?.securityContext).toEqual({
    fsGroup: 1000,
    runAsNonRoot: true,
    runAsUser: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  });
  expect(container.securityContext).toEqual({
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
  });
  expect(container.ports).toEqual(expect.arrayContaining([
    expect.objectContaining({ containerPort: port }),
  ]));
  expect(environment(container)).toMatchObject({
    PORT: String(port),
    SERVER_URL: serverUrl,
  });
  expect(container.livenessProbe?.httpGet).toEqual({
    path: "/health",
    port,
  });
  expect(container.readinessProbe?.httpGet).toEqual({
    path: "/readyz",
    port,
  });
}

function removeUnavailableLocalDependencies(chartPath: string): void {
  const metadataPath = join(chartPath, "Chart.yaml");
  const metadata = load(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const dependencies = Array.isArray(metadata.dependencies)
    ? metadata.dependencies
    : [];
  metadata.dependencies = dependencies.filter((dependency) => {
    if (!dependency || typeof dependency !== "object") return true;
    const repository = (dependency as Record<string, unknown>).repository;
    return typeof repository !== "string" || !repository.startsWith("file://");
  });
  writeFileSync(metadataPath, dump(metadata, { lineWidth: -1 }), "utf8");
}

describe("gateway Helm chart hardening", () => {
  it("applies defaults equivalent to the full chart gateway", () => {
    const simple = readValues("helm/oxscada/values.yaml");
    const full = readValues("helm/oxscada-full/values.yaml");

    expect(simple.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(simple.containerSecurityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(simple.securityContext).toEqual(full.gateway?.podSecurityContext);
    expect(simple.containerSecurityContext).toEqual(full.gateway?.securityContext);
  });

  const renderIt = process.env.RUN_HELM_RENDER_TEST === "1" ? it : it.skip;

  renderIt("renders hardened defaults and gateway runtime wiring", () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "oxscada-helm-render-"));
    const simpleChartPath = join(scratchRoot, "oxscada");
    const fullChartPath = join(scratchRoot, "oxscada-full");
    try {
      cpSync(join(repositoryRoot, "helm/oxscada"), simpleChartPath, { recursive: true });
      execFileSync(
        process.env.HELM_BINARY || "helm",
        ["dependency", "build", simpleChartPath],
        { stdio: "pipe" },
      );
      cpSync(join(repositoryRoot, "helm/oxscada-full"), fullChartPath, {
        recursive: true,
      });
      // The repository does not contain the full chart's declared file://
      // subcharts (tracked in #548). Remove only those unavailable dependency
      // declarations in the scratch copy so Helm still parses and renders the
      // real parent templates and values under test.
      removeUnavailableLocalDependencies(fullChartPath);

      const simpleDefaults = gatewayDeployment(renderChart(
        "oxscada",
        simpleChartPath,
        ["--set", "postgresql.enabled=false"],
      ));
      expect(simpleDefaults.metadata?.name).toBe("oxscada-gateway");
      expectGatewayRuntime(simpleDefaults, 8080, "http://oxscada-server:5000");

      const simpleOverrides = gatewayDeployment(renderChart(
        "oxscada",
        simpleChartPath,
        [
          "--set",
          "postgresql.enabled=false",
          "--set",
          "gateway.port=18080",
          "--set-string",
          "gateway.serverUrl=https://upstream.internal:8443",
        ],
      ));
      expectGatewayRuntime(
        simpleOverrides,
        18080,
        "https://upstream.internal:8443",
      );

      const fullDefaults = gatewayDeployment(renderChart(
        "oxscada-full",
        fullChartPath,
      ));
      expect(fullDefaults.metadata?.name).toBe("oxscada-full-gateway");
      expectGatewayRuntime(
        fullDefaults,
        8080,
        "http://oxscada-full-server:3000",
      );

      const fullOverrides = gatewayDeployment(renderChart(
        "oxscada-full",
        fullChartPath,
        [
          "--set",
          "gateway.port=28080",
          "--set-string",
          "gateway.serverUrl=https://full-upstream.internal:9443",
        ],
      ));
      expectGatewayRuntime(
        fullOverrides,
        28080,
        "https://full-upstream.internal:9443",
      );
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
