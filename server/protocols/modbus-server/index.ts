/**
 * Modbus TCP Server Mode — public surface.
 *
 * Issue #462: standard Modbus masters can poll 0xSCADA.
 *
 * Mirrors OPC-UA Server Mode for the lower-end market: legacy HMIs and
 * integrators read/write 0xSCADA tags over standard Modbus TCP. This barrel
 * re-exports the building blocks and provides `createModbusServerForSite`, the
 * one-call factory that wires a per-site register map to the live tag store and
 * returns a ready-to-`start()` server.
 *
 * Wiring into `server/index.ts` (deferred — see TODO below) would look like:
 *
 *   if (process.env.MODBUS_SERVER_ENABLED === "true") {
 *     const map = await loadModbusRegisterMap(siteId); // from storage
 *     const server = createModbusServerForSite(map);
 *     await server.start();
 *   }
 */

import {
  RegisterMap,
  type RegisterMapConfig,
} from "./register-map";
import { TagStoreDataModel, createTagStorePort } from "./tag-store-bridge";
import {
  ModbusTcpServer,
  type ModbusServerConfig,
} from "./server";

export * from "./codec";
export * from "./data-model";
export * from "./register-map";
export * from "./handlers";
export * from "./tag-store-bridge";
export { ModbusTcpServer, type ModbusServerConfig } from "./server";

/**
 * Build a Modbus TCP server for a site: parse + index the register map, bind it
 * to the live tag store, and construct the listener. Call `.start()` to listen.
 *
 * @param rawMap   Raw register-map config (validated with Zod) or a built map.
 * @param config   Transport overrides (host/port). Port defaults to the env var
 *                 `MODBUS_SERVER_PORT` or 502.
 */
export function createModbusServerForSite(
  rawMap: RegisterMapConfig | RegisterMap | unknown,
  config: ModbusServerConfig = {},
): ModbusTcpServer {
  const map =
    rawMap instanceof RegisterMap ? rawMap : RegisterMap.fromConfig(rawMap);
  const store = createTagStorePort(map.siteId);
  const model = new TagStoreDataModel(map, store);

  const port =
    config.port ??
    (process.env.MODBUS_SERVER_PORT
      ? parseInt(process.env.MODBUS_SERVER_PORT, 10)
      : undefined);

  return new ModbusTcpServer(model, {
    ...config,
    port,
    unitId: config.unitId ?? map.unitId,
  });
}

// INTEGRATION (#462): Loading the persisted register map from storage and
// starting the server during server bootstrap is intentionally NOT wired here.
// It depends on (a) a storage accessor for the `modbusRegisterMap` table added
// to shared/schema.ts, and (b) a decision on which site(s) expose Modbus. Those
// belong in server/index.ts / server/storage.ts and are tracked as follow-up so
// this protocol module stays self-contained and unit-testable. See
// docs/protocols/modbus-server.md ("Server bootstrap / wiring") for the plan.
