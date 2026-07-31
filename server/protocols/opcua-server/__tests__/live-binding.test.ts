/**
 * LIVE binding test for OPC-UA Server Mode (#461).
 *
 * The maintainer's review of the first cut was that "the whole node-opcua
 * binding layer [is] unexercised". This test exercises it for real: it starts
 * {@link OxScadaOpcuaServer} on an ephemeral loopback port, drives a genuine
 * node-opcua client session against it (browse the site folder, read a tag
 * value, subscribe and receive a DataChangeNotification for a pushed update),
 * and then shuts everything down.
 *
 * It also proves the security fix end-to-end on the wire: a second server
 * instance built with the shipped `allowAnonymous: false` refuses an anonymous
 * session, accepts a valid username/password from the injected user store, and
 * refuses a bad password.
 *
 * Nothing here is mocked on the node-opcua side. If the package cannot be
 * loaded the whole suite is skipped with a printed reason rather than asserting
 * against a stand-in — see `isNodeOpcuaAvailable()`.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scryptSync } from "node:crypto";
import { loadOpcuaServerConfig } from "../config";
import { isNodeOpcuaAvailable } from "../node-opcua-api";
import { OxScadaOpcuaServer, type TagDataSource } from "../index";
import type { SourceSite, SourceTag, TagSample } from "../types";
import type { AuthUserRecord, UserLookup } from "../user-auth";

// ─── node-opcua client surface (loaded at runtime, like the server does) ─────

interface UaDataValue {
  value: { value: unknown };
  statusCode: { name: string };
}

interface UaMonitoredItem {
  on(event: "changed", handler: (dataValue: UaDataValue) => void): void;
}

interface UaSubscription {
  monitor(
    itemToMonitor: { nodeId: string; attributeId: number },
    parameters: {
      samplingInterval: number;
      discardOldest: boolean;
      queueSize: number;
    },
    timestampsToReturn: number,
  ): Promise<UaMonitoredItem>;
  terminate(): Promise<void>;
}

interface UaBrowseResult {
  references: { browseName: { name: string }; nodeId: { toString(): string } }[] | null;
}

interface UaSession {
  browse(nodeToBrowse: string): Promise<UaBrowseResult>;
  readVariableValue(nodeId: string): Promise<UaDataValue>;
  writeSingleNode(
    nodeId: string,
    value: { dataType: unknown; value: unknown },
  ): Promise<{ name: string }>;
  write(nodeToWrite: {
    nodeId: string;
    attributeId: number;
    indexRange: string;
    value: { value: { dataType: unknown; value: unknown } };
  }): Promise<{ name: string }>;
  createSubscription2(options: Record<string, unknown>): Promise<UaSubscription>;
  close(): Promise<void>;
}

interface UaClient {
  connect(endpointUrl: string): Promise<void>;
  createSession(userIdentity?: Record<string, unknown>): Promise<UaSession>;
  disconnect(): Promise<void>;
  getCertificate(): Buffer;
}

interface UaCertificateManagerLike {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  readonly privateKey: string;
}

interface UaClientApi {
  OPCUAClient: { create(options: Record<string, unknown>): UaClient };
  OPCUACertificateManager: new (options: {
    rootFolder: string;
    automaticallyAcceptUnknownCertificate: boolean;
  }) => UaCertificateManagerLike;
  AttributeIds: Record<string, number>;
  TimestampsToReturn: Record<string, number>;
  UserTokenType: Record<string, number>;
  DataType: Record<string, unknown>;
}

async function loadClientApi(): Promise<UaClientApi> {
  const specifier: string = "node-opcua";
  const loaded = (await import(/* @vite-ignore */ specifier)) as Record<
    string,
    unknown
  >;
  const namespace =
    typeof loaded.OPCUAClient === "function"
      ? loaded
      : (loaded.default as Record<string, unknown>);
  return namespace as unknown as UaClientApi;
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const SITE: SourceSite = { id: "SITE-01", name: "Refinery" };
const TAGS: SourceTag[] = [
  { tagId: "PT-101.PV", siteId: "SITE-01", dataType: "number", units: "bar" },
  { tagId: "RUN", siteId: "SITE-01", dataType: "boolean" },
  {
    tagId: "TEMPERATURES",
    siteId: "SITE-01",
    dataType: "array",
    elementDataType: "number",
  },
  {
    tagId: "SETPOINT",
    siteId: "SITE-01",
    dataType: "number",
    writable: true,
    direction: "input",
  },
];

