import {
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from "node:http";
import {
  Agent as HttpsAgent,
  request as httpsRequest,
} from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const WEBSOCKET_PATHS = new Set(["/ws", "/ws/tags"]);

export interface GatewayTimeouts {
  connectMs?: number;
  responseHeadersMs?: number;
  requestBodyMs?: number;
  upstreamIdleMs?: number;
  readinessMs?: number;
}

export interface GatewayProxyOptions {
  serverUrl: string | URL;
  maxRequestBodyBytes?: number;
  timeouts?: GatewayTimeouts;
}

interface ResolvedTimeouts {
  connectMs: number;
  responseHeadersMs: number;
  requestBodyMs: number;
  upstreamIdleMs: number;
  readinessMs: number;
}

interface ParsedRequestTarget {
  path: string;
  pathname: string;
}

interface Deadline {
  start(): void;
  clear(): void;
}

type UpstreamRequest = ReturnType<typeof httpRequest>;

export interface GatewayProxy {
  readonly server: Server;
  readonly targetOrigin: string;
  close(graceMs?: number): Promise<void>;
}

class ProxyTimeoutError extends Error {}
class BodyLimitError extends Error {}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function resolveTimeouts(timeouts: GatewayTimeouts = {}): ResolvedTimeouts {
  return {
    connectMs: positiveInteger(timeouts.connectMs, DEFAULT_CONNECT_TIMEOUT_MS, "connect timeout"),
    responseHeadersMs: positiveInteger(
      timeouts.responseHeadersMs,
      DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS,
      "response headers timeout",
    ),
    requestBodyMs: positiveInteger(
      timeouts.requestBodyMs,
      DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      "request body timeout",
    ),
    upstreamIdleMs: positiveInteger(
      timeouts.upstreamIdleMs,
      DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
      "upstream idle timeout",
    ),
    readinessMs: positiveInteger(
      timeouts.readinessMs,
      DEFAULT_READINESS_TIMEOUT_MS,
      "readiness timeout",
    ),
  };
}

/**
 * Resolve the one configured upstream. Incoming requests can never replace this
 * origin: absolute-form and authority-form request targets are rejected below.
 */
export function parseServerUrl(value: string | URL): URL {
  let target: URL;
  try {
    target = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error("SERVER_URL must be a valid URL");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("SERVER_URL must use http or https");
  }
  if (!target.hostname) {
    throw new Error("SERVER_URL must include a host");
  }
  if (target.username || target.password) {
    throw new Error("SERVER_URL must not contain credentials");
  }
  if (target.search || target.hash) {
    throw new Error("SERVER_URL must not contain a query or fragment");
  }
  if (target.pathname !== "/" && target.pathname !== "") {
    throw new Error("SERVER_URL must be an origin without a path");
  }

  target.pathname = "/";
  return target;
}

function parseRequestTarget(rawUrl: string | undefined): ParsedRequestTarget | null {
  if (
    !rawUrl
    || !rawUrl.startsWith("/")
    || rawUrl.startsWith("//")
    || rawUrl.includes("\r")
    || rawUrl.includes("\n")
  ) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl, "http://gateway.invalid");
    if (parsed.origin !== "http://gateway.invalid") return null;
    return { path: rawUrl, pathname: parsed.pathname };
  } catch {
    return null;
  }
}

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const tokens = new Set<string>();
  const values = headers.connection;
  const rawValues = Array.isArray(values) ? values : values ? [values] : [];
  for (const value of rawValues) {
    for (const token of value.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) tokens.add(normalized);
    }
  }
  return tokens;
}

function filterHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const nominatedHeaders = connectionTokens(headers);
  const filtered: OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined
      || HOP_BY_HOP_HEADERS.has(normalized)
      || nominatedHeaders.has(normalized)
    ) {
      continue;
    }
    filtered[name] = value;
  }

  return filtered;
}

