import { useSyncExternalStore } from "react";

export const API_CREDENTIAL_SESSION_KEY = "oxscada.api-key";
export const OXSCADA_WEBSOCKET_PROTOCOL = "oxscada.v1";
export const OXSCADA_WEBSOCKET_AUTH_PREFIX = "oxscada.api-key.";

let inMemoryCredential: string | undefined;
let hydrated = false;
const listeners = new Set<() => void>();

function browserSessionStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const stored = browserSessionStorage()?.getItem(API_CREDENTIAL_SESSION_KEY)?.trim();
  inMemoryCredential = stored || undefined;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function getApiCredential(): string {
  hydrate();
  return inMemoryCredential ?? "";
}

export function setApiCredential(value: string): void {
  const next = value.trim();
  hydrated = true;
  inMemoryCredential = next || undefined;
  const storage = browserSessionStorage();
  try {
    if (next) storage?.setItem(API_CREDENTIAL_SESSION_KEY, next);
    else storage?.removeItem(API_CREDENTIAL_SESSION_KEY);
  } catch {
    // The in-memory credential remains usable when storage is unavailable.
  }
  emitChange();
}

export function clearApiCredential(): void {
  setApiCredential("");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useApiCredential(): {
  apiKey: string;
  setApiKey: (value: string) => void;
  clearApiKey: () => void;
} {
  const apiKey = useSyncExternalStore(subscribe, getApiCredential, () => "");
  return {
    apiKey,
    setApiKey: setApiCredential,
    clearApiKey: clearApiCredential,
  };
}

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : input.toString();
  if (raw.startsWith("/api") && (raw.length === 4 || raw[4] === "/" || raw[4] === "?")) {
    return true;
  }
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin &&
      (url.pathname === "/api" || url.pathname.startsWith("/api/"));
  } catch {
    return false;
  }
}

/** Add X-API-Key only to same-origin /api requests. */
export function buildApiHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
  apiKey = getApiCredential(),
): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  if (apiKey && isSameOriginApiRequest(input) && !headers.has("X-API-Key")) {
    headers.set("X-API-Key", apiKey);
  }
  return headers;
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: buildApiHeaders(input, init),
  });
}

function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length === 0 || bytes.length > 512) {
    throw new Error("API key must contain between 1 and 512 UTF-8 bytes");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

/**
 * Browser-safe credential transport for the WebSocket HTTP upgrade.
 * The stable application protocol is negotiated; the credential token is not.
 */
export function buildWebSocketProtocols(apiKey = getApiCredential()): string[] {
  if (!apiKey) return [];
  return [
    OXSCADA_WEBSOCKET_PROTOCOL,
    `${OXSCADA_WEBSOCKET_AUTH_PREFIX}${base64UrlEncodeUtf8(apiKey)}`,
  ];
}

/** Test-only reset for module and session state. */
export function _resetApiCredentialForTests(): void {
  hydrated = true;
  inMemoryCredential = undefined;
  try {
    browserSessionStorage()?.removeItem(API_CREDENTIAL_SESSION_KEY);
  } catch {
    // ignored
  }
  emitChange();
}
