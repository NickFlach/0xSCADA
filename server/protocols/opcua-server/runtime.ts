/**
 * OPC-UA Server Mode — production startup path.
 *
 * This is the module that makes the OPC-UA server a *running subsystem* rather
 * than a library nothing constructs. `server/index.ts` calls
 * {@link startOpcuaServer} once the HTTP listener is up, mirroring how the
 * Sparkplug B bridge is started (`server/protocols/sparkplug-b`).
 *
 * GATING (#461): the subsystem is OFF unless `OPCUA_SERVER_ENABLED=true`. That
 * is the single documented flag. Every other setting is validated by the Zod
 * schema in `config.ts`, whose defaults are the closed ones (loopback bind,
 * Basic256Sha256, no anonymous). Anything invalid throws before a socket is
 * opened — there is no permissive fallback.
 *
 * DATA: sites and the tag catalogue are read from the real tables (`sites`,
 * `historian_data`); live values come from `tagStreamServer`, the stream the
 * gateway scan loop and the field simulator already publish to. Authentication
 * resolves against the existing `users` table — no parallel credential store.
 *
 * Part of #461.
 */

import { eq, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { logError, logInfo, logWarn } from "../../logger";
import { getDatabase, getDatabaseType } from "../../storage";
import { tagStreamServer } from "../../websocket/tag-stream";
import {
  loadOpcuaServerConfigFromEnv,
  type OpcuaServerConfig,
} from "./config";
import { OxScadaOpcuaServer } from "./index";
import { StorageTagDataSource } from "./storage-data-source";
import type { SourceSite, SourceTag } from "./types";
import type { AuthUserRecord, UserLookup } from "./user-auth";

/** The single flag that turns the subsystem on. */
export const OPCUA_SERVER_ENABLED_ENV = "OPCUA_SERVER_ENABLED";

let activeServer: OxScadaOpcuaServer | null = null;
let detachTagStream: (() => void) | null = null;

/** The running server instance, if OPC-UA Server Mode is up. */
export function getOpcuaServer(): OxScadaOpcuaServer | null {
  return activeServer;
}

/**
 * `server/storage.ts` intentionally exposes an untyped handle (it multiplexes a
 * Drizzle Postgres client and a reduced SQLite development stub). Bind it to the
 * schema-aware Drizzle type once, here, so every query below is fully typed.
 */
function typedDatabase(): NodePgDatabase<typeof schema> {
  return getDatabase() as NodePgDatabase<typeof schema>;
}

/** Load site folders from the `sites` table. */
export async function loadSitesFromStorage(): Promise<SourceSite[]> {
  const rows = await typedDatabase()
    .select({ id: schema.sites.id, name: schema.sites.name })
    .from(schema.sites);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/**
 * Load the tag catalogue.
 *
 * There is no dedicated tag table in `shared/schema.ts`; the tag id space is
 * defined by what the historian has recorded. One row per (tag, site) is
 * produced, and the UA data type is derived from whether the historian ever
 * stored a string for that tag (`string_value`) or only numerics (`value`).
 *
 * Tags are exposed read-only: 0xSCADA has no audited UA write path yet, so the
 * server must not advertise one. Read-only is the intended shipped behaviour,
 * not a placeholder — #461 asked for an address space, and that is what this
 * is. Writes are tracked separately in #667, because a UA client setting a tag
 * is a control action and needs scope authorisation and an audit record before
 * it can be offered at all.
 */
export async function loadTagCatalogueFromStorage(): Promise<SourceTag[]> {
  const rows = await typedDatabase()
    .select({
      tagId: schema.historianData.tagId,
      siteId: schema.historianData.siteId,
      hasStringValue: sql<boolean>`bool_or(${schema.historianData.stringValue} is not null)`,
    })
    .from(schema.historianData)
    .where(isNotNull(schema.historianData.siteId))
    .groupBy(schema.historianData.tagId, schema.historianData.siteId);

  const tags: SourceTag[] = [];
  for (const row of rows) {
    if (row.siteId === null) continue;
    tags.push({
      tagId: row.tagId,
      siteId: row.siteId,
      dataType: row.hasStringValue ? "string" : "number",
      writable: false,
    });
  }
  return tags;
}

/** Resolve a username against the existing `users` table. */
export const lookupUserFromStorage: UserLookup = async (
  username: string,
): Promise<AuthUserRecord | null> => {
  const rows = await typedDatabase()
    .select({
      id: schema.users.id,
      username: schema.users.username,
      passwordHash: schema.users.passwordHash,
      isActive: schema.users.isActive,
    })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    isActive: row.isActive,
  };
};

export interface StartOpcuaServerOptions {
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pre-validated configuration, bypassing the environment loader. */
  config?: OpcuaServerConfig;
}

/**
 * Start OPC-UA Server Mode if it is enabled.
 *
 * Returns `null` when the subsystem is disabled (the default). Throws when it is
 * enabled but cannot be started safely — an invalid configuration, a missing
 * `node-opcua`, or a backend that cannot serve the address space — so the caller
 * logs a clear failure instead of a permissive listener coming up.
 */
export async function startOpcuaServer(
  options: StartOpcuaServerOptions = {},
): Promise<OxScadaOpcuaServer | null> {
  if (activeServer) {
    logWarn("[opcua-server] startOpcuaServer() called while already running");
    return activeServer;
  }

  const config =
    options.config ?? loadOpcuaServerConfigFromEnv(options.env ?? process.env);

  if (!config.enabled) {
    logInfo(
      `[opcua-server] OPC-UA Server Mode disabled (set ${OPCUA_SERVER_ENABLED_ENV}=true to enable)`,
    );
    return null;
  }

  // The address space is projected from `sites` / `historian_data` and
  // authentication reads `users`. The SQLite development fallback in
  // `server/storage.ts` does not create those tables, so serving from it would
  // mean advertising an empty address space and refusing every login. Refuse
  // clearly instead of starting something that cannot work.
  const databaseType = getDatabaseType();
  if (databaseType !== "postgres") {
    throw new Error(
      `OPC-UA Server Mode requires the PostgreSQL backend (current backend: ${databaseType}). ` +
        "The SQLite development fallback does not provide the sites/users/historian_data tables. " +
        "Set DATABASE_URL, or leave OPCUA_SERVER_ENABLED unset.",
    );
  }

  const dataSource = new StorageTagDataSource({
    loadSites: loadSitesFromStorage,
    loadTagDefs: loadTagCatalogueFromStorage,
  });

  const server = new OxScadaOpcuaServer({
    config,
    dataSource,
    userLookup: lookupUserFromStorage,
  });

  await server.start();

  // Feed live values in only once the server is up, so no update is dropped into
  // a half-built address space.
  detachTagStream = tagStreamServer.onTagUpdate((update) => {
    dataSource.pushTagUpdate({
      tagName: update.tagName,
      value: update.value,
      quality: update.quality,
      timestamp: update.timestamp,
    });
  });

  activeServer = server;
  return server;
}

/** Stop OPC-UA Server Mode cleanly (no-op when it was never started). */
export async function stopOpcuaServer(): Promise<void> {
  if (detachTagStream) {
    detachTagStream();
    detachTagStream = null;
  }
  const server = activeServer;
  activeServer = null;
  if (!server) return;
  try {
    await server.stop();
  } catch (err) {
    logError(err, "[opcua-server] shutdown failed");
  }
}
