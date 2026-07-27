/**
 * Tests for OPC-UA security-profile selection + cert path resolution (#461).
 *
 * The profile is derived from explicit configuration, not from NODE_ENV, and
 * refuses (rather than downgrades) anything the safety rules disallow. These
 * checks are deliberately duplicated with `config.test.ts`: the Zod schema and
 * this selector are two independent gates, and a caller that hand-builds a
 * config object must still be unable to obtain a permissive profile.
 */
import { describe, test, expect } from "vitest";
import {
  OpcuaSecurityError,
  resolveCertificatePaths,
  securityProfileFromConfig,
  selectSecurityProfile,
  type SecurityProfileInput,
} from "../security";
import { loadOpcuaServerConfig } from "../config";

const loopbackSecure: SecurityProfileInput = {
  securityPolicy: "Basic256Sha256",
  allowAnonymous: false,
  trustUnknownClientCertificates: false,
  host: "127.0.0.1",
  env: "development",
};

describe("selectSecurityProfile", () => {
  test("default posture: Sign&Encrypt only, UserName only, strict cert trust", () => {
    const profile = selectSecurityProfile(loopbackSecure);
    expect(profile.endpoints).toEqual([
      { securityPolicy: "Basic256Sha256", securityMode: "SignAndEncrypt" },
    ]);
    expect(profile.userTokenPolicies).toEqual(["UserName"]);
    expect(profile.allowAnonymous).toBe(false);
    expect(profile.automaticallyAcceptUnknownCertificate).toBe(false);
  });

  test("production keeps the same closed posture", () => {
    const profile = selectSecurityProfile({
      ...loopbackSecure,
      env: "production",
      host: "10.0.0.5",
    });
    expect(profile.allowAnonymous).toBe(false);
    expect(profile.endpoints.some((e) => e.securityPolicy === "None")).toBe(
      false,
    );
  });

  test('policy "None" keeps the secure endpoint alongside the unencrypted one', () => {
    const profile = selectSecurityProfile({
      ...loopbackSecure,
      securityPolicy: "None",
    });
    expect(profile.endpoints).toEqual([
      { securityPolicy: "None", securityMode: "None" },
      { securityPolicy: "Basic256Sha256", securityMode: "SignAndEncrypt" },
    ]);
  });

  test("anonymous is only in the token policies when explicitly enabled", () => {
    expect(selectSecurityProfile(loopbackSecure).userTokenPolicies).not.toContain(
      "Anonymous",
    );
    expect(
      selectSecurityProfile({ ...loopbackSecure, allowAnonymous: true })
        .userTokenPolicies,
    ).toContain("Anonymous");
  });
});

describe("selectSecurityProfile refusals", () => {
  test('refuses "None" on a non-loopback bind', () => {
    expect(() =>
      selectSecurityProfile({
        ...loopbackSecure,
        securityPolicy: "None",
        host: "10.0.0.5",
      }),
    ).toThrow(OpcuaSecurityError);
  });

  test.each(["production", "staging"] as const)(
    'refuses "None" in %s even on loopback',
    (env) => {
      expect(() =>
        selectSecurityProfile({ ...loopbackSecure, securityPolicy: "None", env }),
      ).toThrow(OpcuaSecurityError);
    },
  );

  test.each(["production", "staging"] as const)(
    "refuses anonymous access in %s",
    (env) => {
      expect(() =>
        selectSecurityProfile({ ...loopbackSecure, allowAnonymous: true, env }),
      ).toThrow(/Anonymous OPC-UA access is not permitted/);
    },
  );

  test("refuses anonymous when the policy is None on a non-loopback bind", () => {
    expect(() =>
      selectSecurityProfile({
        ...loopbackSecure,
        securityPolicy: "None",
        allowAnonymous: true,
        host: "0.0.0.0",
      }),
    ).toThrow(OpcuaSecurityError);
  });

  test("refuses auto-trusting unknown client certificates off loopback", () => {
    expect(() =>
      selectSecurityProfile({
        ...loopbackSecure,
        trustUnknownClientCertificates: true,
        host: "10.0.0.5",
      }),
    ).toThrow(OpcuaSecurityError);
  });
});

describe("securityProfileFromConfig", () => {
  test("the shipped defaults produce the closed profile", () => {
    const profile = securityProfileFromConfig(loadOpcuaServerConfig());
    expect(profile.allowAnonymous).toBe(false);
    expect(profile.automaticallyAcceptUnknownCertificate).toBe(false);
    expect(profile.endpoints).toEqual([
      { securityPolicy: "Basic256Sha256", securityMode: "SignAndEncrypt" },
    ]);
  });
});

describe("resolveCertificatePaths", () => {
  test("matches the node-opcua PKI layout under the root", () => {
    const paths = resolveCertificatePaths("/var/pki");
    expect(paths.rootFolder).toBe("/var/pki");
    // path.join normalises separators; assert on the tail segments.
    expect(paths.certificateFile.replace(/\\/g, "/")).toBe(
      "/var/pki/own/certs/certificate.pem",
    );
    expect(paths.privateKeyFile.replace(/\\/g, "/")).toBe(
      "/var/pki/own/private/private_key.pem",
    );
  });
});
