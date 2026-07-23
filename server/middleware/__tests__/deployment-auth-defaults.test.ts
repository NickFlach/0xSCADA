import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("production deployment API-key defaults", () => {
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
    const compose = repositoryFile("docker-compose.yml");
    expect(compose).toContain("ENABLE_API_KEYS=${ENABLE_API_KEYS:-true}");
    expect(compose).toContain("API_KEYS_FILE=/run/secrets/api_keys");
    expect(compose).toContain(
      "${API_KEYS_FILE:?Set API_KEYS_FILE to a bootstrap API-key secret file}",
    );
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
});
