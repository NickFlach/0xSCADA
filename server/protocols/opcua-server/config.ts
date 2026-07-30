/**
 * OPC-UA Server Mode — Configuration
 *
 * Zod-validated configuration for the UA server (CROSS-CUTTING RULE #4: Zod for
 * input validation).
 *
 * SAFETY POSTURE (#461): this listener is reachable industrial infrastructure,
 * so every default here is the closed one:
 *
 *   - `enabled` is `false`; the subsystem starts only on an explicit flag.
 *   - `host` is the IPv4 loopback address. Binding anything routable — including
 *     the `0.0.0.0` wildcard — additionally requires `allowRemoteBind`.
 *   - `securityPolicy` is `Basic256Sha256`. Selecting `None` (which adds a plain
 *     unencrypted endpoint alongside the secure one) is refused unless the bind
 *     is loopback-only, and is refused outright in staging/production.
 *   - `allowAnonymous` is `false` in every environment, development included.
 *     Anonymous sessions are refused outright when the policy is `None` on a
 *     non-loopback bind, and in staging/production.
 *   - `trustUnknownClientCertificates` is `false`; auto-accepting unknown client
 *     certificates is only available on a loopback bind.
 *   - Unknown keys are rejected, so a typo'd security flag fails the boot rather
 *     than silently defaulting to something permissive.
 *
 * Part of #461.
 */

import { z } from "zod";
import { DEFAULT_NAMESPACE_URI } from "./address-space";

/** Default bind address: IPv4 loopback, never a routable interface. */
export const DEFAULT_OPCUA_HOST = "127.0.0.1";

/** Default listen port (the IANA-registered OPC-UA port). */
export const DEFAULT_OPCUA_PORT = 4840;

/** Default resource path appended to the endpoint URL. */
export const DEFAULT_OPCUA_RESOURCE_PATH = "/0xscada";

/** Endpoint produced by the shipped defaults. */
export const DEFAULT_OPCUA_ENDPOINT = `opc.tcp://${DEFAULT_OPCUA_HOST}:${DEFAULT_OPCUA_PORT}${DEFAULT_OPCUA_RESOURCE_PATH}`;

/** Wildcard bind addresses — accepted only with an explicit remote-bind opt-in. */
export const WILDCARD_BIND_ADDRESSES: readonly string[] = ["0.0.0.0", "::", "*"];

/** Deployment environments recognised by the security rules. */
export const DeploymentEnvSchema = z.enum([
  "development",
  "test",
  "staging",
  "production",
]);
export type DeploymentEnv = z.infer<typeof DeploymentEnvSchema>;

/** Environments where an unencrypted endpoint or anonymous access is refused. */
export function isHardenedEnv(env: DeploymentEnv): boolean {
  return env === "production" || env === "staging";
}

/**
 * UA SecurityPolicies the operator may select.
 *
 *   - `Basic256Sha256` — the only endpoint is Sign&Encrypt.
 *   - `None`           — an additional *unencrypted* endpoint is exposed next to
 *                        the Basic256Sha256 one, for local tooling only.
 */
export const OpcuaSecurityPolicySchema = z.enum(["Basic256Sha256", "None"]);
export type OpcuaSecurityPolicy = z.infer<typeof OpcuaSecurityPolicySchema>;

/**
 * Is `host` a literal loopback address?
 *
 * Only literal addresses count. Names such as `localhost` are deliberately not
 * treated as loopback: name resolution is not under this process's control, so
 * accepting it would let a `hosts`/DNS entry silently turn a "loopback-only"
 * deployment into a routable one.
 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (value === "::ffff:127.0.0.1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

/** Is `host` one of the "every interface" wildcards? */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_BIND_ADDRESSES.includes(host.trim().toLowerCase());
}

