/**
 * Modbus TCP Server Mode — public surface and startup path.
 *
 * Issue #462: standard Modbus masters can poll 0xSCADA.
 *
 * Mirrors OPC-UA Server Mode for the lower-end market: legacy HMIs and
 * integrators read/write 0xSCADA tags over standard Modbus TCP. This barrel
 * re-exports the building blocks, provides `createModbusServerForSite` (the
 * one-call factory that wires a register map to the live tag store), and owns
 * `startModbusServer`, the bootstrap `server/index.ts` calls at boot.
 *
 * SAFETY POSTURE. Modbus TCP has no authentication in the protocol — no
 * credential, no handshake, no integrity protection. There is no way to make it
 * safe on the wire, so the compensations live at the deployment boundary and
 * every one of them is off by default:
 *
 *   - the listener does not exist unless MODBUS_SERVER_ENABLED=true;
 *   - it binds 127.0.0.1 unless a routable MODBUS_SERVER_BIND_HOST is set;
 *   - a routable bind additionally requires a wildcard-free
 *     MODBUS_SERVER_ALLOWED_PEERS allowlist, enforced at accept time;
 *   - concurrent masters are capped;
 *   - write function codes return exception 0x01 unless
 *     MODBUS_SERVER_ALLOW_WRITES=true, and even then only register-map entries
 *     explicitly marked `writable` can mutate a live tag.
 *
 * Invalid configuration throws. It never degrades into a permissive listener.
 */

import { RegisterMap, type RegisterMapConfig } from "./register-map";
import {
  TagStoreDataModel,
  createTagStorePort,
  type TagStorePort,
} from "./tag-store-bridge";
import { ModbusTcpServer, type ModbusServerConfig } from "./server";
import {
  describeModbusServerConfig,
  isModbusServerEnabled,
  loadModbusServerConfig,
} from "./config";
import { isLoopbackHost } from "./peer-filter";
import { loadModbusRegisterMap } from "./register-map-store";
import { log, logWarn } from "../../logger";

export * from "./codec";
export * from "./data-model";
export * from "./register-map";
export * from "./handlers";
export * from "./tag-store-bridge";
export * from "./peer-filter";
export * from "./config";
export { loadModbusRegisterMap, RegisterMapLoadError } from "./register-map-store";
export { ModbusTcpServer, type ModbusServerConfig } from "./server";

const LOG_SCOPE = "modbus-server";

/**
 * Build a Modbus TCP server for a site: parse + index the register map, bind it
 * to the live tag store, and construct the listener. Call `.start()` to listen.
 *
 * Transport defaults are the safe ones (`server.ts`): loopback bind, loopback
 * peer allowlist, writes off.
 *
 * @param rawMap   Raw register-map config (validated with Zod) or a built map.
 * @param config   Transport overrides (host/port/peers/writes).
 */
export function createModbusServerForSite(
  rawMap: RegisterMapConfig | RegisterMap | unknown,
  config: ModbusServerConfig = {},
): ModbusTcpServer {
  const map =
    rawMap instanceof RegisterMap ? rawMap : RegisterMap.fromConfig(rawMap);
  const store = createTagStorePort(map.siteId);
  const model = new TagStoreDataModel(map, store);

  return new ModbusTcpServer(model, {
    ...config,
    unitId: config.unitId ?? map.unitId,
  });
}

/** Loader seam so the bootstrap can be tested without a database. */
export type RegisterMapLoader = (
  siteId: string,
  unitId: number,
) => Promise<RegisterMap>;

export interface StartModbusServerOptions {
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Register-map source. Defaults to the `modbus_register_map` table. */
  loadRegisterMap?: RegisterMapLoader;
  /** Tag backing store. Defaults to the live `tagCache` for the site. */
  tagStore?: TagStorePort;
}

/**
 * Start Modbus TCP Server Mode from validated configuration.
 *
 * Returns `null` — having done nothing at all — when the feature is not
 * explicitly enabled. That is the default for every deployment.
 *
 * @throws {ModbusServerConfigError} when enabled with configuration that cannot
 *   produce a safe listener.
 * @throws {RegisterMapLoadError} when the site's register map cannot be loaded.
 *   In both cases no socket is bound: the failure is terminal for the listener,
 *   never a fallback to permissive defaults.
 */
export async function startModbusServer(
  options: StartModbusServerOptions = {},
): Promise<ModbusTcpServer | null> {
  const env = options.env ?? process.env;

  if (!isModbusServerEnabled(env)) {
    return null;
  }

  const config = loadModbusServerConfig(env);
  const loadRegisterMap = options.loadRegisterMap ?? loadModbusRegisterMap;
  const map = await loadRegisterMap(config.siteId, config.unitId);

  if (config.allowWrites) {
    const writable = map.entries.filter((entry) => entry.writable);
    // Say plainly what an unauthenticated peer will be able to actuate.
    logWarn(
      `Modbus TCP Server Mode has WRITES ENABLED: ${writable.length} of ` +
        `${map.entries.length} mapped addresses are writable by any allowlisted ` +
        "peer. Modbus TCP does not authenticate clients — the peer allowlist and " +
        "network segmentation are the only controls in front of these tags.",
      LOG_SCOPE,
    );
  }
  if (!isLoopbackHost(config.host)) {
    logWarn(
      `Modbus TCP Server Mode is bound to the non-loopback address ` +
        `${config.host}. Peers are restricted to ` +
        `[${config.allowedPeers.join(", ")}], but the protocol itself provides ` +
        "no authentication; keep this listener on a segmented control network.",
      LOG_SCOPE,
    );
  }

  const store = options.tagStore ?? createTagStorePort(config.siteId);
  const server = new ModbusTcpServer(new TagStoreDataModel(map, store), {
    host: config.host,
    port: config.port,
    unitId: config.unitId,
    allowedPeers: config.allowedPeers,
    maxConnections: config.maxConnections,
    socketTimeoutMs: config.socketTimeoutMs,
    allowWrites: config.allowWrites,
  });

  await server.start();
  log(
    `Modbus TCP Server Mode started — ${describeModbusServerConfig(config)}, ` +
      `${map.entries.length} mapped addresses`,
    LOG_SCOPE,
  );
  return server;
}
