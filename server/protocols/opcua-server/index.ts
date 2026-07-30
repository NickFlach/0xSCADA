/**
 * OPC-UA Server Mode — Server Lifecycle
 *
 * Exposes 0xSCADA tags as a standard UA address space so external SCADA systems
 * and historians can browse, read and subscribe. Wires the `node-opcua` runtime
 * around the pure modules in this folder:
 *
 *   - `address-space.ts`  : sites/tags -> UA folder/variable plan (pure)
 *   - `security.ts`       : endpoint/security-policy selection (pure)
 *   - `user-auth.ts`      : UA UserName token -> existing `users` table
 *   - `config.ts`         : Zod-validated, fail-closed configuration
 *   - `node-opcua-api.ts` : the single typed `node-opcua` dependency boundary
 *   - `runtime.ts`        : the opt-in production startup path
 *
 * SAFETY (#461): this class never invents defaults. It is handed an already
 * validated {@link OpcuaServerConfig}, re-derives the security profile from it
 * (which throws rather than degrading), and always passes `host` and
 * `allowAnonymous` explicitly — node-opcua's own defaults are "every interface"
 * and "anonymous allowed", so leaving either unset is not an option.
 *
 * @module server/protocols/opcua-server
 */

import path from "path";
import { logError, logInfo, logWarn } from "../../logger";
import {
  buildAddressSpace,
  summarizePlan,
  type BuildAddressSpaceOptions,
} from "./address-space";
import { endpointUrl, type OpcuaServerConfig } from "./config";
import {
  loadNodeOpcua,
  type NodeOpcuaApi,
  type NodeOpcuaLoader,
  type UaAddressSpace,
  type UaCertificateManager,
  type UaHandle,
  type UaNamespace,
  type UaServer,
  type UaVariable,
} from "./node-opcua-api";
import { securityProfileFromConfig } from "./security";
import { createUserManager, type UserLookup } from "./user-auth";
import type {
  AddressSpacePlan,
  SourceSite,
  SourceTag,
  TagSample,
  TagWriteRequest,
  UaVariableNode,
} from "./types";
import { UaDataType } from "./types";

/**
 * Data source the server reads from. Implementations live behind
 * `server/storage.ts` (see `runtime.ts`); we accept an interface so the server
 * is testable and decoupled from the Drizzle layer.
 */
export interface TagDataSource {
  /** Load the sites + tags that define the address space. */
  loadSites(): Promise<SourceSite[]>;
  loadTags(): Promise<SourceTag[]>;
  /** Latest known value for a tag (used to answer UA reads/samples). */
  readTag(tagId: string): Promise<TagSample | undefined>;
  /**
   * Subscribe to tag value changes. Invokes `onChange` for every update and
   * returns an unsubscribe function. This is what drives UA
   * DataChangeNotifications.
   */
  subscribe(onChange: (sample: TagSample) => void): () => void;
  /** Persist/dispatch an authorized control write and its audit record. */
  writeTag?(request: TagWriteRequest): Promise<void>;
}

export interface OpcuaServerDeps {
  config: OpcuaServerConfig;
  dataSource: TagDataSource;
  /** Resolves usernames against the existing user store for UserName tokens. */
  userLookup: UserLookup;
  addressSpaceOptions?: BuildAddressSpaceOptions;
  /** Injectable node-opcua loader (tests supply their own). */
  loadNodeOpcuaModule?: NodeOpcuaLoader;
}

/**
 * The 0xSCADA OPC-UA server. `node-opcua` is loaded lazily in `start()` so this
 * module stays importable — and the surrounding logic unit-testable — without
 * pulling the dependency's module graph into every boot.
 */
export class OxScadaOpcuaServer {
  private readonly config: OpcuaServerConfig;
  private readonly dataSource: TagDataSource;
  private readonly userLookup: UserLookup;
  private readonly addressSpaceOptions?: BuildAddressSpaceOptions;
  private readonly loadNodeOpcuaModule: NodeOpcuaLoader;

  private plan: AddressSpacePlan | null = null;
  private server: UaServer | null = null;
  private certificateManager: UaCertificateManager | null = null;
  private userCertificateManager: UaCertificateManager | null = null;
  /** Variable NodeId -> node-opcua UAVariable, for value pushes. */
  private readonly uaVariables = new Map<string, UaVariable>();
  private unsubscribe: (() => void) | null = null;
  private running = false;