const BaseOpcuaServerConfigSchema = z
  .object({
    /** Start the server at boot. OFF unless explicitly enabled. */
    enabled: z.boolean().default(false),
    /** Bind address. Loopback unless {@link allowRemoteBind} is set. */
    host: z.string().trim().min(1).default(DEFAULT_OPCUA_HOST),
    /**
     * Explicit acknowledgement that the listener may be reached from off-host.
     * Required for any non-loopback {@link host}, wildcards included.
     */
    allowRemoteBind: z.boolean().default(false),
    /** Listen port. `0` requests an ephemeral port and is loopback-only. */
    port: z.coerce.number().int().min(0).max(65535).default(DEFAULT_OPCUA_PORT),
    /** Resource path appended to the endpoint URL. */
    resourcePath: z.string().default(DEFAULT_OPCUA_RESOURCE_PATH),
    /** UA ApplicationUri / namespace URI for application nodes. */
    applicationUri: z.string().min(1).default(DEFAULT_NAMESPACE_URI),
    /** UA server name advertised to clients. */
    serverName: z.string().min(1).default("0xSCADA OPC-UA Server"),
    /**
     * Deployment environment. Defaults to the most restrictive value so an
     * unset/unknown `NODE_ENV` cannot relax the security rules.
     */
    env: DeploymentEnvSchema.default("production"),
    /** UA SecurityPolicy exposed by the endpoints. */
    securityPolicy: OpcuaSecurityPolicySchema.default("Basic256Sha256"),
    /** Accept anonymous UA sessions. OFF everywhere unless explicitly set. */
    allowAnonymous: z.boolean().default(false),
    /** Auto-trust unknown client certificates. Loopback-only convenience. */
    trustUnknownClientCertificates: z.boolean().default(false),
    /** PKI root; node-opcua provisions/loads server key material underneath. */
    pkiFolder: z.string().min(1).default("./pki/opcua-server"),
    /**
     * Disable the PKI folder's filesystem watchers. Live trust-list reload is
     * useful in production but leaks handles across many short-lived servers,
     * so tests turn it off.
     */
    disableCertificateFileWatchers: z.boolean().default(false),
    /**
     * How often (ms) the server samples tag changes for subscriptions. The UA
     * sampling/publishing intervals are negotiated per-monitored-item; this caps
     * how fast 0xSCADA tag updates are forwarded into the address space.
     */
    minSamplingIntervalMs: z.coerce.number().int().min(10).default(100),
    /** Max concurrent client connections per endpoint. */
    maxSessions: z.coerce.number().int().min(1).default(100),
    /** Master switch for the control write path. Off by default. */
    writesEnabled: z.boolean().default(false),
    /** Explicit per-tag allowlist. Empty means no writable tags. */
    writableTags: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

/**
 * Cross-field safety rules. These are the rules the maintainer's review of #461
 * called out, and they are enforced here (not merely documented) so that no
 * caller — env loader, test, or programmatic embedder — can construct a
 * permissive server by accident.
 */
export const OpcuaServerConfigSchema = BaseOpcuaServerConfigSchema.superRefine(
  (config, ctx) => {
    const loopback = isLoopbackHost(config.host);
    const wildcard = isWildcardHost(config.host);
    const hardened = isHardenedEnv(config.env);

    if (!loopback && !config.allowRemoteBind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host"],
        message: wildcard
          ? `Refusing to bind the wildcard address "${config.host}": set allowRemoteBind=true ` +
            "(OPCUA_SERVER_ALLOW_REMOTE_BIND=true) to deliberately expose the OPC-UA server, " +
            `or keep the default loopback bind (${DEFAULT_OPCUA_HOST}).`
          : `Refusing to bind the non-loopback address "${config.host}": set allowRemoteBind=true ` +
            "(OPCUA_SERVER_ALLOW_REMOTE_BIND=true) to deliberately expose the OPC-UA server, " +
            `or keep the default loopback bind (${DEFAULT_OPCUA_HOST}).`,
      });
    }

    if (config.port === 0 && !loopback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["port"],
        message:
          "An ephemeral port (0) is only allowed on a loopback bind; pick an explicit port.",
      });
    }

    if (config.securityPolicy === "None" && !loopback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["securityPolicy"],
        message:
          'SecurityPolicy "None" exposes an unencrypted OPC-UA endpoint and is only permitted ' +
          "on a loopback bind. Use Basic256Sha256 for any reachable interface.",
      });
    }

    if (config.securityPolicy === "None" && hardened) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["securityPolicy"],
        message: `SecurityPolicy "None" is not permitted when env="${config.env}".`,
      });
    }

    if (config.allowAnonymous && config.securityPolicy === "None" && !loopback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowAnonymous"],
        message:
          "Anonymous access is refused when SecurityPolicy is None on a non-loopback bind.",
      });
    }

    if (config.allowAnonymous && hardened) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowAnonymous"],
        message: `Anonymous access is not permitted when env="${config.env}".`,
      });
    }

    if (config.trustUnknownClientCertificates && !loopback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trustUnknownClientCertificates"],
        message:
          "Automatically trusting unknown client certificates is only permitted on a loopback " +
          "bind; manage the PKI trust list explicitly for reachable deployments.",
      });
    }
  },
);

export type OpcuaServerConfig = z.infer<typeof OpcuaServerConfigSchema>;

/** Raised for any invalid OPC-UA server configuration. */
export class OpcuaServerConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpcuaServerConfigError";
  }
}

