import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  MAX_REQUEST_BODY_BYTES,
  createGatewayProxy,
  parseServerUrl,
  type GatewayProxy,
} from "./proxy";

interface CapturedResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  chunks: Buffer[];
  body: string;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanup.push(async () => {
    server.closeAllConnections?.();
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  });
  return `http://127.0.0.1:${address.port}`;
}

async function startGateway(
  serverUrl: string,
  overrides: Parameters<typeof createGatewayProxy>[0] = { serverUrl },
): Promise<{ gateway: GatewayProxy; origin: string }> {
  const gateway = createGatewayProxy({ ...overrides, serverUrl });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("gateway did not bind");
  cleanup.push(() => gateway.close(0));
  return { gateway, origin: `http://127.0.0.1:${address.port}` };
}

async function request(
  origin: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string | string[]>;
    chunks?: Array<string | Buffer>;
  } = {},
): Promise<CapturedResponse> {
  const target = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const clientRequest = createServerRequest({
      hostname: target.hostname,
      port: target.port,
      method: options.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          chunks,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });
    clientRequest.once("error", reject);
    for (const chunk of options.chunks ?? []) clientRequest.write(chunk);
    clientRequest.end();
  });
}

// Keep the test helper visibly separate from createServer, which is used for
// upstream fixtures.
import { request as createServerRequest } from "node:http";

async function reserveUnusedOrigin(): Promise<string> {
  const server = createServer();
  const origin = await listen(server);
  server.close();
  await once(server, "close");
  cleanup.pop();
  return origin;
}

async function rawRequest(origin: string, requestText: string): Promise<string> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString());
    };
    socket.once("connect", () => socket.write(requestText));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", reject);
  });
}

