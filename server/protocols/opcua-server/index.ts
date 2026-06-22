/**
 * OPC-UA Server Mode — Server Lifecycle
 *
 * Exposes 0xSCADA tags as a standard UA address space so external SCADA
 * systems / historians can browse and subscribe. Wires the `node-opcua`
 * runtime around the pure modules in this folder:
 *
 *   - `address-space.ts` : sites/tags -> UA folder/variable plan (pure)
 *   - `security.ts`      : SecurityPolicy selection + cert helper
 *   - `user-auth.ts`     : UA UserName token -> existing user store
 *   - `config.ts`        : Zod-validated configuration
 *
 * SCAFFOLD-CORE STATUS (#461): the pure mapping/security/auth/config logic is
 * implemented FULLY and unit-tested. The `node-opcua` wiring below is real but
 * cannot be exercised in this worktree (the dependency + `npm install` are
 * unavailable per the task constraints). Points that need a live run or cert
 * material are marked `TODO(#461)`. Conformance via opcua-asyncio is documented
 * in `docs/protocols/opcua-server.md` (cannot run here).
 *
 * NOTE on typing: `node-opcua` is loaded via a dynamic import and handled
 * through a narrow `NodeOpcuaModule` boundary. Its rich runtime objects
 * (OPCUAServer / AddressSpace / Variant) are intentionally typed loosely at
 * that single seam — the same pragmatic convention used by the existing vendor
 * adapters in `server/adapters/` — so this server-wiring layer stays decoupled
 * from node-opcua's internal type surface. All 0xSCADA-side logic is strict.
 *
 * @module server/protocols/opcua-server
 */

import { logError, logInfo, logWarn } from "../../logger";
import {
  buildAddressSpace,
  summarizePlan,
  type BuildAddressSpaceOptions,
} from "./address-space";
import {
  endpointUrl,
  loadOpcuaServerConfig,
  type OpcuaServerConfig,
} from "./config";
import { ensureServerCertificate, selectSecurityProfile } from "./security";
import { createUserManager, type UserLookup } from "./user-auth";
import type {
  AddressSpacePlan,
  SourceSite,
  SourceTag,
  TagSample,
  UaVariableNode,
} from "./types";
import { UaDataType } from "./types";

/**
 * Loosely-typed handle to the `node-opcua` module. Kept to a single boundary
 * type so the rest of the file can reference it without scattering casts.
 * INTEGRATION(node-opcua): replace with `typeof import("node-opcua")` once the
 * dependency's types are part of the build if tighter typing is desired.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeOpcuaModule = any;

/**
 * Data source the server reads from. Implementations live behind
 * `server/storage.ts`; we accept an interface so the server is testable and
 * decoupled from the Drizzle layer.
 */
export interface TagDataSource {
  /** Load the sites + tags that define the address space. */
  loadSites(): Promise<SourceSite[]>;
  loadTags(): Promise<SourceTag[]>;
  /** Latest known value for a tag (used to seed variable nodes). */
  readTag(tagId: string): Promise<TagSample | undefined>;
  /**
   * Subscribe to tag value changes. Invokes `onChange` for every update and
   * returns an unsubscribe function. This is what drives UA
   * DataChangeNotifications.
   */
  subscribe(onChange: (sample: TagSample) => void): () => void;
}

export interface OpcuaServerDeps {
  config: OpcuaServerConfig;
  dataSource: TagDataSource;
  /** Resolves usernames against the user store for UserName token auth. */
  userLookup: UserLookup;
  addressSpaceOptions?: BuildAddressSpaceOptions;
}

/**
 * The 0xSCADA OPC-UA server. `node-opcua` is loaded lazily in `start()` so this
 * module can be imported (and the surrounding logic reasoned about / tested)
 * without the optional dependency installed.
 */
export class OxScadaOpcuaServer {
  private readonly config: OpcuaServerConfig;
  private readonly dataSource: TagDataSource;
  private readonly userLookup: UserLookup;
  private readonly addressSpaceOptions?: BuildAddressSpaceOptions;

  private plan: AddressSpacePlan | null = null;
  /** node-opcua OPCUAServer instance (loose-typed at the dependency boundary). */
  private server: NodeOpcuaModule = null;
  /** Map of variable NodeId -> node-opcua UAVariable for value updates. */
  private readonly uaVariables = new Map<string, NodeOpcuaModule>();
  private unsubscribe: (() => void) | null = null;
  private running = false;

