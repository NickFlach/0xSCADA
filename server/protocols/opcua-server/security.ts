/**
 * OPC-UA Server Mode — Security Policy & Certificate Management
 *
 * Two concerns live here:
 *   1. PURE security-policy selection (which UA SecurityPolicy/MessageSecurityMode
 *      and user-token policies to expose for a given environment). This is fully
 *      unit-testable with no `node-opcua` dependency.
 *   2. A certificate-generation helper that wraps `node-opcua`'s
 *      OPCUACertificateManager. This part needs the dependency + filesystem at
 *      runtime, so it is loaded lazily and clearly marked.
 *
 * Implements the security acceptance criterion of #461:
 *   - None (dev), Basic256Sha256 (prod), with cert generation helper.
 */

import path from "path";

/**
 * String identifiers for the UA SecurityPolicies we support. These match the
 * `SecurityPolicy` enum member names in `node-opcua` so the server wiring can
 * map them directly without us importing the dependency here.
 */
export type SecurityPolicyName = "None" | "Basic256Sha256";

/** UA MessageSecurityMode names (mirrors `node-opcua` MessageSecurityMode). */
export type MessageSecurityModeName = "None" | "Sign" | "SignAndEncrypt";

/** UA user-identity token policies we offer. */
export type UserTokenPolicyName = "Anonymous" | "UserName";

export type DeploymentEnv = "development" | "test" | "staging" | "production";

export interface EndpointSecurityOption {
  securityPolicy: SecurityPolicyName;
  securityMode: MessageSecurityModeName;
}

export interface SecurityProfile {
  /** Security options the server endpoint will advertise. */
  endpoints: EndpointSecurityOption[];
  /** Accepted user-identity token types. */
  userTokenPolicies: UserTokenPolicyName[];
  /**
   * Whether anonymous access is permitted. Mirrors presence of "Anonymous" in
   * {@link userTokenPolicies} but surfaced explicitly for readability.
   */
  allowAnonymous: boolean;
  /**
   * Whether unknown/untrusted client certificates are auto-accepted. True only
   * in non-production to ease local testing; production requires explicit
   * trust-list management.
   */
  automaticallyAcceptUnknownCertificate: boolean;
}

/**
 * Select the security profile for an environment.
 *
 *   - development / test : SecurityPolicy=None + anonymous + username/password.
 *     Auto-accepts unknown client certs (local dev convenience).
 *   - staging / production : Basic256Sha256 (SignAndEncrypt) ONLY, username/
 *     password only (no anonymous), strict cert trust.
 *
 * This is the single source of truth for the "None (dev) / Basic256Sha256
 * (prod)" acceptance criterion and is exercised directly by unit tests.
 */
export function selectSecurityProfile(env: DeploymentEnv): SecurityProfile {
  const isProd = env === "production" || env === "staging";

  if (isProd) {
    return {
      endpoints: [
        {
          securityPolicy: "Basic256Sha256",
          securityMode: "SignAndEncrypt",
        },
      ],
      userTokenPolicies: ["UserName"],
      allowAnonymous: false,
      automaticallyAcceptUnknownCertificate: false,
    };
  }

  return {
    endpoints: [
      { securityPolicy: "None", securityMode: "None" },
      // Also expose the secure policy in dev so clients can exercise it.
      { securityPolicy: "Basic256Sha256", securityMode: "SignAndEncrypt" },
    ],
    userTokenPolicies: ["Anonymous", "UserName"],
    allowAnonymous: true,
    automaticallyAcceptUnknownCertificate: true,
  };
}

// ─── Certificate material locations ──────────────────────────────────────────

export interface CertificatePaths {
  /** Directory holding the PKI store (own + trusted + rejected). */
  rootFolder: string;
  /** Server application certificate (PEM). */
  certificateFile: string;
  /** Server private key (PEM). */
  privateKeyFile: string;
}

/**
 * Resolve standard certificate paths under a PKI root. We follow the
 * `node-opcua` OPCUACertificateManager layout (own/certs, own/private_key.pem)
 * so a manager pointed at {@link rootFolder} finds the generated material.
 */
export function resolveCertificatePaths(rootFolder: string): CertificatePaths {
  return {
    rootFolder,
    certificateFile: path.join(rootFolder, "own", "certs", "server_cert.pem"),
    privateKeyFile: path.join(rootFolder, "own", "private_key.pem"),
  };
}

export interface CertGenerationOptions {
  /** PKI root folder; created if absent. */
  rootFolder: string;
  /** Subject/applicationUri for the self-signed certificate. */
  applicationUri: string;
  /** Subject common name. Defaults to "0xSCADA OPC-UA Server". */
  subject?: string;
  /** DNS names / IPs to embed as Subject Alternative Names. */
  dns?: string[];
  ip?: string[];
  /** Validity in days. Defaults to 365. */
  validityDays?: number;
}

/**
 * Generate (idempotently) a self-signed server certificate + private key using
 * `node-opcua`'s OPCUACertificateManager.
 *
 * RUNTIME-ONLY: requires the `node-opcua` dependency and filesystem access, so
 * it is dynamically imported. The core policy logic above does NOT depend on
 * this. Returns the resolved {@link CertificatePaths}.
 *
 * TODO(#461): in production, replace self-signed material with a cert issued by
 * the site CA and manage the trusted/rejected lists via an operator workflow.
 */
export async function ensureServerCertificate(
  options: CertGenerationOptions,
): Promise<CertificatePaths> {
  const paths = resolveCertificatePaths(options.rootFolder);

  // INTEGRATION(node-opcua): dynamic import keeps this file importable (and the
  // policy logic testable) even when the optional dependency is absent. Typed
  // loosely at this single dependency boundary (same convention as index.ts and
  // the existing vendor adapters) so node-opcua's internal cert API shape does
  // not leak into this module's strict surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeOpcua: any = await import("node-opcua");
  const { OPCUACertificateManager } = nodeOpcua;

  const certificateManager = new OPCUACertificateManager({
    rootFolder: options.rootFolder,
    automaticallyAcceptUnknownCertificate: false,
  });
  await certificateManager.initialize();

  const fs = await import("fs");
  if (!fs.existsSync(paths.certificateFile)) {
    await certificateManager.createSelfSignedCertificate({
      applicationUri: options.applicationUri,
      subject: options.subject ?? "/CN=0xSCADA OPC-UA Server",
      dns: options.dns ?? ["localhost"],
      ip: options.ip ?? [],
      outputFile: paths.certificateFile,
      startDate: new Date(),
      validity: options.validityDays ?? 365,
    });
  }

  return paths;
}