function filterRawHeaders(rawHeaders: string[]): string[] {
  const headers: IncomingHttpHeaders = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    const value = rawHeaders[index + 1];
    if (!name || value === undefined) continue;
    const current = headers[name];
    if (current === undefined) {
      headers[name] = value;
    } else if (Array.isArray(current)) {
      current.push(value);
    } else {
      headers[name] = [current, value];
    }
  }

  const nominatedHeaders = connectionTokens(headers);
  const filtered: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!name || value === undefined) continue;
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || nominatedHeaders.has(normalized)) continue;
    filtered.push(name, value);
  }
  return filtered;
}

function parseContentLength(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw new Error("invalid content length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid content length");
  return parsed;
}

function rejectLocalEndpointBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxRequestBodyBytes: number,
): boolean {
  let declaredLength: number | null;
  try {
    declaredLength = parseContentLength(request.headers["content-length"]);
  } catch {
    request.resume();
    sendJson(response, 400, { error: "Invalid request" }, request.method === "HEAD", true);
    return true;
  }

  if (declaredLength !== null && declaredLength > maxRequestBodyBytes) {
    request.resume();
    sendJson(
      response,
      413,
      { error: "Request body too large" },
      request.method === "HEAD",
      true,
    );
    return true;
  }

  if (
    (declaredLength !== null && declaredLength > 0)
    || request.headers["transfer-encoding"] !== undefined
  ) {
    request.resume();
    sendJson(
      response,
      400,
      { error: "Request body not allowed" },
      request.method === "HEAD",
      true,
    );
    return true;
  }

  return false;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, string>,
  headOnly = false,
  closeConnection = false,
): void {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    ...(closeConnection ? { connection: "close" } : {}),
    "content-length": body.byteLength,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(headOnly ? undefined : body);
}

function rawError(socket: Duplex, statusCode: number, status: string, message: string): void {
  if (socket.destroyed) return;
  const body = Buffer.from(JSON.stringify({ error: message }));
  socket.end(
    `HTTP/1.1 ${statusCode} ${status}\r\n`
    + "Cache-Control: no-store\r\n"
    + "Connection: close\r\n"
    + `Content-Length: ${body.byteLength}\r\n`
    + "Content-Type: application/json; charset=utf-8\r\n"
    + `\r\n${body.toString()}`,
  );
}

function disableSocketTimeout(socket: Duplex): void {
  const timeoutSocket = socket as Duplex & { setTimeout?: (timeout: number) => unknown };
  timeoutSocket.setTimeout?.(0);
}

function createRequestOptions(
  target: URL,
  method: string | undefined,
  path: string,
  headers: OutgoingHttpHeaders,
  agent: HttpAgent | HttpsAgent,
): RequestOptions {
  return {
    agent,
    headers: {
      ...headers,
      host: target.host,
    },
    hostname: target.hostname,
    method,
    path,
    port: target.port || undefined,
    protocol: target.protocol,
  };
}

function transportRequest(
  target: URL,
  options: RequestOptions,
  callback?: (response: IncomingMessage) => void,
): UpstreamRequest {
  return target.protocol === "https:"
    ? httpsRequest(options, callback)
    : httpRequest(options, callback);
}

function armConnectTimeout(
  request: UpstreamRequest,
  timeoutMs: number,
  onTimeout: () => void,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  request.once("socket", (socket) => {
    if (!socket.connecting) return;
    timer = setTimeout(onTimeout, timeoutMs);
    timer.unref();
    socket.once("connect", clear);
  });
  request.once("response", clear);
  request.once("upgrade", clear);
  request.once("error", clear);
  return clear;
}

