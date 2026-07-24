import { createServer, type Server } from "http";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiKeyRecord } from "../../middleware/api-gateway";
import { TagStreamServer } from "../tag-stream";
import { UnifiedStreamServer } from "../unified-stream";
import {
  OXSCADA_WEBSOCKET_AUTH_PREFIX,
  OXSCADA_WEBSOCKET_PROTOCOL,
  type WebSocketAuthOptions,
} from "../upgrade-auth";

type StreamServer = TagStreamServer | UnifiedStreamServer;

const apiKeys = new Map<string, ApiKeyRecord>([
  [
    "read-key",
    {
      key: "read-key",
      name: "dashboard",
      scopes: ["read", "stream.read"],
      createdAt: new Date(),
    },
  ],
  [
    "write-only-key",
    {
      key: "write-only-key",
      name: "writer",
      scopes: ["write"],
      createdAt: new Date(),
    },
  ],
]);
const auth: WebSocketAuthOptions = { required: true, apiKeys };
const openServers: Array<{ http: Server; stream: StreamServer }> = [];
const openClients: WebSocket[] = [];

function credentialProtocol(key: string): string {
  return `${OXSCADA_WEBSOCKET_AUTH_PREFIX}${Buffer.from(key).toString("base64url")}`;
}
async function start(
  kind: "tags" | "unified",
): Promise<{ url: string; stream: StreamServer }> {
  const http = createServer();
  const stream = kind === "tags" ? new TagStreamServer() : new UnifiedStreamServer();
  const path = kind === "tags" ? "/ws/tags" : "/ws";
  stream.initialize(http, path, auth);
  openServers.push({ http, stream });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return { url: `ws://127.0.0.1:${address.port}${path}`, stream };
}

async function rejectedStatus(url: string, protocols?: string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const client = new WebSocket(url, protocols);
    client.once("open", () => reject(new Error("WebSocket unexpectedly opened")));
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.once("error", () => {
      // `unexpected-response` is the assertion channel for rejected upgrades.
    });
  });
}

async function connect(url: string, key: string): Promise<WebSocket> {
  const client = new WebSocket(url, [
    OXSCADA_WEBSOCKET_PROTOCOL,
    credentialProtocol(key),
  ]);
  openClients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return client;
}

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  await Promise.all(openServers.splice(0).map(async ({ http, stream }) => {
    stream.destroy();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }));
});

for (const kind of ["tags", "unified"] as const) {
  describe(`${kind} WebSocket HTTP upgrade authentication`, () => {
    it("rejects a missing credential", async () => {
      const { url } = await start(kind);
      expect(await rejectedStatus(url)).toBe(401);
    });

    it("rejects credentials in a query string", async () => {
      const { url } = await start(kind);
      expect(await rejectedStatus(`${url}?api_key=read-key`)).toBe(400);
      expect(await rejectedStatus(`${url}?ACCESS-TOKEN=read-key`)).toBe(400);
    });

    it("rejects a key without a streaming read scope", async () => {
      const { url } = await start(kind);
      expect(await rejectedStatus(url, [
        OXSCADA_WEBSOCKET_PROTOCOL,
        credentialProtocol("write-only-key"),
      ])).toBe(403);
    });

    it("accepts a scoped key and negotiates only the stable protocol", async () => {
      const { url } = await start(kind);
      const client = await connect(url, "read-key");
      expect(client.protocol).toBe(OXSCADA_WEBSOCKET_PROTOCOL);
    });
  });
}