describe("SERVER_URL validation", () => {
  it("accepts only a fixed credential-free HTTP(S) origin", () => {
    expect(parseServerUrl("https://server.internal:8443").origin)
      .toBe("https://server.internal:8443");
    for (const invalid of [
      "ftp://server.internal",
      "http://user:secret@server.internal",
      "http://server.internal/base",
      "http://server.internal?token=secret",
      "not a url",
    ]) {
      expect(() => parseServerUrl(invalid)).toThrow();
    }
  });

  it("declares a 10 MiB default upload cap", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("HTTP proxy", () => {
  it("keeps local liveness healthy while the upstream is unavailable", async () => {
    const upstream = await reserveUnusedOrigin();
    const { origin } = await startGateway(upstream, {
      serverUrl: upstream,
      timeouts: { connectMs: 100, readinessMs: 100 },
    });

    const health = await request(origin, "/health?probe=liveness");
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: "ok" });

    const readiness = await request(origin, "/readyz");
    expect(readiness.statusCode).toBe(503);
    expect(JSON.parse(readiness.body)).toEqual({ status: "not ready" });
  });

  it("does not let local probe routes bypass bounded-body handling", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_incoming, response) => {
      upstreamRequests += 1;
      response.end("unexpected");
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin, {
      serverUrl: upstreamOrigin,
      maxRequestBodyBytes: 8,
    });

    const declared = await request(origin, "/health", {
      method: "GET",
      headers: { "content-length": "9" },
      chunks: ["123456789"],
    });
    expect(declared.statusCode).toBe(413);

    const chunked = await request(origin, "/readyz", {
      method: "GET",
      chunks: ["body"],
    });
    expect(chunked.statusCode).toBe(400);
    expect(upstreamRequests).toBe(0);
  });

  it("streams requests and responses while preserving end-to-end headers", async () => {
    let captured:
      | { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
      | undefined;
    const upstream = createServer((incoming, response) => {
      if (incoming.url === "/api/healthz") {
        response.writeHead(200).end('{"status":"alive"}');
        return;
      }

      const body: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => body.push(chunk));
      incoming.once("end", () => {
        captured = {
          method: incoming.method,
          url: incoming.url,
          headers: incoming.headers,
          body: Buffer.concat(body).toString(),
        };
        response.statusCode = 201;
        response.setHeader("access-control-allow-origin", "https://operator.example");
        response.setHeader("set-cookie", ["session=one; HttpOnly", "theme=dark"]);
        response.setHeader("x-request-id", "request-123");
        response.setHeader("connection", "keep-alive, x-remove-response");
        response.setHeader("x-remove-response", "must-not-pass");
        response.write("first-");
        setTimeout(() => response.end("second"), 10);
      });
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin);

    const readiness = await request(origin, "/readyz");
    expect(readiness.statusCode).toBe(200);

    const result = await request(origin, "/api/tags?plant=line-1", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-secret",
        "x-api-key": "api-secret",
        cookie: "session=operator",
        origin: "https://operator.example",
        "x-request-id": "request-123",
        connection: "keep-alive, x-remove-request",
        "x-remove-request": "must-not-pass",
        "content-type": "text/plain",
      },
      chunks: ["payload"],
    });

    expect(captured).toMatchObject({
      method: "POST",
      url: "/api/tags?plant=line-1",
      body: "payload",
    });
    expect(captured?.headers.authorization).toBe("Bearer operator-secret");
    expect(captured?.headers["x-api-key"]).toBe("api-secret");
    expect(captured?.headers.cookie).toBe("session=operator");
    expect(captured?.headers.origin).toBe("https://operator.example");
    expect(captured?.headers["x-request-id"]).toBe("request-123");
    expect(captured?.headers["x-remove-request"]).toBeUndefined();

    expect(result.statusCode).toBe(201);
    expect(result.body).toBe("first-second");
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    expect(result.headers["set-cookie"]).toEqual([
      "session=one; HttpOnly",
      "theme=dark",
    ]);
    expect(result.headers["access-control-allow-origin"]).toBe("https://operator.example");
    expect(result.headers["x-request-id"]).toBe("request-123");
    expect(result.headers["x-remove-response"]).toBeUndefined();
  });

  it("rejects declared and chunked bodies over the configured cap", async () => {
    let completedUpstreamRequests = 0;
    const upstream = createServer((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        completedUpstreamRequests += 1;
        response.end("unexpected");
      });
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin, {
      serverUrl: upstreamOrigin,
      maxRequestBodyBytes: 8,
    });

    const declared = await request(origin, "/declared", {
      method: "POST",
      headers: { "content-length": "9" },
      chunks: ["123456789"],
    });
    expect(declared.statusCode).toBe(413);

    const chunked = await request(origin, "/chunked", {
      method: "POST",
      chunks: ["12345", "67890"],
    });
    expect(chunked.statusCode).toBe(413);
    expect(completedUpstreamRequests).toBe(0);
  });

  it("forwards an early upstream response without waiting for the upload", async () => {
    const upstream = createServer((_incoming, response) => {
      response.writeHead(401);
      response.end("denied");
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin, {
      serverUrl: upstreamOrigin,
      timeouts: { requestBodyMs: 250 },
    });
    const target = new URL(origin);

    const result = await new Promise<CapturedResponse>((resolve, reject) => {
      const clientRequest = createServerRequest({
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: "/early",
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          chunks,
          body: Buffer.concat(chunks).toString(),
        }));
      });
      clientRequest.once("error", reject);
      clientRequest.write("partial");
    });

    expect(result.statusCode).toBe(401);
    expect(result.body).toBe("denied");
    expect(result.headers.connection).toBe("close");
  });

  it("never reuses an upstream socket after an incomplete declared upload", async () => {
    const seenPaths: string[] = [];
    const upstream = createServer((incoming, response) => {
      seenPaths.push(incoming.url ?? "");
      if (incoming.url === "/early") {
        response.writeHead(401);
        response.end("denied");
        return;
      }
      incoming.resume();
      incoming.once("end", () => response.end("next-ok"));
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin, {
      serverUrl: upstreamOrigin,
      timeouts: { requestBodyMs: 250, responseHeadersMs: 250 },
    });
    const target = new URL(origin);

    const early = await new Promise<CapturedResponse>((resolve, reject) => {
      const clientRequest = createServerRequest({
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: "/early",
        headers: { "content-length": "100" },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          chunks,
          body: Buffer.concat(chunks).toString(),
        }));
      });
      clientRequest.once("error", reject);
      clientRequest.write("partial");
    });

    expect(early.statusCode).toBe(401);
    expect(early.headers.connection).toBe("close");

    const next = await request(origin, "/next");
    expect(next.statusCode).toBe(200);
    expect(next.body).toBe("next-ok");
    expect(seenPaths).toEqual(["/early", "/next"]);
  });

  it("bounds incomplete request bodies and closes the client connection", async () => {
    const upstream = createServer((incoming) => incoming.resume());
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin, {
      serverUrl: upstreamOrigin,
      timeouts: { requestBodyMs: 75 },
    });
    const target = new URL(origin);

    const result = await new Promise<CapturedResponse>((resolve, reject) => {
      const clientRequest = createServerRequest({
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: "/slow-upload",
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          chunks,
          body: Buffer.concat(chunks).toString(),
        }));
      });
      clientRequest.once("error", reject);
      clientRequest.write("partial");
    });

    expect(result.statusCode).toBe(504);
    expect(result.headers.connection).toBe("close");
  });

  it("returns generic 502 and 504 responses without exposing the target", async () => {
    const unavailable = await reserveUnusedOrigin();
    const disconnected = await startGateway(unavailable, {
      serverUrl: unavailable,
      timeouts: { connectMs: 100, responseHeadersMs: 200 },
    });
    const badGateway = await request(disconnected.origin, "/api/data");
    expect(badGateway.statusCode).toBe(502);
    expect(badGateway.body).toContain("Bad gateway");
    expect(badGateway.body).not.toContain(new URL(unavailable).host);

    const slowUpstream = createServer(() => {
      // Intentionally never send response headers.
    });
    const slowOrigin = await listen(slowUpstream);
    const slowGateway = await startGateway(slowOrigin, {
      serverUrl: slowOrigin,
      timeouts: { connectMs: 100, responseHeadersMs: 75 },
    });
    const timeout = await request(slowGateway.origin, "/api/slow");
    expect(timeout.statusCode).toBe(504);
    expect(timeout.body).toContain("Gateway timeout");
    expect(timeout.body).not.toContain(new URL(slowOrigin).host);
  });

  it("rejects absolute-form HTTP targets without contacting their origin", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_incoming, response) => {
      upstreamRequests += 1;
      response.end("unexpected");
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin);
    const target = new URL(origin);

    const raw = await rawRequest(
      origin,
      "GET http://attacker.example/private HTTP/1.1\r\n"
      + `Host: ${target.host}\r\n`
      + "Connection: close\r\n\r\n",
    );
    expect(raw).toContain("400 Bad Request");

    const unescaped = await rawRequest(
      origin,
      "GET /café HTTP/1.1\r\n"
      + `Host: ${target.host}\r\n`
      + "Connection: close\r\n\r\n",
    );
    expect(unescaped).toContain("400 Bad Request");
    expect((await request(origin, "/health")).statusCode).toBe(200);
    expect(upstreamRequests).toBe(0);
  });
});