function armResponseHeadersTimeout(
  request: UpstreamRequest,
  timeoutMs: number,
  onTimeout: () => void,
): Deadline {
  let timer: NodeJS.Timeout | undefined;
  let completed = false;
  const start = () => {
    if (timer || completed) return;
    timer = setTimeout(onTimeout, timeoutMs);
    timer.unref();
  };
  const clear = () => {
    completed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  request.once("response", clear);
  request.once("upgrade", clear);
  request.once("error", clear);
  return { start, clear };
}

async function checkReadiness(
  target: URL,
  agent: HttpAgent | HttpsAgent,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const request = transportRequest(
      target,
      createRequestOptions(
        target,
        "GET",
        "/api/healthz",
        { accept: "application/json" },
        agent,
      ),
      (response) => {
        response.resume();
        response.once("end", () => finish(
          response.statusCode !== undefined
          && response.statusCode >= 200
          && response.statusCode < 300,
        ));
        response.once("aborted", () => finish(false));
        response.once("error", () => finish(false));
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new ProxyTimeoutError("readiness timeout"));
      finish(false);
    }, timeoutMs);
    timer.unref();
    request.once("error", () => finish(false));
    request.end();
  });
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  path: string,
  agent: HttpAgent | HttpsAgent,
  maxRequestBodyBytes: number,
  timeouts: ResolvedTimeouts,
): void {
  let declaredLength: number | null;
  try {
    declaredLength = parseContentLength(request.headers["content-length"]);
  } catch {
    request.resume();
    sendJson(
      response,
      400,
      { error: "Invalid request" },
      request.method === "HEAD",
      true,
    );
    return;
  }

  if (declaredLength !== null && declaredLength > maxRequestBodyBytes) {
    request.resume();
    sendJson(
      response,
      413,
      { error: "Request body too large" },
      request.method === "HEAD",
      true,
    );
    return;
  }

  let receivedBytes = 0;
  let bodyComplete = false;
  let responseStarted = false;
  let failureHandled = false;
  let discardRemainingBody = false;
  let upstreamBodyEnded = false;
  let bodyTimer: NodeJS.Timeout | undefined;
  let upstreamResponse: IncomingMessage | undefined;

  const forwardUpstreamResponse = (incoming: IncomingMessage, closeConnection: boolean) => {
    responseStarted = true;
    const headers = filterHeaders(incoming.headers);
    if (closeConnection) headers.connection = "close";
    response.writeHead(incoming.statusCode ?? 502, headers);
    incoming.pipe(response);
    incoming.resume();
  };

  let upstreamRequest: UpstreamRequest;
  try {
    upstreamRequest = transportRequest(
      target,
      createRequestOptions(
        target,
        request.method,
        path,
        filterHeaders(request.headers),
        agent,
      ),
      (incoming) => {
        upstreamResponse = incoming;
        const responseArrivedEarly = !bodyComplete;
        if (responseArrivedEarly) {
          discardRemainingBody = true;
          request.resume();
          if (!upstreamBodyEnded) {
            upstreamBodyEnded = true;
            upstreamRequest.end();
          }
        }
        let upstreamResponseTimedOut = false;
        incoming.setTimeout(timeouts.upstreamIdleMs, () => {
          upstreamResponseTimedOut = true;
          incoming.destroy(new ProxyTimeoutError("upstream idle timeout"));
        });
        incoming.once("aborted", () => {
          if (responseStarted) {
            if (!response.writableEnded) response.destroy();
          } else {
            fail(
              upstreamResponseTimedOut
                ? new ProxyTimeoutError("upstream idle timeout")
                : new Error("upstream response aborted"),
            );
          }
        });
        incoming.once("error", (error) => {
          if (responseStarted) {
            if (!response.writableEnded) response.destroy();
          } else {
            fail(error);
          }
        });
        forwardUpstreamResponse(incoming, responseArrivedEarly);
      },
    );
  } catch {
    request.resume();
    sendJson(
      response,
      400,
      { error: "Invalid request" },
      request.method === "HEAD",
      true,
    );
    return;
  }

  function fail(error: Error): void {
    if (failureHandled) return;
    failureHandled = true;
    if (bodyTimer) clearTimeout(bodyTimer);
    request.unpipe();
    request.resume();
    upstreamResponse?.destroy();
    if (responseStarted || response.headersSent) {
      if (!response.writableEnded) response.destroy();
      return;
    }
    if (error instanceof BodyLimitError) {
      sendJson(
        response,
        413,
        { error: "Request body too large" },
        request.method === "HEAD",
        true,
      );
    } else if (error instanceof ProxyTimeoutError) {
      sendJson(
        response,
        504,
        { error: "Gateway timeout" },
        request.method === "HEAD",
        !bodyComplete,
      );
    } else {
      sendJson(
        response,
        502,
        { error: "Bad gateway" },
        request.method === "HEAD",
        !bodyComplete,
      );
    }
  }

  const clearConnectTimer = armConnectTimeout(upstreamRequest, timeouts.connectMs, () => {
    upstreamRequest.destroy(new ProxyTimeoutError("connect timeout"));
  });
  const clearHeadersTimer = armResponseHeadersTimeout(
    upstreamRequest,
    timeouts.responseHeadersMs,
    () => upstreamRequest.destroy(new ProxyTimeoutError("response headers timeout")),
  );

  bodyTimer = setTimeout(() => {
    if (!bodyComplete) upstreamRequest.destroy(new ProxyTimeoutError("request body timeout"));
  }, timeouts.requestBodyMs);
  bodyTimer.unref();

  request.on("data", (chunk: Buffer) => {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maxRequestBodyBytes) {
      upstreamRequest.destroy(new BodyLimitError("body limit exceeded"));
      return;
    }
    if (!discardRemainingBody && !upstreamRequest.write(chunk)) {
      request.pause();
      upstreamRequest.once("drain", () => request.resume());
    }
  });
  request.once("end", () => {
    bodyComplete = true;
    if (bodyTimer) clearTimeout(bodyTimer);
    clearHeadersTimer.start();
    if (!upstreamBodyEnded) {
      upstreamBodyEnded = true;
      upstreamRequest.end();
    }
  });
  request.once("aborted", () => {
    if (bodyTimer) clearTimeout(bodyTimer);
    upstreamRequest.destroy();
  });
  request.once("error", (error) => upstreamRequest.destroy(error));
  response.once("close", () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });
  upstreamRequest.once("error", (error) => {
    clearConnectTimer();
    clearHeadersTimer.clear();
    fail(error);
  });
}