  constructor(deps: OpcuaServerDeps) {
    this.config = deps.config;
    this.dataSource = deps.dataSource;
    this.userLookup = deps.userLookup;
    this.addressSpaceOptions = deps.addressSpaceOptions;
    this.loadNodeOpcuaModule = deps.loadNodeOpcuaModule ?? loadNodeOpcua;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The validated configuration this instance was built from. */
  get configuration(): OpcuaServerConfig {
    return this.config;
  }

  /**
   * The port actually bound. Differs from `config.port` when an ephemeral port
   * (`port: 0`, loopback-only) was requested.
   */
  get boundPort(): number | null {
    return this.server?.endpoints[0]?.port ?? null;
  }

  /**
   * The endpoint URL clients connect to.
   *
   * Built from the configured host and the *bound* port, so it stays accurate
   * when an ephemeral port was requested (node-opcua bakes the advertised URL at
   * initialize() time, before the OS has assigned one).
   */
  get endpoint(): string {
    const port = this.boundPort ?? this.config.port;
    return endpointUrl({ ...this.config, port });
  }

  /** The address-space plan, available after `start()`. */
  get addressSpacePlan(): AddressSpacePlan | null {
    return this.plan;
  }

  /**
   * Start the UA server: load node-opcua, register the application namespace,
   * project the 0xSCADA sites/tags into it, and wire subscriptions.
   *
   * Any failure leaves the process without a listener — there is no partial or
   * degraded start.
   */
  async start(): Promise<void> {
    if (this.running) {
      logWarn("[opcua-server] start() called while already running");
      return;
    }

    // Re-derive (and re-validate) the posture from the config. Throws on any
    // combination the security rules refuse.
    const profile = securityProfileFromConfig(this.config);

    const nodeOpcua = await this.loadNodeOpcuaModule();
    const {
      OPCUAServer,
      OPCUACertificateManager,
      SecurityPolicy,
      MessageSecurityMode,
    } = nodeOpcua;

    const certificateManager = new OPCUACertificateManager({
      rootFolder: this.config.pkiFolder,
      automaticallyAcceptUnknownCertificate:
        profile.automaticallyAcceptUnknownCertificate,
      disableFileWatchers: this.config.disableCertificateFileWatchers,
    });
    await certificateManager.initialize();
    this.certificateManager = certificateManager;

    // Separate trust store for *user* X509 identity tokens. node-opcua always
    // advertises a Certificate user-token policy, and when the server does not
    // supply a manager it falls back to a process-wide default built with
    // `automaticallyAcceptUnknownCertificate: true` — any self-signed
    // certificate then becomes a valid *user identity* with no lookup against
    // the `users` table, which defeats `allowAnonymous: false` entirely.
    //
    // Auto-accept is hardcoded off here, deliberately not tied to
    // `trustUnknownClientCertificates`: that flag is a channel-level
    // convenience for local tooling, whereas accepting an unknown certificate as
    // an *identity* is an authentication decision. 0xSCADA has no UA user-cert
    // enrolment path, so the closed answer is the only correct one — UserName
    // against the existing user store is the supported identity.
    const userCertificateManager = new OPCUACertificateManager({
      rootFolder: path.join(this.config.pkiFolder, "userPKI"),
      automaticallyAcceptUnknownCertificate: false,
      disableFileWatchers: this.config.disableCertificateFileWatchers,
    });
    await userCertificateManager.initialize();
    this.userCertificateManager = userCertificateManager;

    const userManager = createUserManager(this.userLookup);

    const server = new OPCUAServer({
      // Bind + advertise the configured address. node-opcua binds every
      // interface when `host` is omitted, so this is never left to the default.
      host: this.config.host,
      hostname: this.config.host,
      port: this.config.port,
      resourcePath: this.config.resourcePath,
      serverInfo: {
        applicationUri: this.config.applicationUri,
        applicationName: this.config.serverName,
      },
      buildInfo: { productName: this.config.serverName },
      maxConnectionsPerEndpoint: this.config.maxSessions,
      securityPolicies: profile.endpoints.map(
        (endpoint) => SecurityPolicy[endpoint.securityPolicy],
      ),
      securityModes: profile.endpoints.map(
        (endpoint) => MessageSecurityMode[endpoint.securityMode],
      ),
      // node-opcua defaults this to true; never rely on that.
      allowAnonymous: profile.allowAnonymous,
      serverCertificateManager: certificateManager,
      userCertificateManager,
      userManager: {
        isValidUserAsync: userManager.isValidUserAsync,
      },
    });

    try {
      await server.initialize();

      const addressSpace = server.engine.addressSpace;
      if (!addressSpace) {
        throw new Error(
          "[opcua-server] node-opcua did not expose an address space after initialize()",
        );
      }
      // Register the application namespace first: its index is assigned by the
      // address space (node-opcua's ServerEngine already holds index 1), and the
      // plan's NodeIds must be built against the index we actually got.
      const namespace = addressSpace.registerNamespace(this.config.applicationUri);
      await this.buildPlan(namespace.index);

      this.populateAddressSpace(addressSpace, namespace, nodeOpcua);
      this.wireSubscriptions(nodeOpcua);
      await server.start();
    } catch (err) {
      // Do not leave a half-initialised server (or its PKI watchers) behind.
      this.server = server;
      await this.stop().catch(() => undefined);
      throw err;
    }

    this.server = server;
    this.running = true;
    logInfo(
      `[opcua-server] listening at ${this.endpoint} ` +
        `(policy=${this.config.securityPolicy}, anonymous=${profile.allowAnonymous}, ` +
        `env=${this.config.env})`,
    );
  }

  /** Stop the server and release subscriptions, sockets and PKI watchers. */
  async stop(): Promise<void> {
    this.running = false;

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    const server = this.server;
    this.server = null;
    if (server) {
      await server.shutdown(0);
      server.dispose();
    }

    const certificateManager = this.certificateManager;
    this.certificateManager = null;
    if (certificateManager) {
      await certificateManager.dispose();
    }

    const userCertificateManager = this.userCertificateManager;
    this.userCertificateManager = null;
    if (userCertificateManager) {
      await userCertificateManager.dispose();
    }

    this.uaVariables.clear();
    this.plan = null;
    if (server) logInfo("[opcua-server] stopped");
  }

  /**
   * Instantiate the UA folder and variable nodes described by the plan into the
   * already-registered application namespace.
   */
  private populateAddressSpace(
    addressSpace: UaAddressSpace,
    namespace: UaNamespace,
    nodeOpcua: NodeOpcuaApi,
  ): void {
    const { DataType, DataValue, StatusCodes, Variant } = nodeOpcua;

    const objectsFolder = addressSpace.rootFolder.objects;

    const plan = this.plan;
    if (!plan) {
      throw new Error("[opcua-server] address-space plan not built");
    }

    // Folders: the root "Sites" folder, then one folder per site.
    const folderByNodeId = new Map<string, UaHandle>();
    for (const folder of plan.folders) {
      const parent = folderByNodeId.get(folder.parentNodeId) ?? objectsFolder;
      const node = namespace.addFolder(parent, {
        browseName: folder.browseName,
        displayName: folder.displayName,
        nodeId: folder.nodeId,
      });
      folderByNodeId.set(folder.nodeId, node);
    }

    // Variables (one per tag).
    for (const variable of plan.variables) {
      const parent = folderByNodeId.get(variable.parentNodeId);
      if (!parent) {
        logWarn(
          `[opcua-server] orphan variable ${variable.nodeId}; missing parent`,
        );
        continue;
      }
      const uaVar = namespace.addVariable({
        componentOf: parent,
        nodeId: variable.nodeId,
        browseName: variable.browseName,
        displayName: variable.displayName,
        description: variable.units
          ? `${variable.tagId} [${variable.units}]`
          : variable.tagId,
        dataType: uaTypeToNodeOpcuaDataType(variable.dataType, DataType),
        ...(variable.valueRank === undefined
          ? {}
          : { valueRank: variable.valueRank }),
        // Read-only unless the source tag is explicitly marked writable. Without
        // this the UA node would inherit node-opcua's default access level.
        accessLevel: variable.accessLevel,
        userAccessLevel: variable.accessLevel,
        minimumSamplingInterval: this.config.minSamplingIntervalMs,
        value: {
          // Async getter: pull the latest sample on each read/sample.
          refreshFunc: (callback) => {
            this.dataSource
              .readTag(variable.tagId)
              .then((sample) => {
                callback(
                  null,
                  new DataValue({
                    value: toVariant(
                      variable,
                      sample,
                      Variant,
                      DataType,
                      nodeOpcua.VariantArrayType,
                    ),
                    statusCode: statusCodeForSample(
                      variable,
                      sample,
                      StatusCodes,
                    ),
                    sourceTimestamp: toDate(sample?.timestamp),
                  }),
                );
              })
              .catch((err: unknown) => {
                logError(err, `[opcua-server] read failed for ${variable.tagId}`);
                callback(err instanceof Error ? err : new Error(String(err)));
              });
          },
        },
      });
      if (
        variable.accessLevel & 0x02 &&
        variable.direction === "input" &&
        this.dataSource.writeTag
      ) {
        const writeTag = this.dataSource.writeTag.bind(this.dataSource);
        uaVar.writeValue = (context, dataValue, _indexRange, callback) => {
          const username = context.getUserName();
          if (!username || username === "anonymous") {
            callback(null, StatusCodes.BadUserAccessDenied);
            return;
          }
          writeTag({
            tagId: variable.tagId,
            siteId: variable.siteId,
            value: dataValue.value.value,
            username,
            timestamp: new Date(),
          }).then(
            () => {
              uaVar.setValueFromSource(dataValue.value, StatusCodes.Good, new Date());
              callback(null, StatusCodes.Good);
            },
            (error: unknown) => {
              logError(error, `[opcua-server] write denied for ${variable.tagId}`);
              callback(null, StatusCodes.BadUserAccessDenied);
            },
          );
        };
      }
      this.uaVariables.set(variable.nodeId, uaVar);
    }
  }

  /**
   * Build (or rebuild) the in-memory address-space plan from the data source.
   *
   * Called by {@link start} before node-opcua is touched, and re-called with the
   * real namespace index once the namespace has been registered.
   */
  async buildPlan(namespaceIndex?: number): Promise<AddressSpacePlan> {
    const [sites, tags] = await Promise.all([
      this.dataSource.loadSites(),
      this.dataSource.loadTags(),
    ]);
    this.plan = buildAddressSpace(sites, tags, {
      ...this.addressSpaceOptions,
      namespaceUri: this.config.applicationUri,
      ...(namespaceIndex === undefined ? {} : { namespaceIndex }),
    });
    const summary = summarizePlan(this.plan);
    logInfo(
      `[opcua-server] address space: ${summary.siteFolders} site folder(s), ${summary.variables} variable(s)`,
    );
    return this.plan;
  }

  /**
   * Wire the data-source subscription so tag updates push new values into the
   * matching UA variable, which node-opcua turns into DataChangeNotifications
   * for any subscribed client.
   */
  private wireSubscriptions(nodeOpcua: NodeOpcuaApi): void {
    const plan = this.plan;
    if (!plan) return;
    const { StatusCodes, Variant, DataType } = nodeOpcua;
    const tagIndex = plan.tagIndex;
    const variablesByTag = new Map<string, UaVariableNode>();
    for (const variable of plan.variables) {
      variablesByTag.set(variable.tagId, variable);
    }

    this.unsubscribe = this.dataSource.subscribe((sample) => {
      const nodeId = tagIndex.get(sample.tagId);
      if (!nodeId) return;
      const uaVar = this.uaVariables.get(nodeId);
      const meta = variablesByTag.get(sample.tagId);
      if (!uaVar || !meta) return;
      uaVar.setValueFromSource(
        toVariant(
          meta,
          sample,
          Variant,
          DataType,
          nodeOpcua.VariantArrayType,
        ),
        statusCodeForSample(meta, sample, StatusCodes),
        toDate(sample.timestamp),
      );
    });
  }
}

/**
 * Convenience factory: validate raw config and build a server instance.
 *
 * Throws `OpcuaServerConfigError` on invalid configuration — a caller can never
 * end up with an instance built from unvalidated input.
 */
export function createOpcuaServer(deps: {
  config: OpcuaServerConfig;
  dataSource: TagDataSource;
  userLookup: UserLookup;
  addressSpaceOptions?: BuildAddressSpaceOptions;
  loadNodeOpcuaModule?: NodeOpcuaLoader;
}): OxScadaOpcuaServer {
  return new OxScadaOpcuaServer(deps);
}

// ─── node-opcua interop helpers ──────────────────────────────────────────────

/** Coerce a {@link TagSample} timestamp into a UA source timestamp. */
function toDate(timestamp: Date | string | undefined): Date {
  if (timestamp instanceof Date) return timestamp;
  if (typeof timestamp === "string") {
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** Map our UaDataType enum to the node-opcua `DataType` enum member. */
function uaTypeToNodeOpcuaDataType(
  type: UaDataType,
  DataType: Record<string, unknown>,
): unknown {
  switch (type) {
    case UaDataType.Boolean:
      return DataType.Boolean;
    case UaDataType.Double:
      return DataType.Double;
    case UaDataType.String:
      return DataType.String;
    default:
      // Object/array tags are exposed as their JSON encoding until proper UA
      // structured types are synthesised (#670). Honest as far as it goes — the
      // declared type is String and the value really is a string — but a
      // conformant client will not know to parse it.
      return DataType.String;
  }
}

/**
 * Build a node-opcua Variant for a sample, coercing to the node's UA type.
 */
function toVariant(
  meta: UaVariableNode,
  sample: TagSample | undefined,
  Variant: NodeOpcuaApi["Variant"],
  DataType: Record<string, unknown>,
  VariantArrayType: Record<string, unknown>,
): UaHandle {
  const raw = sample?.value;
  if (meta.valueRank === 1) {
    // A non-array source value is paired with StatusCodes.Bad by
    // statusCodeForSample. Keep the Variant shape valid without presenting the
    // empty fallback as a successful process reading.
    const values = Array.isArray(raw) ? raw : [];
    return new Variant({
      dataType: uaTypeToNodeOpcuaDataType(meta.dataType, DataType),
      arrayType: VariantArrayType.Array,
      value: values.map((value) => coerceScalar(meta.dataType, value)),
    });
  }
  switch (meta.dataType) {
    case UaDataType.Boolean:
      return new Variant({ dataType: DataType.Boolean, value: Boolean(raw) });
    case UaDataType.Double: {
      const numeric = typeof raw === "number" ? raw : Number(raw ?? 0);
      return new Variant({
        dataType: DataType.Double,
        value: Number.isFinite(numeric) ? numeric : 0,
      });
    }
    case UaDataType.String:
      return new Variant({
        dataType: DataType.String,
        value: raw == null ? "" : String(raw),
      });
    default:
      return new Variant({
        dataType: DataType.String,
        value: raw == null ? "" : JSON.stringify(raw),
      });
  }
}

function coerceScalar(type: UaDataType, value: unknown): unknown {
  switch (type) {
    case UaDataType.Boolean:
      return Boolean(value);
    case UaDataType.Double: {
      return coerceFiniteNumber(value);
    }
    default:
      return value == null ? "" : String(value);
  }
}

/** Convert a source value to a finite number without inventing process data. */
function coerceFiniteNumber(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

/**
 * Derive UA quality from both source quality and the declared array contract.
 * Shape/type failures are quality events; they must never look like a valid
 * empty array or a plausible numeric zero to an operator.
 */
function statusCodeForSample(
  meta: UaVariableNode,
  sample: TagSample | undefined,
  StatusCodes: Record<string, unknown>,
): unknown {
  if (sample === undefined || sample.quality === "bad") {
    return StatusCodes.Bad;
  }
  if (meta.valueRank !== 1) return StatusCodes.Good;
  if (!Array.isArray(sample.value)) return StatusCodes.Bad;
  if (
    meta.dataType === UaDataType.Double &&
    sample.value.some((value) => Number.isNaN(coerceFiniteNumber(value)))
  ) {
    return StatusCodes.Bad;
  }
  return StatusCodes.Good;
}

export { buildAddressSpace, summarizePlan } from "./address-space";
export {
  securityProfileFromConfig,
  selectSecurityProfile,
  resolveCertificatePaths,
  OpcuaSecurityError,
} from "./security";
export { authenticateUser, createUserManager, verifyPassword } from "./user-auth";
export type { AuthUserRecord, UserLookup } from "./user-auth";
export * from "./types";
export {
  DEFAULT_OPCUA_ENDPOINT,
  DEFAULT_OPCUA_HOST,
  endpointUrl,
  isLoopbackHost,
  loadOpcuaServerConfig,
  loadOpcuaServerConfigFromEnv,
  OpcuaServerConfigError,
  OpcuaServerConfigSchema,
} from "./config";
export type { OpcuaServerConfig } from "./config";
export {
  isNodeOpcuaAvailable,
  loadNodeOpcua,
  NodeOpcuaUnavailableError,
} from "./node-opcua-api";
export type { NodeOpcuaApi, NodeOpcuaLoader } from "./node-opcua-api";
export { StorageTagDataSource } from "./storage-data-source";
// NOTE: `runtime.ts` (the opt-in production startup path) is intentionally NOT
// re-exported here — it imports this module, and re-exporting would create an
// import cycle. Import it directly: `./protocols/opcua-server/runtime`.
