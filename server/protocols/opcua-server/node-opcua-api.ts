/**
 * OPC-UA Server Mode — `node-opcua` dependency boundary.
 *
 * `node-opcua` is a large CommonJS library whose published typings pull in ~40
 * sibling packages. Rather than leak that surface across the server wiring (or
 * fall back to `any`, which this repository forbids), this module declares the
 * *narrow structural view* of the API that `index.ts` actually uses and does the
 * single cast at the boundary.
 *
 * The module is loaded through a runtime `import()` of a non-literal specifier
 * so that:
 *   - the rest of the folder (address-space mapping, config, security, auth)
 *     stays importable and unit-testable without the dependency resolved, and
 *   - the loader is injectable, which is what lets the live binding test drive a
 *     real server/client session (see `__tests__/live-binding.test.ts`).
 *
 * Every shape below was written against node-opcua 2.175.x
 * (`OPCUAServerOptions`, `OPCUAServerEndpointOptions`, `IUserManagerEx`,
 * `AddVariableOptions`, `OPCUACertificateManagerOptions`). In particular note
 * that `isValidUserAsync` is **callback-style** in node-opcua, not
 * promise-returning — see `user-auth.ts`.
 *
 * Part of #461.
 */

/** Opaque handle to a node-opcua runtime object we only ever hand back. */
export type UaHandle = object;

/** node-opcua `UAVariable`, restricted to the members the server drives. */
export interface UaVariable {
  setValueFromSource(
    value: UaHandle,
    statusCode?: unknown,
    sourceTimestamp?: Date,
  ): void;
  writeValue(
    context: { getUserName(): string },
    dataValue: { value: { value: unknown } },
    indexRange: unknown,
    callback: (err: Error | null, statusCode?: unknown) => void,
  ): void;
}

/** Options accepted by `Namespace.addVariable` that this server sets. */
export interface UaAddVariableOptions {
  componentOf: UaHandle;
  nodeId: string;
  browseName: string;
  displayName: string;
  description?: string;
  dataType: unknown;
  valueRank?: number;
  accessLevel: number;
  userAccessLevel: number;
  minimumSamplingInterval: number;
  value: {
    refreshFunc: (
      callback: (err: Error | null, dataValue?: UaHandle) => void,
    ) => void;
  };
}

/** node-opcua `Namespace`, restricted to the members the server drives. */
export interface UaNamespace {
  /** Actual namespace index assigned by the address space. */
  readonly index: number;
  addFolder(
    parent: UaHandle,
    options: { browseName: string; displayName?: string; nodeId: string },
  ): UaHandle;
  addVariable(options: UaAddVariableOptions): UaVariable;
}

/** node-opcua `AddressSpace`, restricted to the members the server drives. */
export interface UaAddressSpace {
  registerNamespace(namespaceUri: string): UaNamespace;
  readonly rootFolder: { readonly objects: UaHandle };
}

/** node-opcua `OPCUAServer`, restricted to the members the server drives. */
export interface UaServer {
  readonly engine: { readonly addressSpace: UaAddressSpace | null };
  /** Live endpoints; `endpoints[0].port` resolves an ephemeral (`port: 0`) bind. */
  readonly endpoints: ReadonlyArray<{ readonly port: number }>;
  initialize(): Promise<void>;
  start(): Promise<void>;
  shutdown(timeout?: number): Promise<void>;
  dispose(): void;
  getEndpointUrl(): string;
}