function writeUpgradeResponse(
  clientSocket: Duplex,
  upstreamResponse: IncomingMessage,
): void {
  const rawHeaders = filterRawHeaders(upstreamResponse.rawHeaders);
  let responseHead = `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n`;
  responseHead += "Connection: Upgrade\r\nUpgrade: websocket\r\n";
  for (let index = 0; index < rawHeaders.length; index += 2) {
    responseHead += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`;
  }
  clientSocket.write(`${responseHead}\r\n`);
}

function writeOrdinaryUpgradeResponse(
  clientSocket: Duplex,
  upstreamResponse: IncomingMessage,
): void {
  const rawHeaders = filterRawHeaders(upstreamResponse.rawHeaders);
  let responseHead = `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? ""}\r\n`;
  responseHead += "Connection: close\r\n";
  for (let index = 0; index < rawHeaders.length; index += 2) {
    responseHead += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`;
  }
  clientSocket.write(`${responseHead}\r\n`);
  upstreamResponse.pipe(clientSocket);
}

function proxyWebSocket(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  target: URL,
  path: string,
  agent: HttpAgent | HttpsAgent,
  timeouts: ResolvedTimeouts,
  upstreamSockets: Set<Duplex>,
): void {
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  if (
    request.method !== "GET"
    || typeof upgrade !== "string"
    || upgrade.toLowerCase() !== "websocket"
    || typeof connection !== "string"
    || !connection.toLowerCase().split(",").some((token) => token.trim() === "upgrade")
  ) {
    rawError(clientSocket, 400, "Bad Request", "Invalid WebSocket upgrade");
    return;
  }

  let state: "pending" | "upgraded" | "ordinary-response" | "terminal" = "pending";
  let timedOut = false;
  let ordinaryResponse: IncomingMessage | undefined;
  const headers = filterHeaders(request.headers);
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";

  let upstreamRequest: UpstreamRequest;
  try {
    upstreamRequest = transportRequest(
      target,
      createRequestOptions(target, "GET", path, headers, agent),
    );
  } catch {
    rawError(clientSocket, 400, "Bad Request", "Invalid request");
    return;
  }
  const connectTimer = armConnectTimeout(upstreamRequest, timeouts.connectMs, () => {
    timedOut = true;
    upstreamRequest.destroy(new ProxyTimeoutError("connect timeout"));
  });
  const headerTimer = armResponseHeadersTimeout(
    upstreamRequest,
    timeouts.responseHeadersMs,
    () => {
      timedOut = true;
      upstreamRequest.destroy(new ProxyTimeoutError("response headers timeout"));
    },
  );
  headerTimer.start();

  upstreamRequest.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    if (state !== "pending") {
      upstreamSocket.destroy();
      return;
    }
    state = "upgraded";
    connectTimer();
    headerTimer.clear();
    upstreamRequest.setTimeout(0);
    disableSocketTimeout(upstreamSocket);
    disableSocketTimeout(clientSocket);
    upstreamSockets.add(upstreamSocket);
    upstreamSocket.once("close", () => upstreamSockets.delete(upstreamSocket));

    writeUpgradeResponse(clientSocket, upstreamResponse);
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);

    clientSocket.once("error", () => upstreamSocket.destroy());
    upstreamSocket.once("error", () => clientSocket.destroy());
    clientSocket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => clientSocket.destroy());
  });

  upstreamRequest.once("response", (upstreamResponse) => {
    if (state !== "pending") {
      upstreamResponse.destroy();
      return;
    }
    state = "ordinary-response";
    ordinaryResponse = upstreamResponse;
    connectTimer();
    headerTimer.clear();
    upstreamResponse.setTimeout(timeouts.upstreamIdleMs, () => {
      upstreamResponse.destroy(new ProxyTimeoutError("upstream idle timeout"));
      clientSocket.destroy();
    });
    const abortOrdinaryResponse = () => {
      state = "terminal";
      clientSocket.destroy();
    };
    upstreamResponse.once("aborted", abortOrdinaryResponse);
    upstreamResponse.once("error", abortOrdinaryResponse);
    upstreamResponse.once("end", () => {
      state = "terminal";
    });
    writeOrdinaryUpgradeResponse(clientSocket, upstreamResponse);
  });

  upstreamRequest.once("error", () => {
    connectTimer();
    headerTimer.clear();
    if (state === "pending") {
      state = "terminal";
      rawError(
        clientSocket,
        timedOut ? 504 : 502,
        timedOut ? "Gateway Timeout" : "Bad Gateway",
        timedOut ? "Gateway timeout" : "Bad gateway",
      );
    }
  });
  clientSocket.once("close", () => {
    if (state === "pending") upstreamRequest.destroy();
    ordinaryResponse?.destroy();
  });
  upstreamRequest.end();
}