describe("WebSocket proxy", () => {
  it.each(["/ws", "/ws/tags"])(
    "tunnels %s and preserves auth, origin, request IDs, and subprotocols",
    async (path) => {
      let capturedHeaders: IncomingHttpHeaders | undefined;
      let capturedUrl: string | undefined;
      const upstream = createServer();
      const websocketServer = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => protocols.has("scada.v1") ? "scada.v1" : false,
      });
      upstream.on("upgrade", (incoming, socket, head) => {
        capturedHeaders = incoming.headers;
        capturedUrl = incoming.url;
        websocketServer.handleUpgrade(incoming, socket, head, (websocket) => {
          websocketServer.emit("connection", websocket, incoming);
        });
      });
      websocketServer.on("connection", (websocket) => {
        websocket.send("connected");
        websocket.on("message", (message) => websocket.send(`echo:${message.toString()}`));
      });
      cleanup.push(async () => {
        for (const client of websocketServer.clients) client.terminate();
        websocketServer.close();
      });

      const upstreamOrigin = await listen(upstream);
      const { origin } = await startGateway(upstreamOrigin);
      const websocket = new WebSocket(
        `${origin.replace("http:", "ws:")}${path}?plant=line-1`,
        ["scada.v1", "fallback"],
        {
          headers: {
            authorization: "Bearer websocket-secret",
            "x-api-key": "websocket-api-key",
            cookie: "session=websocket",
            origin: "https://operator.example",
            "x-request-id": "websocket-request-123",
          },
        },
      );
      cleanup.push(async () => websocket.terminate());

      const welcomePromise = once(websocket, "message");
      await once(websocket, "open");
      expect(websocket.protocol).toBe("scada.v1");
      const [welcome] = await welcomePromise;
      expect(welcome.toString()).toBe("connected");
      const echoPromise = once(websocket, "message");
      websocket.send("ping");
      const [echo] = await echoPromise;
      expect(echo.toString()).toBe("echo:ping");

      expect(capturedUrl).toBe(`${path}?plant=line-1`);
      expect(capturedHeaders?.authorization).toBe("Bearer websocket-secret");
      expect(capturedHeaders?.["x-api-key"]).toBe("websocket-api-key");
      expect(capturedHeaders?.cookie).toBe("session=websocket");
      expect(capturedHeaders?.origin).toBe("https://operator.example");
      expect(capturedHeaders?.["x-request-id"]).toBe("websocket-request-123");
      expect(capturedHeaders?.["sec-websocket-protocol"]).toBe("scada.v1,fallback");
    },
  );

  it("rejects upgrades outside the two fixed WebSocket routes", async () => {
    let upstreamUpgrades = 0;
    const upstream = createServer();
    upstream.on("upgrade", () => {
      upstreamUpgrades += 1;
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin);
    const target = new URL(origin);
    const response = await rawRequest(
      origin,
      "GET /ws/admin HTTP/1.1\r\n"
      + `Host: ${target.host}\r\n`
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Version: 13\r\n"
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );

    expect(response).toContain("404 Not Found");
    expect(upstreamUpgrades).toBe(0);
  });

  it("closes a rejected upgrade whose upstream response aborts mid-body", async () => {
    const upstream = createServer();
    upstream.on("upgrade", (_incoming, socket) => {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n"
        + "Content-Length: 50\r\n"
        + "Content-Type: text/plain\r\n"
        + "Connection: close\r\n\r\n"
        + "hello",
      );
      setTimeout(() => socket.destroy(), 10);
    });
    const upstreamOrigin = await listen(upstream);
    const { origin } = await startGateway(upstreamOrigin);
    const target = new URL(origin);

    const response = await rawRequest(
      origin,
      "GET /ws HTTP/1.1\r\n"
      + `Host: ${target.host}\r\n`
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Version: 13\r\n"
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );

    expect(response).toContain("401 Unauthorized");
    expect(response).toContain("hello");
    expect(response.match(/HTTP\/1\.1/g)).toHaveLength(1);
  });
});
