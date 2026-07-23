/**
 * oxscada Validator RPC Client (#454)
 *
 * Thin HTTP client used by the cross-node state proxy to ask a *specific*
 * validator for its view of a state key. The client speaks the oxscada RPC
 * `state_get` request and returns the validator's signed response verbatim —
 * signature verification is performed by the route layer, NOT here, so this
 * client stays a transport concern.
 *
 * Failure taxonomy (so the route can map to distinct status codes):
 *   - `NodeUnreachableError`  → connection refused / DNS / network error  → 502
 *   - `NodeTimeoutError`      → request exceeded the deadline             → 504
 *   - `StateKeyNotFoundError` → validator reports the key is unknown      → 404
 *   - `NodeRpcError`          → any other non-OK RPC response             → 502
 *
 * The `fetch` implementation is injectable so the client (and the whole proxy)
 * can be integration-tested against a local fake node without monkey-patching
 * globals.
 */

import type { SignedStateResponse } from "./state-signature";

/** Minimal subset of the global `fetch` we depend on (keeps it test-injectable). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface NodeClientOptions {
  /** Per-request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
}

// ─── Error taxonomy ───────────────────────────────────────────────────────────

export class NodeUnreachableError extends Error {
  readonly code = "validator-unreachable" as const;
  constructor(
    public readonly nodeId: string,
    cause?: unknown,
  ) {
    super(`Validator ${nodeId} unreachable: ${describeCause(cause)}`);
    this.name = "NodeUnreachableError";
  }
}

export class NodeTimeoutError extends Error {
  readonly code = "validator-timeout" as const;
  constructor(
    public readonly nodeId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Validator ${nodeId} did not respond within ${timeoutMs}ms`);
    this.name = "NodeTimeoutError";
  }
}

export class StateKeyNotFoundError extends Error {
  readonly code = "key-not-found" as const;
  constructor(
    public readonly nodeId: string,
    public readonly key: string,
  ) {
    super(`Key "${key}" not found on validator ${nodeId}`);
    this.name = "StateKeyNotFoundError";
  }
}

export class NodeRpcError extends Error {
  readonly code = "validator-rpc-error" as const;
  constructor(
    public readonly nodeId: string,
    public readonly httpStatus: number,
    detail?: string,
  ) {
    super(
      `Validator ${nodeId} RPC error (HTTP ${httpStatus})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "NodeRpcError";
  }
}

export type StateProtocolV2Field = "nonce" | "observedAt";

/**
 * The upstream validator returned the legacy signed-state shape. Treat this as
 * a rollout incompatibility, not as a generic transport/RPC failure: accepting
 * v1 would remove the request challenge and freshness guarantees.
 */
export class StateProtocolVersionError extends Error {
  readonly code = "state-protocol-incompatible" as const;
  readonly expectedProtocol = "oxscada-state-v2" as const;

  constructor(
    public readonly nodeId: string,
    public readonly incompatibleFields: readonly StateProtocolV2Field[],
  ) {
    super(
      `Validator ${nodeId} returned an incompatible signed-state response; ` +
        `oxscada-state-v2 requires valid ${incompatibleFields.join(" and ")}`,
    );
    this.name = "StateProtocolVersionError";
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "network error";
}

// ─── Response validation ───────────────────────────────────────────────────────

/**
 * Runtime guard for the validator's `state_get` response. We deliberately do
 * NOT throw here for missing fields beyond signalling shape problems — the
 * signature check downstream is the real authority on integrity, but we still
 * reject structurally-broken payloads early.
 */
function isSignedStateResponse(body: unknown): body is SignedStateResponse {
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.key === "string" &&
    typeof b.blockHeight === "number" &&
    typeof b.nonce === "string" &&
    typeof b.observedAt === "string" &&
    typeof b.signature === "string" &&
    (b.keyId === undefined || typeof b.keyId === "string") &&
    "value" in b
  );
}

function incompatibleStateV2Fields(body: unknown): StateProtocolV2Field[] {
  if (body === null || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const hasSignedStateCore =
    typeof b.key === "string" &&
    typeof b.blockHeight === "number" &&
    typeof b.signature === "string" &&
    "value" in b;
  if (!hasSignedStateCore) return [];

  const incompatible: StateProtocolV2Field[] = [];
  if (typeof b.nonce !== "string") incompatible.push("nonce");
  if (typeof b.observedAt !== "string") incompatible.push("observedAt");
  return incompatible;
}

/** A node not found / disabled in the registry — surfaced separately by the route. */
export class UnknownValidatorError extends Error {
  readonly code = "unknown-validator" as const;
  constructor(public readonly nodeId: string) {
    super(`Unknown or disabled validator: ${nodeId}`);
    this.name = "UnknownValidatorError";
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class NodeRpcClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: NodeClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    // Fall back to the global fetch (Node 18+). Captured lazily so tests that
    // pass `fetchImpl` never touch the global.
    const injected = options.fetchImpl;
    this.fetchImpl =
      injected ??
      ((input, init) =>
        (globalThis.fetch as unknown as FetchLike)(input, init));
  }

  /**
   * Query a validator's signed view of a single state key.
   *
   * @param nodeId  Registry id of the validator (for error messages).
   * @param rpcUrl  Base RPC URL of the validator (no trailing path required).
   * @param key     State key to query.
   * @throws NodeTimeoutError | NodeUnreachableError | StateKeyNotFoundError | NodeRpcError
   */
  async getState(
    nodeId: string,
    rpcUrl: string,
    key: string,
    nonce?: string,
  ): Promise<SignedStateResponse> {
    const query = nonce ? `?nonce=${encodeURIComponent(nonce)}` : "";
    const url = `${rpcUrl.replace(/\/$/, "")}/state/${encodeURIComponent(key)}${query}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError → timeout; everything else is a transport/network failure.
      if (isAbortError(err)) {
        throw new NodeTimeoutError(nodeId, this.timeoutMs);
      }
      throw new NodeUnreachableError(nodeId, err);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      throw new StateKeyNotFoundError(nodeId, key);
    }

    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = (await res.text()).slice(0, 256);
      } catch {
        /* ignore body read failure */
      }
      throw new NodeRpcError(nodeId, res.status, detail);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new NodeRpcError(
        nodeId,
        res.status,
        `invalid JSON: ${describeCause(err)}`,
      );
    }

    const incompatibleFields = incompatibleStateV2Fields(body);
    if (incompatibleFields.length > 0) {
      throw new StateProtocolVersionError(nodeId, incompatibleFields);
    }

    if (!isSignedStateResponse(body)) {
      throw new NodeRpcError(
        nodeId,
        res.status,
        "malformed signed-state response",
      );
    }

    return body;
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR")
  );
}
