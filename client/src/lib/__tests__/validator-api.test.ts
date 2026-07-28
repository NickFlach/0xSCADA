/**
 * Tests for the same-origin validator API client (issue #453).
 *
 * The review's first finding was that the dashboard talked to nodes straight
 * from the browser. These tests pin the replacement behaviour: exactly one
 * relative URL, the operator credential attached, and a contract-checked body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VALIDATOR_OVERVIEW_PATH,
  ValidatorApiError,
  fetchValidatorOverview,
} from '../validator-api';
import { _resetApiCredentialForTests, setApiCredential } from '../api-credential';
import type { ValidatorOverview } from '@shared/types/services/validator-dashboard';

const overview: ValidatorOverview = {
  configured: true,
  generatedAt: 1_700_000_000_000,
  cached: false,
  provenance: {
    verified: false,
    method: 'none',
    detail: 'Node-reported and unsigned.',
  },
  nodes: [
    {
      label: 'node-a:9090',
      reachable: true,
      error: null,
      observedAt: 1_700_000_000_000,
      status: {
        nodeId: 'node-a',
        height: 10,
        role: 'validator',
        reportedOrderParameter: 0.98,
        reportedMeanPhase: 1.2,
        localPhase: 1.19,
        peers: 1,
        mempool: 0,
        uptimeTicks: 5,
        peerPhases: [],
      },
    },
  ],
  validators: [
    {
      id: 'node-a',
      phase: 1.19,
      naturalFrequency: null,
      lastUpdatedUnixSeconds: null,
      reportedBy: ['node-a:9090'],
      disputed: false,
    },
  ],
  coherence: { r: 1, meanPhase: 1.19, count: 1 },
  unavailableMetrics: [{ metric: 'attestation-rate-per-round', reason: 'not exposed by /status' }],
};

beforeEach(() => {
  _resetApiCredentialForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetApiCredentialForTests();
});

describe('fetchValidatorOverview', () => {
  it('calls exactly one relative, same-origin path — never a node URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(overview), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchValidatorOverview();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toBe(VALIDATOR_OVERVIEW_PATH);
    expect(requested).toBe('/api/validators');
    // No scheme, host or node port may appear in a client-issued request.
    expect(requested).not.toMatch(/^https?:/);
    expect(requested).not.toContain('9090');
  });

  it('attaches the operator API key so the guarded route is reachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(overview), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setApiCredential('reader-key');

    await fetchValidatorOverview();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('X-API-Key')).toBe('reader-key');
  });

  it('returns the parsed overview on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(overview), { status: 200 })),
    );
    const result = await fetchValidatorOverview();
    expect(result.provenance.verified).toBe(false);
    expect(result.validators[0].id).toBe('node-a');
  });

  it('surfaces 401 and 403 with an actionable message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(fetchValidatorOverview()).rejects.toMatchObject({ status: 401 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    const err = await fetchValidatorOverview().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidatorApiError);
    expect((err as ValidatorApiError).message).toContain('validators.read');
  });

  it('rejects a body that does not match the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ configured: true }), { status: 200 })),
    );
    await expect(fetchValidatorOverview()).rejects.toBeInstanceOf(ValidatorApiError);
  });

  it('rejects a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(fetchValidatorOverview()).rejects.toBeInstanceOf(ValidatorApiError);
  });

  it('wraps a transport failure rather than leaking the raw rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));
    await expect(fetchValidatorOverview()).rejects.toBeInstanceOf(ValidatorApiError);
  });
});