/** Render a ZodError into an operator-readable, single-string explanation. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${at}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse + validate raw config, applying the fail-closed defaults.
 *
 * Throws {@link OpcuaServerConfigError} on anything invalid — including unknown
 * keys — so misconfiguration can never degrade into a permissive listener.
 */
export function loadOpcuaServerConfig(raw: unknown = {}): OpcuaServerConfig {
  const result = OpcuaServerConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new OpcuaServerConfigError(
      `Invalid OPC-UA server configuration — ${formatIssues(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Strict boolean parsing for environment variables. Anything that is not an
 * unambiguous truthy/falsey token is an error: an operator who writes
 * `OPCUA_SERVER_ALLOW_ANONYMOUS=maybe` must not silently get `false` (or worse,
 * a truthy non-empty string).
 */
export function parseEnvBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalised = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalised)) return true;
  if (["false", "0", "no", "off"].includes(normalised)) return false;
  throw new OpcuaServerConfigError(
    `Invalid boolean for ${name}: "${value}". Use true or false.`,
  );
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Build the config from the process environment.
 *
 * `OPCUA_SERVER_ENABLED` is the single documented flag that turns the subsystem
 * on; every other variable only ever narrows or widens an already-validated
 * setting and is checked by the same schema.
 */
export function loadOpcuaServerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpcuaServerConfig {
  const raw: Record<string, unknown> = {
    enabled: parseEnvBoolean(
      "OPCUA_SERVER_ENABLED",
      env.OPCUA_SERVER_ENABLED,
      false,
    ),
    allowRemoteBind: parseEnvBoolean(
      "OPCUA_SERVER_ALLOW_REMOTE_BIND",
      env.OPCUA_SERVER_ALLOW_REMOTE_BIND,
      false,
    ),
    allowAnonymous: parseEnvBoolean(
      "OPCUA_SERVER_ALLOW_ANONYMOUS",
      env.OPCUA_SERVER_ALLOW_ANONYMOUS,
      false,
    ),
    trustUnknownClientCertificates: parseEnvBoolean(
      "OPCUA_SERVER_TRUST_UNKNOWN_CLIENT_CERTS",
      env.OPCUA_SERVER_TRUST_UNKNOWN_CLIENT_CERTS,
      false,
    ),
    writesEnabled: parseEnvBoolean(
      "OPCUA_SERVER_WRITES_ENABLED",
      env.OPCUA_SERVER_WRITES_ENABLED,
      false,
    ),
  };

  const host = optional(env.OPCUA_SERVER_HOST);
  if (host !== undefined) raw.host = host;
  const port = optional(env.OPCUA_SERVER_PORT);
  if (port !== undefined) raw.port = port;
  const resourcePath = optional(env.OPCUA_SERVER_RESOURCE_PATH);
  if (resourcePath !== undefined) raw.resourcePath = resourcePath;
  const applicationUri = optional(env.OPCUA_SERVER_APPLICATION_URI);
  if (applicationUri !== undefined) raw.applicationUri = applicationUri;
  const serverName = optional(env.OPCUA_SERVER_NAME);
  if (serverName !== undefined) raw.serverName = serverName;
  const securityPolicy = optional(env.OPCUA_SERVER_SECURITY_POLICY);
  if (securityPolicy !== undefined) raw.securityPolicy = securityPolicy;
  const pkiFolder = optional(env.OPCUA_SERVER_PKI_FOLDER);
  if (pkiFolder !== undefined) raw.pkiFolder = pkiFolder;
  const sampling = optional(env.OPCUA_SERVER_MIN_SAMPLING_MS);
  if (sampling !== undefined) raw.minSamplingIntervalMs = sampling;
  const maxSessions = optional(env.OPCUA_SERVER_MAX_SESSIONS);
  if (maxSessions !== undefined) raw.maxSessions = maxSessions;
  const writableTags = optional(env.OPCUA_SERVER_WRITABLE_TAGS);
  if (writableTags !== undefined) {
    raw.writableTags = writableTags.split(",").map((tag) => tag.trim()).filter(Boolean);
  }

  // NODE_ENV drives `env`, but only when it is one this module understands. An
  // unrecognised value falls through to the schema default ("production"), the
  // most restrictive interpretation.
  const nodeEnv = optional(env.NODE_ENV);
  if (nodeEnv !== undefined && DeploymentEnvSchema.safeParse(nodeEnv).success) {
    raw.env = nodeEnv;
  }

  return loadOpcuaServerConfig(raw);
}

/** Build the endpoint URL a client would connect to. */
export function endpointUrl(config: OpcuaServerConfig): string {
  const path = config.resourcePath.startsWith("/")
    ? config.resourcePath
    : `/${config.resourcePath}`;
  return `opc.tcp://${config.host}:${config.port}${path}`;
}
