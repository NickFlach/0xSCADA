/**
 * OPC-UA Server Mode — Security Profile Selection
 *
 * Turns a validated {@link OpcuaServerConfig} into the concrete set of UA
 * endpoints, user-token policies and certificate-trust behaviour the server will
 * expose. Pure and dependency-free, so it is fully unit-testable.
 *
 * The profile is derived from *explicit configuration*, never from `NODE_ENV`
 * alone. The original #461 slice keyed the whole posture off the environment,
 * which is exactly how a development image ended up advertising an unencrypted,
 * anonymous-accessible endpoint. Here the environment can only ever *tighten*
 * the outcome — `staging`/`production` refuse `None` and anonymous — while
 * opening anything up requires the operator to have set the corresponding flag.
 *
 * These invariants are checked in two places on purpose (here and in the Zod
 * schema in `config.ts`): a caller that hand-builds a config object still cannot
 * obtain a permissive profile.
 *
 * Part of #461.
 */

import path from "path";
import {
  isHardenedEnv,
  isLoopbackHost,
  type DeploymentEnv,
  type OpcuaServerConfig,
} from "./config";

/**
 * String identifiers for the UA SecurityPolicies we support. These match the
 * `SecurityPolicy` enum member names in `node-opcua`, so the server wiring can
 * index the enum directly without this module importing the dependency.
 */
export type SecurityPolicyName = "None" | "Basic256Sha256";

/** UA MessageSecurityMode names (mirrors `node-opcua` MessageSecurityMode). */
export type MessageSecurityModeName = "None" | "Sign" | "SignAndEncrypt";

/** UA user-identity token policies we offer. */
export type UserTokenPolicyName = "Anonymous" | "UserName";

export type { DeploymentEnv };

export interface EndpointSecurityOption {
  securityPolicy: SecurityPolicyName;
  securityMode: MessageSecurityModeName;
}

export interface SecurityProfile {
  /** Security options the server endpoints will advertise. */
  endpoints: EndpointSecurityOption[];
  /** Accepted user-identity token types. */
  userTokenPolicies: UserTokenPolicyName[];
  /** Whether anonymous sessions are accepted. */
  allowAnonymous: boolean;
  /** Whether unknown/untrusted client certificates are auto-accepted. */
  automaticallyAcceptUnknownCertificate: boolean;
}

/** Raised when a requested security posture is refused. */
export class OpcuaSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpcuaSecurityError";
  }
}

/** The inputs that determine the security posture. */
export interface SecurityProfileInput {
  securityPolicy: SecurityPolicyName;
  allowAnonymous: boolean;
  trustUnknownClientCertificates: boolean;
  /** The address the TCP listener will bind to. */
  host: string;
  env: DeploymentEnv;
}

/**
 * Select the security profile for an explicitly configured posture.
 *
 *   - `Basic256Sha256` (default) → a single Sign&Encrypt endpoint.
 *   - `None` → an additional unencrypted endpoint *next to* the Sign&Encrypt
 *     one, permitted only on a loopback bind and never in staging/production.
 *     The secure endpoint is always kept, which is also what makes
 *     username/password tokens available on the unencrypted endpoint: node-opcua
 *     only advertises an RSA-protected UserName policy when a secure policy is
 *     present in the endpoint's policy list.
 *
 * Throws {@link OpcuaSecurityError} rather than degrading to something
 * permissive.
 */
export function selectSecurityProfile(
  input: SecurityProfileInput,
): SecurityProfile {
  const loopback = isLoopbackHost(input.host);
  const hardened = isHardenedEnv(input.env);

  if (input.securityPolicy === "None") {
    if (!loopback) {
      throw new OpcuaSecurityError(
        'SecurityPolicy "None" exposes an unencrypted OPC-UA endpoint and is only permitted ' +
          `on a loopback bind (requested host "${input.host}").`,
      );
    }
    if (hardened) {
      throw new OpcuaSecurityError(
        `SecurityPolicy "None" is not permitted when env="${input.env}".`,
      );
    }
  }

  if (input.allowAnonymous) {
    if (hardened) {
      throw new OpcuaSecurityError(
        `Anonymous OPC-UA access is not permitted when env="${input.env}".`,
      );
    }
    if (input.securityPolicy === "None" && !loopback) {
      throw new OpcuaSecurityError(
        "Anonymous OPC-UA access is refused when SecurityPolicy is None on a non-loopback bind.",
      );
    }
  }

  if (input.trustUnknownClientCertificates && !loopback) {
    throw new OpcuaSecurityError(
      "Automatically trusting unknown client certificates is only permitted on a loopback bind.",
    );
  }

  const endpoints: EndpointSecurityOption[] =
    input.securityPolicy === "None"
      ? [
          { securityPolicy: "None", securityMode: "None" },
          { securityPolicy: "Basic256Sha256", securityMode: "SignAndEncrypt" },
        ]
      : [{ securityPolicy: "Basic256Sha256", securityMode: "SignAndEncrypt" }];

  const userTokenPolicies: UserTokenPolicyName[] = input.allowAnonymous
    ? ["Anonymous", "UserName"]
    : ["UserName"];

  return {
    endpoints,
    userTokenPolicies,
    allowAnonymous: input.allowAnonymous,
    automaticallyAcceptUnknownCertificate: input.trustUnknownClientCertificates,
  };
}

/** Convenience: derive the profile from a validated server config. */
export function securityProfileFromConfig(
  config: OpcuaServerConfig,
): SecurityProfile {
  return selectSecurityProfile({
    securityPolicy: config.securityPolicy,
    allowAnonymous: config.allowAnonymous,
    trustUnknownClientCertificates: config.trustUnknownClientCertificates,
    host: config.host,
    env: config.env,
  });
}

// ─── Certificate material locations ──────────────────────────────────────────

export interface CertificatePaths {
  /** Directory holding the PKI store (own + trusted + rejected + issuers). */
  rootFolder: string;
  /** Server application certificate (PEM). */
  certificateFile: string;
  /** Server private key (PEM). */
  privateKeyFile: string;
}

/**
 * Resolve the certificate paths node-opcua uses for a PKI root.
 *
 * `OPCUACertificateManager({ rootFolder })` treats `rootFolder` as the PKI root
 * directly; `OPCUABaseServer` then derives `own/certs/certificate.pem` from it,
 * and `node-opcua-pki` keeps the key at `own/private/private_key.pem`. The
 * manager provisions self-signed material on first start when the files are
 * absent — for production, drop CA-issued material at these paths instead and
 * populate the `trusted/` list.
 */
export function resolveCertificatePaths(rootFolder: string): CertificatePaths {
  return {
    rootFolder,
    certificateFile: path.join(rootFolder, "own", "certs", "certificate.pem"),
    privateKeyFile: path.join(rootFolder, "own", "private", "private_key.pem"),
  };
}