  constructor(deps: OpcuaServerDeps) {
    this.config = deps.config;
    this.dataSource = deps.dataSource;
    this.userLookup = deps.userLookup;
    this.addressSpaceOptions = deps.addressSpaceOptions;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Build (or rebuild) the in-memory address-space plan from the data source. */
  async buildPlan(): Promise<AddressSpacePlan> {
    const [sites, tags] = await Promise.all([
      this.dataSource.loadSites(),
      this.dataSource.loadTags(),
    ]);
    this.plan = buildAddressSpace(sites, tags, {
      namespaceUri: this.config.applicationUri,
      ...this.addressSpaceOptions,
    });
    const summary = summarizePlan(this.plan);
    logInfo(
      `[opcua-server] address space: ${summary.siteFolders} site folder(s), ${summary.variables} variable(s)`,
    );
    return this.plan;
  }

  /**
   * Start the UA server: build the plan, generate cert material if a secure
   * policy is in play, instantiate node-opcua, populate the address space, and
   * wire subscriptions.
   */
  async start(): Promise<void> {
    if (this.running) {
      logWarn("[opcua-server] start() called while already running");
      return;
    }

    const profile = selectSecurityProfile(this.config.env);
    await this.buildPlan();

    // INTEGRATION(node-opcua): dynamic import so this file imports cleanly even
    // when the optional dependency is absent (worktree / pure-test scenarios).
    let nodeOpcua: NodeOpcuaModule;
    try {
      nodeOpcua = await import("node-opcua");
    } catch (err) {
      logError(err, "[opcua-server] node-opcua not installed; cannot start");
      throw new Error(
        "node-opcua is not installed. Run `npm install` to enable OPC-UA Server Mode.",
      );
    }

    const needsCert = profile.endpoints.some((e) => e.securityPolicy !== "None");
    let certificateFile: string | undefined;
    let privateKeyFile: string | undefined;
    if (needsCert) {
      // TODO(#461): in production, point this at CA-issued material instead of
      // a generated self-signed cert, and manage the trusted/rejected lists.
      const certPaths = await ensureServerCertificate({
        rootFolder: this.config.pkiFolder,
        applicationUri: this.config.applicationUri,
        dns: [this.config.host === "0.0.0.0" ? "localhost" : this.config.host],
      });
      certificateFile = certPaths.certificateFile;
      privateKeyFile = certPaths.privateKeyFile;
    }

    const { OPCUAServer, SecurityPolicy, MessageSecurityMode } = nodeOpcua;
    const userManager = createUserManager(this.userLookup);

    const server = new OPCUAServer({
      port: this.config.port,
      resourcePath: this.config.resourcePath,
      serverInfo: { applicationUri: this.config.applicationUri },
      buildInfo: { productName: this.config.serverName },
      maxConnectionsPerEndpoint: this.config.maxSessions,
      // Map our pure policy names onto node-opcua enums.
      securityPolicies: profile.endpoints.map(
        (e: { securityPolicy: string }) => SecurityPolicy[e.securityPolicy],
      ),
      securityModes: profile.endpoints.map(
        (e: { securityMode: string }) => MessageSecurityMode[e.securityMode],
      ),
      allowAnonymous: profile.allowAnonymous,
      certificateFile,
      privateKeyFile,
      userManager: {
        isValidUserAsync: userManager.isValidUserAsync,
      },
    });

    await server.initialize();
    this.populateAddressSpace(server, nodeOpcua);
    this.wireSubscriptions(nodeOpcua);
    await server.start();

    this.server = server;
    this.running = true;
    logInfo(`[opcua-server] listening at ${endpointUrl(this.config)}`);
  }

  /** Stop the server and release subscriptions. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.server && typeof this.server.shutdown === "function") {
      await new Promise<void>((resolve) =>
        this.server.shutdown(() => resolve()),
      );
    }
    this.server = null;
    this.uaVariables.clear();
    logInfo("[opcua-server] stopped");
  }

  /**
   * Instantiate node-opcua folder + variable nodes from the plan. Each variable
   * gets a refresh getter that pulls the latest value from the data source, so
   * reads and subscription sampling both see live values.
   */
  private populateAddressSpace(
    server: NodeOpcuaModule,
    nodeOpcua: NodeOpcuaModule,
  ): void {
    if (!this.plan) throw new Error("address-space plan not built");
    const { DataType, DataValue, StatusCodes, Variant } = nodeOpcua;

    const addressSpace = server.engine.addressSpace;
    const namespace = addressSpace.registerNamespace(this.plan.namespaceUri);
    const objectsFolder = addressSpace.rootFolder.objects;

    // Folders: one root "Sites" folder then one folder per site.
    const folderByNodeId = new Map<string, NodeOpcuaModule>();
    for (const folder of this.plan.folders) {
      const parent = folderByNodeId.get(folder.parentNodeId) ?? objectsFolder;
      const node = namespace.addFolder(parent, {
        browseName: folder.browseName,
        nodeId: folder.nodeId,
      });
      folderByNodeId.set(folder.nodeId, node);
    }

    // Variables (one per tag).
    for (const variable of this.plan.variables) {
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
        dataType: uaTypeToNodeOpcuaDataType(variable.dataType, DataType),
        minimumSamplingInterval: this.config.minSamplingIntervalMs,
        value: {
          // Async getter: pull the latest sample on each read/sample.
          refreshFunc: (
            callback: (err: Error | null, dv?: NodeOpcuaModule) => void,
          ) => {
            this.dataSource
              .readTag(variable.tagId)
              .then((sample) => {
                callback(
                  null,
                  new DataValue({
                    value: toVariant(variable, sample, Variant, DataType),
                    statusCode:
                      sample?.quality === "bad"
                        ? StatusCodes.Bad
                        : StatusCodes.Good,
                    sourceTimestamp: sample
                      ? new Date(sample.timestamp as string)
                      : new Date(),
                  }),
                );
              })
              .catch((err) => callback(err as Error));
          },
        },
      });
      this.uaVariables.set(variable.nodeId, uaVar);
    }
  }

  /**
   * Wire the data-source subscription so tag updates push new values into the
   * matching UA variable, which node-opcua turns into DataChangeNotifications
   * for any subscribed client. Satisfies the subscription acceptance criterion.
   */
  private wireSubscriptions(nodeOpcua: NodeOpcuaModule): void {
    if (!this.plan) return;
    const { StatusCodes, Variant, DataType } = nodeOpcua;
    const tagIndex = this.plan.tagIndex;
    const variablesByTag = new Map<string, UaVariableNode>();
    for (const v of this.plan.variables) variablesByTag.set(v.tagId, v);

    this.unsubscribe = this.dataSource.subscribe((sample) => {
      const nodeId = tagIndex.get(sample.tagId);
      if (!nodeId) return;
      const uaVar = this.uaVariables.get(nodeId);
      const meta = variablesByTag.get(sample.tagId);
      if (!uaVar || !meta) return;
      uaVar.setValueFromSource(
        toVariant(meta, sample, Variant, DataType),
        sample.quality === "bad" ? StatusCodes.Bad : StatusCodes.Good,
      );
    });
  }
}

