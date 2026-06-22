/**
 * Tests for OPC-UA security-policy selection + cert path resolution (#461).
 *
 * Pure logic only; the cert-generation helper (`ensureServerCertificate`) is
 * NOT exercised here because it requires the node-opcua dependency + filesystem
 * and is documented as runtime-only / live-run-gated.
 */
import { describe, test, expect } from "vitest";
import {
  selectSecurityProfile,
  resolveCertificatePaths,
} from "../security";

describe("selectSecurityProfile", () => {
  test("development: None + Basic256Sha256, anonymous allowed", () => {
    const p = selectSecurityProfile("development");
    expect(p.allowAnonymous).toBe(true);
    expect(p.automaticallyAcceptUnknownCertificate).toBe(true);
    expect(p.userTokenPolicies).toContain("Anonymous");
    expect(p.userTokenPolicies).toContain("UserName");
    expect(p.endpoints.map((e) => e.securityPolicy)).toContain("None");
    expect(p.endpoints.map((e) => e.securityPolicy)).toContain(
      "Basic256Sha256",
    );
  });

  test("test env behaves like development", () => {
    const p = selectSecurityProfile("test");
    expect(p.allowAnonymous).toBe(true);
  });

  test("production: Basic256Sha256 SignAndEncrypt ONLY, no anonymous", () => {
    const p = selectSecurityProfile("production");
    expect(p.allowAnonymous).toBe(false);
    expect(p.automaticallyAcceptUnknownCertificate).toBe(false);
    expect(p.userTokenPolicies).toEqual(["UserName"]);
    expect(p.endpoints).toEqual([
      { securityPolicy: "Basic256Sha256", securityMode: "SignAndEncrypt" },
    ]);
    expect(p.endpoints.some((e) => e.securityPolicy === "None")).toBe(false);
  });

  test("staging is treated as production-grade", () => {
    const p = selectSecurityProfile("staging");
    expect(p.allowAnonymous).toBe(false);
    expect(p.endpoints[0].securityPolicy).toBe("Basic256Sha256");
  });
});

describe("resolveCertificatePaths", () => {
  test("resolves node-opcua PKI layout under the root", () => {
    const paths = resolveCertificatePaths("/var/pki");
    expect(paths.rootFolder).toBe("/var/pki");
    // path.join normalises separators; assert on the tail segments.
    expect(paths.certificateFile.replace(/\\/g, "/")).toBe(
      "/var/pki/own/certs/server_cert.pem",
    );
    expect(paths.privateKeyFile.replace(/\\/g, "/")).toBe(
      "/var/pki/own/private_key.pem",
    );
  });
});