/** In-memory {@link TagDataSource}: the 0xSCADA side is not what is under test. */
class InMemoryTagDataSource implements TagDataSource {
  private readonly latest = new Map<string, TagSample>();
  private readonly listeners = new Set<(sample: TagSample) => void>();
  readonly writes: { tagId: string; username: string; value: unknown }[] = [];

  async loadSites(): Promise<SourceSite[]> {
    return [SITE];
  }

  async loadTags(): Promise<SourceTag[]> {
    return TAGS;
  }

  async readTag(tagId: string): Promise<TagSample | undefined> {
    return this.latest.get(tagId);
  }

  subscribe(onChange: (sample: TagSample) => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  async writeTag(request: {
    tagId: string;
    username: string;
    value: unknown;
  }): Promise<void> {
    if (
      request.username !== OPERATOR.username &&
      request.username !== NAMED_ANONYMOUS.username
    ) {
      throw new Error("opcua.write scope denied");
    }
    this.writes.push(request);
  }

  push(sample: TagSample): void {
    this.latest.set(sample.tagId, sample);
    for (const listener of this.listeners) listener(sample);
  }
}

const SALT = "0011223344556677";
const PASSWORD = "hunter2-correct-horse";

function scryptHash(plaintext: string): string {
  const derived = scryptSync(plaintext, Buffer.from(SALT, "hex"), 32);
  return `scrypt$${SALT}$${derived.toString("hex")}`;
}

const OPERATOR: AuthUserRecord = {
  id: "user-1",
  username: "ua-operator",
  passwordHash: scryptHash(PASSWORD),
  isActive: true,
};

const NAMED_ANONYMOUS: AuthUserRecord = {
  ...OPERATOR,
  id: "user-2",
  username: "anonymous",
};

const userLookup: UserLookup = async (username) => {
  if (username === OPERATOR.username) return OPERATOR;
  if (username === NAMED_ANONYMOUS.username) return NAMED_ANONYMOUS;
  return null;
};

const nodeOpcuaAvailable = await isNodeOpcuaAvailable();
if (!nodeOpcuaAvailable) {
  // Truthful skip reason — never assert against a mock and call it verified.
  console.warn(
    "[#461] Skipping the OPC-UA live binding test: the `node-opcua` package could not be " +
      "loaded from this working tree. It is a declared dependency in package.json/package-lock.json, " +
      "so `npm ci` (as CI runs) makes this suite execute.",
  );
}

const TAG_NODE_ID_SUFFIX = "s=Tags/SITE-01/PT-101.PV";

function makeServer(
  dataSource: TagDataSource,
  pkiFolder: string,
  overrides: Record<string, unknown>,
): OxScadaOpcuaServer {
  return new OxScadaOpcuaServer({
    config: loadOpcuaServerConfig({
      enabled: true,
      env: "test",
      host: "127.0.0.1",
      port: 0,
      pkiFolder,
      disableCertificateFileWatchers: true,
      minSamplingIntervalMs: 10,
      ...overrides,
    }),
    dataSource,
    userLookup,
  });
}

describe.skipIf(!nodeOpcuaAvailable)(
  "OPC-UA server — live node-opcua binding",
  () => {
    let pkiFolder: string;
    let server: OxScadaOpcuaServer;
    let dataSource: InMemoryTagDataSource;
    let api: UaClientApi;

    beforeAll(async () => {
      api = await loadClientApi();
      pkiFolder = fs.mkdtempSync(path.join(os.tmpdir(), "oxscada-opcua-live-"));
      dataSource = new InMemoryTagDataSource();
      dataSource.push({
        tagId: "PT-101.PV",
        value: 12.5,
        dataType: "number",
        quality: "good",
        timestamp: new Date().toISOString(),
      });
      dataSource.push({
        tagId: "TEMPERATURES",
        value: [21.5, 22.25, 23],
        dataType: "array",
        quality: "good",
        timestamp: new Date().toISOString(),
      });
      // SecurityPolicy None + anonymous is permitted here only because the bind
      // is loopback and env is "test"; the config layer refuses both otherwise.
      server = makeServer(dataSource, pkiFolder, {
        securityPolicy: "None",
        allowAnonymous: true,
        trustUnknownClientCertificates: true,
      });
      await server.start();
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
      if (pkiFolder) fs.rmSync(pkiFolder, { recursive: true, force: true });
    }, 60_000);

    test("binds an ephemeral loopback port", () => {
      expect(server.isRunning).toBe(true);
      expect(server.boundPort).toBeGreaterThan(0);
      expect(server.endpoint).toBe(
        `opc.tcp://127.0.0.1:${server.boundPort}/0xscada`,
      );
    });

    test("a real client browses the address space, reads and subscribes", async () => {
      const client = api.OPCUAClient.create({
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 0 },
      });
      await client.connect(server.endpoint);
      const session = await client.createSession();

      try {
        const plan = server.addressSpacePlan;
        expect(plan).not.toBeNull();
        const namespaceIndex = plan!.namespaceIndex;
        const sitesRoot = `ns=${namespaceIndex};s=Sites`;
        const siteFolder = `ns=${namespaceIndex};s=Sites/SITE-01`;
        const tagNodeId = `ns=${namespaceIndex};${TAG_NODE_ID_SUFFIX}`;
        const arrayNodeId = `ns=${namespaceIndex};s=Tags/SITE-01/TEMPERATURES`;

        // 1. Browse: Objects -> Sites -> SITE-01 -> tag variables.
        const sites = await session.browse(sitesRoot);
        expect(
          (sites.references ?? []).map((ref) => ref.browseName.name),
        ).toContain("Refinery");

        const tags = await session.browse(siteFolder);
        const tagNames = (tags.references ?? []).map(
          (ref) => ref.browseName.name,
        );
        expect(tagNames).toEqual(expect.arrayContaining(["PT-101.PV", "RUN"]));

        // 2. Read the seeded value back through the UA read service.
        const read = await session.readVariableValue(tagNodeId);
        expect(read.statusCode.name).toBe("Good");
        expect(read.value.value).toBeCloseTo(12.5, 6);

        const arrayRead = await session.readVariableValue(arrayNodeId);
        expect(arrayRead.statusCode.name).toBe("Good");
        expect(Array.from(arrayRead.value.value as ArrayLike<number>)).toEqual([
          21.5,
          22.25,
          23,
        ]);

        dataSource.push({
          tagId: "TEMPERATURES",
          value: [21.5, "not-a-number", 23],
          dataType: "array",
          quality: "good",
          timestamp: new Date().toISOString(),
        });
        const invalidElementRead =
          await session.readVariableValue(arrayNodeId);
        expect(invalidElementRead.statusCode.name).toBe("Bad");
        expect(
          Number.isNaN(
            Array.from(
              invalidElementRead.value.value as ArrayLike<number>,
            )[1],
          ),
        ).toBe(true);

        dataSource.push({
          tagId: "TEMPERATURES",
          value: 21.5,
          dataType: "number",
          quality: "good",
          timestamp: new Date().toISOString(),
        });
        const wrongShapeRead = await session.readVariableValue(arrayNodeId);
        expect(wrongShapeRead.statusCode.name).toBe("Bad");

        const refused = await session.writeSingleNode(tagNodeId, {
          dataType: api.DataType.Double,
          value: 99,
        });
        expect(refused.name).toBe("BadNotWritable");

        // 3. Subscribe and receive a DataChangeNotification for a pushed update.
        const subscription = await session.createSubscription2({
          requestedPublishingInterval: 50,
          requestedLifetimeCount: 600,
          requestedMaxKeepAliveCount: 20,
          maxNotificationsPerPublish: 100,
          publishingEnabled: true,
          priority: 1,
        });

        const received: number[] = [];
        const monitored = await subscription.monitor(
          { nodeId: tagNodeId, attributeId: api.AttributeIds.Value },
          { samplingInterval: 20, discardOldest: true, queueSize: 10 },
          api.TimestampsToReturn.Both,
        );
        monitored.on("changed", (dataValue) => {
          if (typeof dataValue.value.value === "number") {
            received.push(dataValue.value.value);
          }
        });

        const updated = await new Promise<boolean>((resolve) => {
          const deadline = Date.now() + 20_000;
          const timer = setInterval(() => {
            if (received.includes(42.25)) {
              clearInterval(timer);
              resolve(true);
            } else if (Date.now() > deadline) {
              clearInterval(timer);
              resolve(false);
            } else {
              dataSource.push({
                tagId: "PT-101.PV",
                value: 42.25,
                dataType: "number",
                quality: "good",
                timestamp: new Date().toISOString(),
              });
            }
          }, 100);
        });

        expect(received.length).toBeGreaterThan(0);
        expect(updated).toBe(true);

        await subscription.terminate();
      } finally {
        await session.close();
        await client.disconnect();
      }
    }, 120_000);
  },
);

