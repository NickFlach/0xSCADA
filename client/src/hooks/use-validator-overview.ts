/**
 * useValidatorOverview — polls the same-origin `/api/validators` proxy.
 *
 * Issue #453 — [wave:2a] Validator Dashboard.
 *
 * The browser makes exactly one kind of request: a relative GET to
 * `/api/validators`. Node URLs are server-side configuration (`ANCHOR_NODE_URLS`)
 * and never reach the client, so the dashboard works unchanged behind TLS and
 * needs no CORS grant from any node.
 *
 * Convention note: the 0xSCADA client uses custom hooks + fetch rather than
 * TanStack Query (no QueryClientProvider is mounted in `main.tsx`). This hook
 * follows the established `use-event-stream` / `use-tag-stream` pattern.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ValidatorOverview } from '@shared/types/services/validator-dashboard';
import { fetchValidatorOverview, ValidatorApiError } from '../lib/validator-api';

export interface UseValidatorOverviewOptions {
  /**
   * Poll cadence in millis. Default 3s — comfortably under the 8s stale window.
   * The server caches its own node polls, so a faster client does not translate
   * into more load on the validator fleet.
   */
  pollIntervalMs?: number;
  /** Set false to suspend polling (e.g. while the operator has no API key). */
  enabled?: boolean;
}

export interface UseValidatorOverviewReturn {
  /** Last successful response, or null until the first one lands. */
  overview: ValidatorOverview | null;
  /** True until the first request settles. */
  loading: boolean;
  /** Last error message, cleared on the next success. */
  error: string | null;
  /** HTTP status of the last failure (401/403 drive the credential hint). */
  errorStatus: number | null;
  /** CLIENT-clock millis at which `overview` was received; null if none yet. */
  receivedAt: number | null;
  /** Force an immediate poll. */
  refresh: () => void;
}

export function useValidatorOverview(
  options: UseValidatorOverviewOptions = {},
): UseValidatorOverviewReturn {
  const { pollIntervalMs = 3000, enabled = true } = options;

  const [overview, setOverview] = useState<ValidatorOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Guards against a slow response landing after unmount / a newer cycle.
  const cycleRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const cycle = ++cycleRef.current;

    async function runCycle(): Promise<void> {
      try {
        const next = await fetchValidatorOverview(controller.signal);
        if (cancelled || cycleRef.current !== cycle) return;
        setOverview(next);
        setReceivedAt(Date.now());
        setError(null);
        setErrorStatus(null);
      } catch (err) {
        if (cancelled || cycleRef.current !== cycle) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // A failed poll keeps the previous overview on screen; it simply ages
        // out into 'stale' rather than blanking the operator's view.
        setError(err instanceof Error ? err.message : 'Validator API request failed');
        setErrorStatus(err instanceof ValidatorApiError ? err.status : null);
      } finally {
        if (!cancelled && cycleRef.current === cycle) setLoading(false);
      }
    }

    void runCycle();
    const id = setInterval(() => void runCycle(), pollIntervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [pollIntervalMs, enabled, tick]);

  return { overview, loading, error, errorStatus, receivedAt, refresh };
}

export default useValidatorOverview;
