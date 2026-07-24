import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_CREDENTIAL_SESSION_KEY,
  OXSCADA_WEBSOCKET_AUTH_PREFIX,
  OXSCADA_WEBSOCKET_PROTOCOL,
  _resetApiCredentialForTests,
  apiFetch,
  buildApiHeaders,
  buildWebSocketProtocols,
  getApiCredential,
  setApiCredential,
} from "../api-credential";

describe("browser API credential plumbing", () => {
  beforeEach(() => {
    _resetApiCredentialForTests();
    vi.restoreAllMocks();
  });

  it("keeps the credential tab-scoped in sessionStorage", () => {
    setApiCredential("  oxs_session_secret  ");

    expect(getApiCredential()).toBe("oxs_session_secret");
    expect(sessionStorage.getItem(API_CREDENTIAL_SESSION_KEY)).toBe("oxs_session_secret");
    expect(localStorage.getItem(API_CREDENTIAL_SESSION_KEY)).toBeNull();
  });

  it("adds X-API-Key only to same-origin API requests", () => {
    const apiHeaders = buildApiHeaders("/api/sites", undefined, "read-key");
    const externalHeaders = buildApiHeaders(
      "https://example.invalid/api/sites",
      undefined,
      "read-key",
    );

    expect(apiHeaders.get("X-API-Key")).toBe("read-key");
    expect(externalHeaders.has("X-API-Key")).toBe(false);
  });

  it("does not overwrite a caller-provided API key", () => {
    const headers = buildApiHeaders(
      "/api/sites",
      { headers: { "X-API-Key": "explicit-key" } },
      "session-key",
    );
    expect(headers.get("X-API-Key")).toBe("explicit-key");
  });

  it("constructs a stable protocol plus an encoded credential protocol", () => {
    expect(buildWebSocketProtocols("secret")).toEqual([
      OXSCADA_WEBSOCKET_PROTOCOL,
      `${OXSCADA_WEBSOCKET_AUTH_PREFIX}c2VjcmV0`,
    ]);
    expect(buildWebSocketProtocols("")).toEqual([]);
  });

  it("apiFetch delegates with the session header", async () => {
    setApiCredential("session-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await apiFetch("/api/sites", { method: "GET" });

    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).get("X-API-Key")).toBe("session-key");
  });
});
