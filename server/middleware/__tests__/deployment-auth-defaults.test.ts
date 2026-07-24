import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("production deployment API-key defaults", () => {
  it("registers all API routes behind the gateway pipeline", () => {
    const startup = repositoryFile("server/index.ts");
    const gatewayIndex = startup.indexOf(
      "const apiKeyManager = setupApiGateway(app, gatewayConfig);",
    );
    const healthIndex = startup.indexOf("app.use('/api', healthRouter);");
    const swaggerIndex = startup.indexOf(
      "registerSwaggerRoutes(app, gatewayConfig);",
    );

    expect(gatewayIndex).toBeGreaterThanOrEqual(0);
    expect(healthIndex).toBeGreaterThan(gatewayIndex);
    expect(swaggerIndex).toBeGreaterThan(gatewayIndex);
    expect(startup).not.toContain("'/api/metrics'");
  });

  it("enables authentication in each production Docker image", () => {
    for (const dockerfile of [
      "Dockerfile",
      "docker/server/Dockerfile",
      "docker/edge/Dockerfile",
    ]) {
      expect(repositoryFile(dockerfile)).toContain("ENABLE_API_KEYS=true");
    }
  });

  it("requires a file-backed bootstrap secret in Docker Compose", () => {
    for (const composeFile of [
      "docker-compose.yml",
      "docker/edge/docker-compose.yml",
    ]) {
      const compose = repositoryFile(composeFile);
      expect(compose).toContain("ENABLE_API_KEYS=${ENABLE_API_KEYS:-true}");
      expect(compose).toContain("API_KEYS_FILE=/run/secrets/api_keys");
      expect(compose).toContain(
        "${API_KEYS_FILE:?Set API_KEYS_FILE to a bootstrap API-key secret file}",
      );
    }
  });

  it("defaults both Helm charts on and requires an existing Secret", () => {
    for (const valuesFile of [
      "helm/oxscada/values.yaml",
      "helm/oxscada-full/values.yaml",
    ]) {
      expect(repositoryFile(valuesFile)).toMatch(
        /enableGlobalAuth:\s*true/u,
      );
    }

    for (const templateFile of [
      "helm/oxscada/templates/deployment.yaml",
      "helm/oxscada-full/templates/server-deployment.yaml",
    ]) {
      expect(repositoryFile(templateFile)).toContain(
        "server.apiKeys.existingSecret is required when API-key authentication is enabled",
      );
    }
  });

  it("injects a required bootstrap key into the raw Kubernetes deployment", () => {
    const deployment = repositoryFile("k8s/app/server-deployment.yaml");
    expect(deployment).toContain("name: ENABLE_API_KEYS");
    expect(deployment).toContain('value: "true"');
    expect(deployment).toContain("name: API_KEYS");
    expect(deployment).toContain("name: oxscada-api-keys");
    expect(deployment).toContain("key: API_KEYS");
  });
});