describe.skipIf(!nodeOpcuaAvailable)(
  "OPC-UA server — authentication against the existing user store",
  () => {
    let pkiFolder: string;
    let server: OxScadaOpcuaServer;
    let api: UaClientApi;
    let dataSource: InMemoryTagDataSource;

    beforeAll(async () => {
      api = await loadClientApi();
      pkiFolder = fs.mkdtempSync(path.join(os.tmpdir(), "oxscada-opcua-auth-"));
      // The shipped default: anonymous access OFF.
      dataSource = new InMemoryTagDataSource();
      server = makeServer(dataSource, pkiFolder, {
        securityPolicy: "None",
        allowAnonymous: false,
        trustUnknownClientCertificates: true,
      });
      await server.start();
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
      if (pkiFolder) fs.rmSync(pkiFolder, { recursive: true, force: true });
    }, 60_000);

    async function withClient<T>(
      run: (client: UaClient) => Promise<T>,
    ): Promise<T> {
      const client = api.OPCUAClient.create({
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 0 },
      });
      await client.connect(server.endpoint);
      try {
        return await run(client);
      } finally {
        await client.disconnect();
      }
    }

    test("does not even advertise an anonymous token policy", async () => {
      // The rejection has to come from the missing Anonymous user-token policy,
      // not from an unrelated connection failure — assert on the reason.
      await expect(
        withClient((client) => client.createSession()),
      ).rejects.toThrow(/ANONYMOUS user token policy/i);
    }, 60_000);

    test("accepts a valid username/password from the user store", async () => {
      const closed = await withClient(async (client) => {
        const session = await client.createSession({
          type: api.UserTokenType.UserName,
          userName: OPERATOR.username,
          password: PASSWORD,
        });
        await session.close();
        return true;
      });
      expect(closed).toBe(true);
    }, 60_000);

    test("accepts an explicitly enabled input write and attributes it", async () => {
      await withClient(async (client) => {
        const session = await client.createSession({
          type: api.UserTokenType.UserName,
          userName: OPERATOR.username,
          password: PASSWORD,
        });
        try {
          const ns = server.addressSpacePlan!.namespaceIndex;
          const status = await session.writeSingleNode(
            `ns=${ns};s=Tags/SITE-01/SETPOINT`,
            { dataType: api.DataType.Double, value: 33.5 },
          );
          expect(status.name).toBe("Good");
        } finally {
          await session.close();
        }
      });
      expect(dataSource.writes).toContainEqual(expect.objectContaining({
        tagId: "SETPOINT",
        username: OPERATOR.username,
        value: 33.5,
      }));
    }, 60_000);

    test("rejects IndexRange writes without mutating the whole value", async () => {
      const before = dataSource.writes.length;
      await withClient(async (client) => {
        const session = await client.createSession({
          type: api.UserTokenType.UserName,
          userName: OPERATOR.username,
          password: PASSWORD,
        });
        try {
          const ns = server.addressSpacePlan!.namespaceIndex;
          const status = await session.write({
            nodeId: `ns=${ns};s=Tags/SITE-01/SETPOINT`,
            attributeId: api.AttributeIds.Value,
            indexRange: "0",
            value: {
              value: { dataType: api.DataType.Double, value: 44 },
            },
          });
          expect(status.name).toBe("BadIndexRangeInvalid");
        } finally {
          await session.close();
        }
      });
      expect(dataSource.writes).toHaveLength(before);
    }, 60_000);

    test("authorizes by token type, not the literal username", async () => {
      await withClient(async (client) => {
        const session = await client.createSession({
          type: api.UserTokenType.UserName,
          userName: NAMED_ANONYMOUS.username,
          password: PASSWORD,
        });
        try {
          const ns = server.addressSpacePlan!.namespaceIndex;
          const status = await session.writeSingleNode(
            `ns=${ns};s=Tags/SITE-01/SETPOINT`,
            { dataType: api.DataType.Double, value: 34.5 },
          );
          expect(status.name).toBe("Good");
        } finally {
          await session.close();
        }
      });
      expect(dataSource.writes).toContainEqual(
        expect.objectContaining({ username: NAMED_ANONYMOUS.username }),
      );
    }, 60_000);

    test("refuses a bad password", async () => {
      await expect(
        withClient((client) =>
          client.createSession({
            type: api.UserTokenType.UserName,
            userName: OPERATOR.username,
            password: "not-the-password",
          }),
        ),
      ).rejects.toThrow(/BadUserAccessDenied/);
    }, 60_000);

    test("refuses a self-signed X509 identity token", async () => {
      // node-opcua advertises a Certificate user-token policy alongside
      // UserName, and falls back to a process-wide default user-PKI manager
      // built with `automaticallyAcceptUnknownCertificate: true` when the server
      // does not supply one. That would let any client mint a throwaway
      // certificate and obtain a session without ever touching the `users`
      // table — anonymous access under a different token type. The server must
      // supply its own user certificate manager and reject the token.
      const clientPki = fs.mkdtempSync(
        path.join(os.tmpdir(), "oxscada-opcua-userpki-"),
      );
      const clientCerts = new api.OPCUACertificateManager({
        rootFolder: clientPki,
        automaticallyAcceptUnknownCertificate: true,
      });
      await clientCerts.initialize();
      const client = api.OPCUAClient.create({
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 0 },
        clientCertificateManager: clientCerts,
      });
      await client.connect(server.endpoint);
      try {
        await expect(
          client.createSession({
            type: api.UserTokenType.Certificate,
            certificateData: client.getCertificate(),
            privateKey: fs.readFileSync(clientCerts.privateKey, "utf8"),
          }),
        ).rejects.toThrow(/BadIdentityTokenRejected/);
      } finally {
        await client.disconnect();
        await clientCerts.dispose();
        fs.rmSync(clientPki, { recursive: true, force: true });
      }
    }, 60_000);

    test("refuses an unknown user", async () => {
      await expect(
        withClient((client) =>
          client.createSession({
            type: api.UserTokenType.UserName,
            userName: "nobody",
            password: PASSWORD,
          }),
        ),
      ).rejects.toThrow(/BadUserAccessDenied/);
    }, 60_000);
  },
);