/** Convenience factory: validate raw config and build a server instance. */
export function createOpcuaServer(deps: {
  config?: unknown;
  dataSource: TagDataSource;
  userLookup: UserLookup;
  addressSpaceOptions?: BuildAddressSpaceOptions;
}): OxScadaOpcuaServer {
  return new OxScadaOpcuaServer({
    config: loadOpcuaServerConfig(deps.config),
    dataSource: deps.dataSource,
    userLookup: deps.userLookup,
    addressSpaceOptions: deps.addressSpaceOptions,
  });
}

// ─── node-opcua interop helpers ──────────────────────────────────────────────

/** Map our UaDataType enum to the node-opcua `DataType` enum member. */
function uaTypeToNodeOpcuaDataType(
  t: UaDataType,
  DataType: Record<string, unknown>,
): unknown {
  switch (t) {
    case UaDataType.Boolean:
      return DataType.Boolean;
    case UaDataType.Double:
      return DataType.Double;
    case UaDataType.String:
      return DataType.String;
    default:
      // BaseDataType / unrefined -> expose as String (JSON) in this scaffold.
      // TODO(#461): synthesise proper UA structured types for object/array.
      return DataType.String;
  }
}

/**
 * Build a node-opcua Variant for a sample, coercing to the node's UA type.
 * `Variant` / `DataType` are the node-opcua constructors/enums (loose-typed at
 * the dependency boundary).
 */
function toVariant(
  meta: UaVariableNode,
  sample: TagSample | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Variant: new (opts: any) => unknown,
  DataType: Record<string, unknown>,
): unknown {
  const raw = sample?.value;
  switch (meta.dataType) {
    case UaDataType.Boolean:
      return new Variant({ dataType: DataType.Boolean, value: Boolean(raw) });
    case UaDataType.Double:
      return new Variant({
        dataType: DataType.Double,
        value: typeof raw === "number" ? raw : Number(raw ?? 0),
      });
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

export { buildAddressSpace, summarizePlan } from "./address-space";
export { selectSecurityProfile, ensureServerCertificate } from "./security";
export { authenticateUser, verifyPassword } from "./user-auth";
export * from "./types";
export { loadOpcuaServerConfig, endpointUrl } from "./config";
