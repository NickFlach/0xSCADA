/**
 * Mock API helpers for testing CLI commands
 * 
 * Usage:
 *   import { mockFetch, resetMocks, mockApiResponse } from './helpers/mockApi';
 */

import { vi, type Mock } from 'vitest';

// Store original fetch
const originalFetch = globalThis.fetch;

// Mock fetch function
let mockFetchFn: Mock | null = null;

/**
 * Create a mock response object
 */
export function createMockResponse<T>(
  data: T,
  options: { status?: number; ok?: boolean } = {}
): Response {
  const { status = 200, ok = true } = options;
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as Response;
}

/**
 * Set up mock fetch for testing
 */
export function mockFetch(): Mock {
  mockFetchFn = vi.fn();
  globalThis.fetch = mockFetchFn;
  return mockFetchFn;
}

/**
 * Reset all mocks and restore original fetch
 */
export function resetMocks(): void {
  if (mockFetchFn) {
    mockFetchFn.mockReset();
  }
  globalThis.fetch = originalFetch;
  mockFetchFn = null;
}

/**
 * Mock a successful API response
 */
export function mockApiSuccess<T>(mock: Mock, data: T, status = 200): void {
  mock.mockResolvedValueOnce(createMockResponse(data, { status, ok: true }));
}

/**
 * Mock an API error response
 */
export function mockApiError(mock: Mock, error: string, status = 500): void {
  mock.mockResolvedValueOnce(
    createMockResponse({ error }, { status, ok: false })
  );
}

/**
 * Mock network failure
 */
export function mockNetworkError(mock: Mock, message = 'Network error'): void {
  mock.mockRejectedValueOnce(new Error(message));
}

/**
 * Mock timeout (abort error)
 */
export function mockTimeout(mock: Mock): void {
  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';
  mock.mockRejectedValueOnce(abortError);
}

// ============ Sample Mock Data ============

export const mockHealthResponse = {
  status: 'healthy',
  timestamp: new Date().toISOString(),
  version: '1.0.0',
  uptime: 3600,
  components: {
    database: { status: 'connected', latencyMs: 5 },
    blockchain: { status: 'connected' },
  },
};

export const mockSites = [
  {
    id: 'site-001',
    name: 'Test Refinery',
    location: 'Houston, TX',
    owner: 'ACME Corp',
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'site-002',
    name: 'Demo Plant',
    location: 'Dallas, TX',
    owner: 'Demo Inc',
    createdAt: '2024-01-02T00:00:00Z',
  },
];

export const mockAssets = [
  {
    id: 'asset-001',
    siteId: 'site-001',
    assetType: 'pump',
    nameOrTag: 'P-101',
    critical: true,
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'asset-002',
    siteId: 'site-001',
    assetType: 'valve',
    nameOrTag: 'V-201',
    critical: false,
    createdAt: '2024-01-01T00:00:00Z',
  },
];

export const mockEvents = {
  data: [
    {
      id: 'event-001',
      assetId: 'asset-001',
      eventType: 'maintenance',
      payloadHash: '0xabc123',
      timestamp: '2024-01-10T12:00:00Z',
      recordedBy: 'admin',
      txHash: null,
      details: 'Routine maintenance',
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  totalPages: 1,
  hasNextPage: false,
  hasPrevPage: false,
};

export const mockBatchStats = {
  pendingEvents: 5,
  totalBatchesAnchored: 10,
  totalEventsAnchored: 150,
  lastBatchTime: '2024-01-10T11:00:00Z',
  averageEventsPerBatch: 15,
  estimatedGasSavings: 0.85,
};
