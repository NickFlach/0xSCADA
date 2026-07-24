import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { load, loadAll } from "js-yaml";
import { describe, expect, it } from "vitest";

interface Manifest {
  kind?: string;
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  data?: Record<string, string>;
  spec?: Record<string, any>;
}

interface Container {
  name?: string;
  image?: string;
  env?: Array<Record<string, any>>;
  ports?: Array<Record<string, any>>;
  startupProbe?: Record<string, any>;
  livenessProbe?: Record<string, any>;
  readinessProbe?: Record<string, any>;
  securityContext?: Record<string, any>;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const chartRelativePath = "helm/oxscada-full";
const helmBinary = process.env.HELM_BINARY || "helm";

function trackedChartCopy(scratchRoot: string): string {
  const chartPath = join(scratchRoot, "oxscada-full");
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", chartRelativePath],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim().split(/\r?\n/).filter(Boolean);

  expect(tracked).toContain("helm/oxscada-full/Chart.yaml");
  expect(tracked).toContain("helm/oxscada-full/values-production.yaml");
  for (const sourceRelativePath of tracked) {
    const destination = join(
      chartPath,
      relative(chartRelativePath, sourceRelativePath),
    );
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repositoryRoot, sourceRelativePath), destination);
  }
  return chartPath;
}

function render(
  release: string,
  chartPath: string,
  args: string[] = [],
): Manifest[] {
  const yaml = execFileSync(
    helmBinary,
    ["template", release, chartPath, "--namespace", "oxscada", ...args],
    { encoding: "utf8" },
  );
  const manifests: Manifest[] = [];
  loadAll(yaml, (manifest) => {
    if (manifest && typeof manifest === "object") {
      manifests.push(manifest as Manifest);
    }
  });
  return manifests;
}

function one(manifests: Manifest[], kind: string, name: string): Manifest {
  const matches = manifests.filter(
    (manifest) => manifest.kind === kind && manifest.metadata?.name === name,
  );
  expect(matches, `${kind}/${name}`).toHaveLength(1);
  return matches[0]!;
}

function absent(manifests: Manifest[], name: string): void {
  expect(
    manifests.filter((manifest) => manifest.metadata?.name === name),
    name,
  ).toHaveLength(0);
}

function workloadContainer(
  manifests: Manifest[],
  kind: string,
  name: string,
  containerName: string,
): { workload: Manifest; container: Container } {
  const workload = one(manifests, kind, name);
  const containers = (workload.spec?.template?.spec?.containers ?? [])
    .filter((container: Container) => container.name === containerName);
  expect(containers, `${kind}/${name} container ${containerName}`).toHaveLength(1);
  return { workload, container: containers[0]! };
}

function env(container: Container, name: string): Record<string, any> | undefined {
  return container.env?.find((entry) => entry.name === name);
}

function expectReleaseSelector(workload: Manifest, release: string): void {
  expect(workload.spec?.selector?.matchLabels).toMatchObject({
    "app.kubernetes.io/instance": release,
  });
  expect(workload.spec?.template?.metadata?.labels).toMatchObject({
    "app.kubernetes.io/instance": release,
  });
}

function expectHardened(
  workload: Manifest,
  container: Container,
  runAsUser: number,
  readOnlyRootFilesystem: boolean | undefined,
): void {
  expect(workload.spec?.template?.spec?.securityContext).toEqual({
    fsGroup: runAsUser,
    runAsNonRoot: true,
    runAsUser,
    seccompProfile: { type: "RuntimeDefault" },
  });
  expect(container.securityContext).toMatchObject({
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  });
  expect(container.securityContext?.readOnlyRootFilesystem)
    .toBe(readOnlyRootFilesystem);
}

function expectServicePort(
  manifests: Manifest[],
  name: string,
  ports: Array<{ name: string; port: number }>,
): void {
  const service = one(manifests, "Service", name);
  expect(service.spec?.selector).toMatchObject({
    "app.kubernetes.io/instance": name.split("-")[0],
  });
  expect(service.spec?.ports).toEqual(expect.arrayContaining(
    ports.map((port) => expect.objectContaining(port)),
  ));
}