/** node-opcua `OPCUACertificateManager`, restricted to what we drive. */
export interface UaCertificateManager {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The subset of `OPCUAServerOptions` this server sets. Field names and
 * semantics mirror node-opcua exactly.
 */
export interface UaServerOptions {
  /** IP/interface the TCP listener binds to. Omitting it makes node-opcua bind
   *  every interface, which is precisely what this server must never do. */
  host: string;
  /** Hostname advertised in the endpoint URL. */
  hostname: string;
  port: number;
  resourcePath: string;
  serverInfo: { applicationUri: string; applicationName: string };
  buildInfo: { productName: string };
  maxConnectionsPerEndpoint: number;
  securityPolicies: unknown[];
  securityModes: unknown[];
  /** node-opcua defaults this to `true`; the server always sets it explicitly. */
  allowAnonymous: boolean;
  serverCertificateManager: UaCertificateManager;
  /**
   * Certificate manager used to validate **user** X509 identity tokens.
   *
   * node-opcua falls back to `getDefaultCertificateManager("UserPKI")` when this
   * is omitted, and that shared default is constructed with
   * `automaticallyAcceptUnknownCertificate: true` — i.e. any self-signed
   * certificate is accepted as a valid user identity, with no lookup against the
   * `users` table. Never leave it unset.
   */
  userCertificateManager: UaCertificateManager;
  userManager: {
    isValidUserAsync(
      username: string,
      password: string,
      callback: (err: Error | null, isAuthorized?: boolean) => void,
    ): void;
  };
}

/** Options accepted by `OPCUACertificateManager`. */
export interface UaCertificateManagerOptions {
  rootFolder: string;
  automaticallyAcceptUnknownCertificate: boolean;
  disableFileWatchers?: boolean;
}

/** The members of the `node-opcua` module namespace this server consumes. */
export interface NodeOpcuaApi {
  OPCUAServer: new (options: UaServerOptions) => UaServer;
  OPCUACertificateManager: new (
    options: UaCertificateManagerOptions,
  ) => UaCertificateManager;
  Variant: new (options: {
    dataType: unknown;
    value: unknown;
    arrayType?: unknown;
  }) => UaHandle;
  DataValue: new (options: {
    value: UaHandle;
    statusCode: unknown;
    sourceTimestamp: Date;
  }) => UaHandle;
  /** `DataType` enum, indexed by member name (`"Double"`, `"Boolean"`, …). */
  DataType: Record<string, unknown>;
  VariantArrayType: Record<string, unknown>;
  /** `StatusCodes` table, indexed by member name (`"Good"`, `"Bad"`, …). */
  StatusCodes: Record<string, unknown>;
  /** `SecurityPolicy` enum, indexed by member name (`"Basic256Sha256"`, …). */
  SecurityPolicy: Record<string, unknown>;
  /** `MessageSecurityMode` enum, indexed by member name (`"SignAndEncrypt"`, …). */
  MessageSecurityMode: Record<string, unknown>;
}

/** Loads the node-opcua module. Injectable so tests can supply their own. */
export type NodeOpcuaLoader = () => Promise<NodeOpcuaApi>;

/**
 * Module specifier, held in a variable on purpose: a runtime `import()` of a
 * non-literal specifier keeps the optional dependency out of the static module
 * graph, so `tsc`, `vite` and the pure unit tests all work whether or not it is
 * installed.
 */
const NODE_OPCUA_MODULE_ID = "node-opcua";

/** Members that must be present before we accept the loaded module. */
const REQUIRED_MEMBERS: readonly (keyof NodeOpcuaApi)[] = [
  "OPCUAServer",
  "OPCUACertificateManager",
  "Variant",
  "DataValue",
  "DataType",
  "VariantArrayType",
  "StatusCodes",
  "SecurityPolicy",
  "MessageSecurityMode",
];

/** Thrown when `node-opcua` is absent or does not expose the expected API. */
export class NodeOpcuaUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NodeOpcuaUnavailableError";
  }
}

function resolveNamespace(loaded: unknown): Record<string, unknown> {
  const namespace = loaded as Record<string, unknown>;
  // node-opcua is CommonJS: depending on the loader, the named exports may sit
  // on the namespace object itself or behind `default`.
  if (typeof namespace.OPCUAServer === "function") return namespace;
  const fallback = namespace.default;
  if (fallback && typeof fallback === "object") {
    return fallback as Record<string, unknown>;
  }
  return namespace;
}

/**
 * Load `node-opcua` and verify it exposes everything the server needs.
 *
 * Throws {@link NodeOpcuaUnavailableError} — never returns a partially usable
 * module — so a misconfigured deployment fails closed instead of starting a
 * half-wired listener.
 */
export const loadNodeOpcua: NodeOpcuaLoader = async (): Promise<NodeOpcuaApi> => {
  const specifier: string = NODE_OPCUA_MODULE_ID;
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ specifier);
  } catch (err) {
    throw new NodeOpcuaUnavailableError(
      `The "${NODE_OPCUA_MODULE_ID}" package could not be loaded. It is a declared ` +
        "dependency; run `npm ci` (or `npm install`) before enabling OPC-UA Server Mode.",
      { cause: err },
    );
  }

  const namespace = resolveNamespace(loaded);
  const missing = REQUIRED_MEMBERS.filter(
    (member) => namespace[member] === undefined,
  );
  if (missing.length > 0) {
    throw new NodeOpcuaUnavailableError(
      `The "${NODE_OPCUA_MODULE_ID}" package is installed but does not export: ` +
        `${missing.join(", ")}. Expected node-opcua ^2.130.0.`,
    );
  }

  return namespace as unknown as NodeOpcuaApi;
};

/**
 * Probe whether the dependency can be loaded. Used by the live binding test to
 * skip (with a truthful reason) instead of asserting against a stand-in.
 */
export async function isNodeOpcuaAvailable(): Promise<boolean> {
  try {
    await loadNodeOpcua();
    return true;
  } catch {
    return false;
  }
}
