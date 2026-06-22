/**
 * useValidatorNodes — polls every configured oxscada node's :9090 /status and
 * /events on an interval and exposes per-node results.
 *
 * Issue #453 — [wave:2a] Validator Dashboard.
 *
 * Convention note: the 0xSCADA client uses custom hooks + fetch/WebSocket rather
 * than TanStack Query (no QueryClientProvider is mounted in `main.tsx` and
 * `@tanstack/react-query` is not a dependency). This hook follows the established
 * `use-event-stream` / `use-tag-stream` pattern.
 *
 * INTEGRATION (#442 / TanStack): if the app later adopts TanStack Query, this hook
 * can be reimplemented as `useQueries({ queries: nodeUrls.map(...) })` polling
 * `pollNode` with `refetchInterval`. The component only depends on the returned
 * `NodePollResult[]`, so that swap is internal to this file.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { pollNode, getConfiguredNodeUrls, type NodePollResult } from '../lib/oxscada-rpc';

export interface UseValidatorNodesOptions {
  /** Node base URLs to poll. Defaults to env (VITE_ANCHOR_NODE_URLS). */
  nodeUrls?: string[];
  /** Poll cadence in millis. Default 3s — well under the 10s stale window. */
  pollIntervalMs?: number;
  /** Per-request timeout. Default 4s. */
  timeoutMs?: number;
}

export interface UseValidatorNodesReturn {
  /** One entry per configured node, in node-URL order. */
  results: NodePollResult[];
  /** True until the first poll cycle completes. */
  loading: boolean;
  /** Wall-clock millis of the last completed poll cycle. */
  lastPollAt: number | null;
  /** Force an immediate poll. */
  refresh: () => void;
}

export function useValidatorNodes(options: UseValidatorNodesOptions = {}): UseValidatorNodesReturn {
  const { nodeUrls, pollIntervalMs = 3000, timeoutMs = 4000 } = options;

  // Resolve the URL list once per distinct csv so the effect dep is stable.
  const urls = nodeUrls ?? getConfiguredNodeUrls();
  const urlsKey = urls.join('|');

  const [results, setResults] = useState<NodePollResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);

  // Trigger counter to force a poll outside the interval.
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Keep the latest results in a ref so a node that drops out mid-cycle keeps its
  // last-known result (which then ages into 'stale' via classifyNodeHealth).
  const lastResults = useRef<Map<string, NodePollResult>>(new Map());

  useEffect(() => {
    const list = urlsKey ? urlsKey.split('|') : [];
    let cancelled = false;
    const controller = new AbortController();

    async function runCycle() {
      const settled = await Promise.all(
        list.map((nodeUrl) => pollNode(nodeUrl, { timeoutMs, signal: controller.signal })),
      );
      if (cancelled) return;
      for (const r of settled) lastResults.current.set(r.nodeUrl, r);
      // Emit in stable node-URL order. Every url in `list` was just polled, so a
      // fresh result is guaranteed; fall back to the last-known one defensively.
      const ordered = list
        .map((u) => lastResults.current.get(u))
        .filter((r): r is NodePollResult => r !== undefined);
      setResults(ordered);
      setLastPollAt(Date.now());
      setLoading(false);
    }

    // Run immediately, then on the interval.
    void runCycle();
    const id = setInterval(() => void runCycle(), pollIntervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
    // urlsKey re-creates the cycle when the configured node set changes; tick forces a manual refresh.
  }, [urlsKey, pollIntervalMs, timeoutMs, tick]);

  return { results, loading, lastPollAt, refresh };
}

export default useValidatorNodes;