export function createGatewayProxy(options: GatewayProxyOptions): GatewayProxy {
  const target = parseServerUrl(options.serverUrl);
  const timeouts = resolveTimeouts(options.timeouts);
  const maxRequestBodyBytes = positiveInteger(
    options.maxRequestBodyBytes,
    MAX_REQUEST_BODY_BYTES,
    "max request body bytes",
  );
  const httpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: 256,
    timeout: timeouts.upstreamIdleMs,
  });
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 256,
    timeout: timeouts.upstreamIdleMs,
  });
  const agent = target.protocol === "https:" ? httpsAgent : httpAgent;
  const clientSockets = new Set<Socket>();
  const upgradeSockets = new Set<Duplex>();
  const upstreamSockets = new Set<Duplex>();

  const server = createServer((request, response) => {
    const requestTarget = parseRequestTarget(request.url);
    if (!requestTarget) {
      request.resume();
      sendJson(
        response,
        400,
        { error: "Invalid request target" },
        request.method === "HEAD",
        true,
      );
      return;
    }

    if (
      requestTarget.pathname === "/health"
      && (request.method === "GET" || request.method === "HEAD")
    ) {
      if (rejectLocalEndpointBody(request, response, maxRequestBodyBytes)) return;
      request.resume();
      sendJson(response, 200, { status: "ok" }, request.method === "HEAD");
      return;
    }

    if (
      requestTarget.pathname === "/readyz"
      && (request.method === "GET" || request.method === "HEAD")
    ) {
      if (rejectLocalEndpointBody(request, response, maxRequestBodyBytes)) return;
      request.resume();
      void checkReadiness(target, agent, timeouts.readinessMs).then((ready) => {
        sendJson(
          response,
          ready ? 200 : 503,
          { status: ready ? "ready" : "not ready" },
          request.method === "HEAD",
        );
      });
      return;
    }

    proxyHttpRequest(
      request,
      response,
      target,
      requestTarget.path,
      agent,
      maxRequestBodyBytes,
      timeouts,
    );
  });
  server.headersTimeout = Math.min(timeouts.requestBodyMs, 15_000);
  server.requestTimeout = timeouts.requestBodyMs;
  server.keepAliveTimeout = 5_000;

  server.on("connection", (socket) => {
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
  });

  server.on("connect", (_request, socket) => {
    socket.once("error", () => {});
    rawError(socket, 405, "Method Not Allowed", "CONNECT is not supported");
  });

  server.on("upgrade", (request, socket, head) => {
    socket.once("error", () => {});
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
    const requestTarget = parseRequestTarget(request.url);
    if (!requestTarget) {
      rawError(socket, 400, "Bad Request", "Invalid request target");
      return;
    }
    if (!WEBSOCKET_PATHS.has(requestTarget.pathname)) {
      rawError(socket, 404, "Not Found", "WebSocket route not found");
      return;
    }
    proxyWebSocket(
      request,
      socket,
      head,
      target,
      requestTarget.path,
      agent,
      timeouts,
      upstreamSockets,
    );
  });

  return {
    server,
    targetOrigin: target.origin,
    async close(graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
      if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
        throw new Error("shutdown grace must be a non-negative integer");
      }

      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          for (const socket of clientSockets) socket.destroy();
          for (const socket of upstreamSockets) socket.destroy();
          httpAgent.destroy();
          httpsAgent.destroy();
          resolve();
          return;
        }

        let serverClosed = false;
        let forceElapsed = upgradeSockets.size === 0 && upstreamSockets.size === 0;
        let closeError: Error | undefined;
        let completed = false;
        const finish = () => {
          if (completed || !serverClosed || !forceElapsed) return;
          completed = true;
          clearTimeout(forceTimer);
          httpAgent.destroy();
          httpsAgent.destroy();
          if (closeError) reject(closeError);
          else resolve();
        };
        const forceTimer = setTimeout(() => {
          for (const socket of clientSockets) socket.destroy();
          for (const socket of upstreamSockets) socket.destroy();
          server.closeAllConnections?.();
          forceElapsed = true;
          finish();
        }, graceMs);
        forceTimer.unref();

        server.close((error) => {
          serverClosed = true;
          closeError = error;
          if (upgradeSockets.size === 0 && upstreamSockets.size === 0) {
            forceElapsed = true;
          }
          finish();
        });
        server.closeIdleConnections?.();
      });
    },
  };
}
