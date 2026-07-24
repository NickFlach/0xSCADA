import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface ChartValues {
  gateway?: {
    podSecurityContext?: Record<string, unknown>;
    securityContext?: Record<string, unknown>;
  };
  securityContext?: Record<string, unknown>;
  containerSecurityContext?: Record<string, unknown>;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function readValues(path: string): ChartValues {
  return load(readFileSync(`${repositoryRoot}${path}`, "utf8")) as ChartValues;
}

describe("simple Helm chart gateway hardening", () => {
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

  it("wires the shared hardened defaults into the ranged gateway deployment", () => {
    const template = readFileSync(
      `${repositoryRoot}helm/oxscada/templates/deployment.yaml`,
      "utf8",
    );

    expect(template).toContain(
      'dict "server" .Values.server "client" .Values.client "gateway" .Values.gateway',
    );
    expect(template).toContain("toYaml $.Values.securityContext | nindent 8");
    expect(template).toContain("toYaml $.Values.containerSecurityContext | nindent 12");
  });
});