describe("oxscada-full Helm packaging", () => {
  it("uses parent templates rather than unavailable local subcharts", () => {
    const metadata = load(readFileSync(
      join(repositoryRoot, chartRelativePath, "Chart.yaml"),
      "utf8",
    )) as Record<string, unknown>;
    expect(metadata.dependencies).toBeUndefined();
  });

  const renderIt = process.env.RUN_HELM_RENDER_TEST === "1" ? it : it.skip;

  renderIt("builds, lints, packages, and renders the complete stack", () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "oxscada-full-chart-"));
    try {
      const chartPath = trackedChartCopy(scratchRoot);
      const productionValues = join(chartPath, "values-production.yaml");
      const authSecretArgs = [
        "--set-string",
        "server.apiKeys.existingSecret=render-test-api-keys",
      ];

      execFileSync(helmBinary, ["dependency", "build", chartPath], {
        stdio: "pipe",
      });
      execFileSync(
        helmBinary,
        ["lint", "--strict", chartPath, ...authSecretArgs],
        { stdio: "pipe" },
      );
      execFileSync(
        helmBinary,
        ["lint", "--strict", chartPath, "--values", productionValues],
        { stdio: "pipe" },
      );

      const defaults = render("review", chartPath, authSecretArgs);
      const production = render(
        "production",
        chartPath,
        ["--values", productionValues],
      );

      const server = workloadContainer(
        defaults,
        "Deployment",
        "review-server",
        "server",
      );
      expect(server.container.image).toBe(
        "ghcr.io/nickflach/oxscada-server:latest",
      );
      expect(server.container.ports).toContainEqual({
        containerPort: 5000,
        name: "http",
      });
      expect(server.container.startupProbe?.httpGet).toEqual({
        path: "/api/healthz",
        port: 5000,
      });
      expect(server.container.livenessProbe?.httpGet).toEqual({
        path: "/api/healthz",
        port: 5000,
      });
      expect(server.container.readinessProbe?.httpGet).toEqual({
        path: "/api/readyz",
        port: 5000,
      });
      expect(env(server.container, "DATABASE_URL")?.valueFrom?.secretKeyRef)
        .toEqual({ key: "DATABASE_URL", name: "oxscada-database" });
      expect(env(server.container, "ENABLE_API_KEYS")?.value).toBe("true");
      expect(env(server.container, "API_KEYS")?.valueFrom?.secretKeyRef)
        .toEqual({ key: "API_KEYS", name: "render-test-api-keys" });
      expect(env(server.container, "BLOCKCHAIN_RPC_URL")?.value)
        .toBe("http://review-blockchain:8545");
      expectHardened(server.workload, server.container, 1000, true);
      expectReleaseSelector(server.workload, "review");

      const client = workloadContainer(
        defaults,
        "Deployment",
        "review-client",
        "client",
      );
      expect(client.container.image).toBe(
        "ghcr.io/nickflach/oxscada-client:latest",
      );
      expect(client.container.livenessProbe?.httpGet).toEqual({
        path: "/health",
        port: 80,
      });
      expect(client.container.readinessProbe?.httpGet).toEqual({
        path: "/",
        port: 80,
      });
      expectHardened(client.workload, client.container, 101, undefined);
      expectReleaseSelector(client.workload, "review");

      const gateway = workloadContainer(
        defaults,
        "Deployment",
        "review-gateway",
        "gateway",
      );
      expect(gateway.container.image).toBe(
        "ghcr.io/nickflach/oxscada-gateway:latest",
      );
      expect(env(gateway.container, "SERVER_URL")?.value)
        .toBe("http://review-server:5000");
      expect(gateway.container.livenessProbe?.httpGet).toEqual({
        path: "/health",
        port: 8080,
      });
      expect(gateway.container.readinessProbe?.httpGet).toEqual({
        path: "/readyz",
        port: 8080,
      });
      expectHardened(gateway.workload, gateway.container, 1000, true);
      expectReleaseSelector(gateway.workload, "review");

      const blockchain = workloadContainer(
        defaults,
        "StatefulSet",
        "review-blockchain",
        "blockchain",
      );
      expect(blockchain.container.image).toBe(
        "ghcr.io/nickflach/oxscada-validator:latest",
      );
      expect(blockchain.container.ports).toEqual(expect.arrayContaining([
        { containerPort: 8545, name: "rpc" },
        { containerPort: 30303, name: "p2p" },
      ]));
      expect(blockchain.container.livenessProbe?.httpGet).toEqual({
        path: "/health",
        port: 8545,
      });
      expect(blockchain.container.readinessProbe?.httpGet).toEqual({
        path: "/health",
        port: 8545,
      });
      expect(blockchain.workload.spec?.serviceName)
        .toBe("review-blockchain-headless");
      expect(blockchain.workload.spec?.volumeClaimTemplates?.[0]?.metadata?.name)
        .toBe("data");
      expectHardened(
        blockchain.workload,
        blockchain.container,
        1000,
        undefined,
      );
      expectReleaseSelector(blockchain.workload, "review");

      const prometheus = workloadContainer(
        defaults,
        "Deployment",
        "review-prometheus",
        "prometheus",
      );
      expect(prometheus.container.image).toBe(
        "docker.io/prom/prometheus:v2.48.0",
      );
      expect(prometheus.container.livenessProbe?.httpGet).toEqual({
        path: "/-/healthy",
        port: 9090,
      });
      expect(prometheus.container.readinessProbe?.httpGet).toEqual({
        path: "/-/ready",
        port: 9090,
      });
      expectHardened(prometheus.workload, prometheus.container, 65534, true);
      expectReleaseSelector(prometheus.workload, "review");
      expect(one(defaults, "ConfigMap", "review-prometheus")
        .data?.["prometheus.yml"]).toContain("review-server:5000");

      const grafana = workloadContainer(
        defaults,
        "Deployment",
        "review-grafana",
        "grafana",
      );
      expect(grafana.container.image).toBe(
        "docker.io/grafana/grafana:10.2.0",
      );
      expect(grafana.container.livenessProbe?.httpGet).toEqual({
        path: "/api/health",
        port: 3000,
      });
      expect(grafana.container.readinessProbe?.httpGet).toEqual({
        path: "/api/health",
        port: 3000,
      });
      expect(env(grafana.container, "GF_SECURITY_ADMIN_PASSWORD")
        ?.valueFrom?.secretKeyRef).toEqual({
        key: "admin-password",
        name: "oxscada-grafana",
      });
      expectHardened(grafana.workload, grafana.container, 472, true);
      expectReleaseSelector(grafana.workload, "review");
      expect(one(defaults, "ConfigMap", "review-grafana-datasources")
        .data?.["datasources.yaml"]).toContain(
        "http://review-prometheus:9090",
      );

      expectServicePort(defaults, "review-server", [
        { name: "http", port: 5000 },
      ]);
      expectServicePort(defaults, "review-client", [
        { name: "http", port: 80 },
      ]);
      expectServicePort(defaults, "review-gateway", [
        { name: "http", port: 8080 },
      ]);
      expectServicePort(defaults, "review-blockchain", [
        { name: "rpc", port: 8545 },
        { name: "p2p", port: 30303 },
      ]);
      expectServicePort(defaults, "review-prometheus", [
        { name: "http", port: 9090 },
      ]);
      expectServicePort(defaults, "review-grafana", [
        { name: "http", port: 3000 },
      ]);

      const ingress = one(production, "Ingress", "production");
      const ingressPaths = ingress.spec?.rules?.[0]?.http?.paths ?? [];
      expect(ingressPaths).toEqual(expect.arrayContaining([
        expect.objectContaining({
          backend: {
            service: { name: "production-client", port: { number: 80 } },
          },
          path: "/",
        }),
        expect.objectContaining({
          backend: {
            service: { name: "production-server", port: { number: 5000 } },
          },
          path: "/api",
        }),
        expect.objectContaining({
          backend: {
            service: { name: "production-gateway", port: { number: 8080 } },
          },
          path: "/gateway",
        }),
      ]));
      expect(one(production, "PersistentVolumeClaim", "production-prometheus")
        .spec?.resources?.requests?.storage).toBe("50Gi");
      expect(one(production, "PersistentVolumeClaim", "production-grafana")
        .spec?.resources?.requests?.storage).toBe("10Gi");
      const productionServer = workloadContainer(
        production,
        "Deployment",
        "production-server",
        "server",
      );
      expect(env(productionServer.container, "API_KEYS")
        ?.valueFrom?.secretKeyRef?.name).toBe(
        "oxscada-production-api-keys",
      );
      expect(productionServer.workload.spec?.replicas).toBe(3);

      const disabled = render(
        "minimal",
        chartPath,
        [
          ...authSecretArgs,
          "--set",
          "blockchain.enabled=false",
          "--set",
          "observability.enabled=false",
        ],
      );
      for (const component of [
        "blockchain",
        "blockchain-headless",
        "prometheus",
        "grafana",
        "grafana-datasources",
      ]) {
        absent(disabled, `minimal-${component}`);
      }

      expect(() => render(
        "missing-server",
        chartPath,
        [
          "--set",
          "server.enabled=false",
          "--set",
          "observability.enabled=false",
        ],
      )).toThrow(/gateway\.serverUrl is required/);

      const externalGateway = render(
        "external",
        chartPath,
        [
          "--set",
          "server.enabled=false",
          "--set",
          "observability.enabled=false",
          "--set-string",
          "gateway.serverUrl=https://scada.example.test",
        ],
      );
      absent(externalGateway, "external-server");
      expect(env(
        workloadContainer(
          externalGateway,
          "Deployment",
          "external-gateway",
          "gateway",
        ).container,
        "SERVER_URL",
      )?.value).toBe("https://scada.example.test");

      expect(() => render(
        "missing-scrape-target",
        chartPath,
        [
          "--set",
          "server.enabled=false",
          "--set",
          "gateway.enabled=false",
          "--set",
          "observability.grafana.enabled=false",
        ],
      )).toThrow(/server\.enabled must be true/);

      expect(() => render(
        "missing-datasource",
        chartPath,
        [
          ...authSecretArgs,
          "--set",
          "observability.prometheus.enabled=false",
        ],
      )).toThrow(/observability\.prometheus\.enabled must be true/);

      expect(() => render(
        "disabled-ingress-backend",
        chartPath,
        [
          "--values",
          productionValues,
          "--set",
          "client.enabled=false",
        ],
      )).toThrow(/ingress service "client" is disabled/);

      const packageDirectory = join(scratchRoot, "packages");
      mkdirSync(packageDirectory);
      execFileSync(
        helmBinary,
        ["package", chartPath, "--destination", packageDirectory],
        { stdio: "pipe" },
      );
      const packaged = render(
        "packaged",
        join(packageDirectory, "oxscada-full-0.1.1.tgz"),
        ["--values", productionValues],
      );
      one(packaged, "Deployment", "packaged-server");
      one(packaged, "StatefulSet", "packaged-blockchain");
      one(packaged, "Deployment", "packaged-prometheus");
      one(packaged, "Deployment", "packaged-grafana");
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
