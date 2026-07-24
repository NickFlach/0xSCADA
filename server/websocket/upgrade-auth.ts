/**
 * API-key authentication for browser WebSocket upgrade requests.
 *
 * Browsers cannot set X-API-Key on `new WebSocket()`. They can set negotiated
 * subprotocol tokens, so the client sends:
 *   - oxscada.v1
 *   - oxscada.api-key.<base64url(UTF-8 key)>
 *
 * The server validates the credential before `handleUpgrade` and negotiates
 * only the stable `oxscada.v1` protocol. Credentials in URL query strings are
 * rejected because URLs are routinely logged.
 */

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { ApiKeyRecord } from "../middleware/api-gateway";

export const OXSCADA_WEBSOCKET_PROTOCOL = "oxscada.v1";
export const OXSCADA_WEBSOCKET_AUTH_PREFIX = "oxscada.api-key.";
export const DEFAULT_WEBSOCKET_SCOPES = Object.freeze(["stream.read", "read"]);

export interface WebSocketAuthOptions {
  required: boolean;
  apiKeys: ReadonlyMap<string, ApiKeyRecord>;
  acceptedScopes?: readonly string[];
}
export type WebSocketUpgradeDecision =
  | { ok: true; record?: ApiKeyRecord }
  | { ok: false; status: 400 | 401 | 403; error: string };

export interface AuthenticatedWebSocketRequest extends IncomingMessage {
  apiKeyRecord?: ApiKeyRecord;
}

const FORBIDDEN_QUERY_CREDENTIAL_NAMES = new Set([
  "apikey",
  "accesstoken",
  "token",
  "authorization",
]);

function protocolTokens(request: IncomingMessage): string[] {
  const raw = request.headers["sec-websocket-protocol"];
  const combined = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  return combined.split(",").map((token) => token.trim()).filter(Boolean);
}

function decodeCredentialProtocol(token: string): string | undefined {
  if (!token.startsWith(OXSCADA_WEBSOCKET_AUTH_PREFIX)) return undefined;
  const encoded = token.slice(OXSCADA_WEBSOCKET_AUTH_PREFIX.length);
  if (!encoded || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined;
  }

  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0 || bytes.length > 512) return undefined;
    if (bytes.toString("base64url") !== encoded) return undefined;
    const key = bytes.toString("utf8");
    if (!key || Buffer.from(key, "utf8").compare(bytes) !== 0) return undefined;
    if (/[\u0000-\u001f\u007f]/.test(key)) return undefined;
    return key;
  } catch {
    return undefined;
  }
}

function hasAcceptedScope(
  record: ApiKeyRecord,
  acceptedScopes: readonly string[],
): boolean {
  return record.scopes.includes("*") ||
    record.scopes.includes("admin") ||
    acceptedScopes.some((scope) => record.scopes.includes(scope));
}

export function authorizeWebSocketUpgrade(
  request: AuthenticatedWebSocketRequest,
  options: WebSocketAuthOptions,
): WebSocketUpgradeDecision {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const hasQueryCredential = Array.from(requestUrl.searchParams.keys())
    .some((name) => FORBIDDEN_QUERY_CREDENTIAL_NAMES.has(
      name.toLowerCase().replace(/[-_]/gu, ""),
    ));
  if (hasQueryCredential) {
    return {
      ok: false,
      status: 400,
      error: "WebSocket credentials are not accepted in the URL.",
    };
  }

  const protocols = protocolTokens(request);
  const credentialTokens = protocols.filter((token) =>
    token.startsWith(OXSCADA_WEBSOCKET_AUTH_PREFIX)
  );
  if (credentialTokens.length > 1) {
    return { ok: false, status: 400, error: "Multiple WebSocket credentials supplied." };
  }

  if (credentialTokens.length === 0) {
    return options.required
      ? { ok: false, status: 401, error: "WebSocket authentication required." }
      : { ok: true };
  }

  if (!protocols.includes(OXSCADA_WEBSOCKET_PROTOCOL)) {
    return {
      ok: false,
      status: 400,
      error: `WebSocket protocol ${OXSCADA_WEBSOCKET_PROTOCOL} is required.`,
    };
  }

  const key = decodeCredentialProtocol(credentialTokens[0]);
  const record = key ? options.apiKeys.get(key) : undefined;
  if (!record || (record.expiresAt && record.expiresAt.getTime() <= Date.now())) {
    return { ok: false, status: 401, error: "Invalid or expired WebSocket credential." };
  }

  const acceptedScopes = options.acceptedScopes ?? DEFAULT_WEBSOCKET_SCOPES;
  if (!hasAcceptedScope(record, acceptedScopes)) {
    return {
      ok: false,
      status: 403,
      error: "WebSocket credential lacks a streaming read scope.",
    };
  }

  request.apiKeyRecord = record;
  return { ok: true, record };
}

export function selectOxscadaWebSocketProtocol(protocols: Set<string>): string | false {
  return protocols.has(OXSCADA_WEBSOCKET_PROTOCOL)
    ? OXSCADA_WEBSOCKET_PROTOCOL
    : false;
}

export function rejectWebSocketUpgrade(
  socket: Duplex,
  decision: Exclude<WebSocketUpgradeDecision, { ok: true }>,
): void {
  const statusText = decision.status === 400
    ? "Bad Request"
    : decision.status === 401
      ? "Unauthorized"
      : "Forbidden";
  const body = JSON.stringify({ error: decision.error });
  socket.end(
    `HTTP/1.1 ${decision.status} ${statusText}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "\r\n" +
    body,
  );
}
