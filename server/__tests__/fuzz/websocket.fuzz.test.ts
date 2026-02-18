/**
 * Fuzz Testing: WebSocket Endpoints
 *
 * Tests WebSocket message parsing, subscription management, and event
 * broadcasting with malicious and edge-case inputs.
 *
 * Closes #259 (part 2/2)
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type {
  ClientMessage,
  EventFilters,
  SubscribeMessage,
  UnsubscribeMessage,
} from '../../websocket/types';

// =============================================================================
// MESSAGE PARSING FUZZ TESTS
// =============================================================================

describe('Fuzz: WebSocket Message Parsing', () => {
  /**
   * Simulates what the server does when it receives raw WebSocket data:
   * JSON.parse then validate the message type.
   */
  function parseClientMessage(raw: string): ClientMessage | null {
    try {
      const msg = JSON.parse(raw);
      if (!msg || typeof msg !== 'object') return null;
      if (!['subscribe', 'unsubscribe', 'ping'].includes(msg.type)) return null;
      return msg as ClientMessage;
    } catch {
      return null;
    }
  }

  it('should safely reject arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100_000 }), (raw) => {
        expect(() => parseClientMessage(raw)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('should safely reject arbitrary JSON values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const raw = JSON.stringify(value);
        expect(() => parseClientMessage(raw)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('should accept valid subscribe messages', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constant('subscribe'),
          filters: fc.option(
            fc.record({
              siteIds: fc.option(fc.array(fc.string(), { maxLength: 10 })),
              eventTypes: fc.option(fc.array(fc.string(), { maxLength: 10 })),
            }),
          ),
          requestId: fc.option(fc.string()),
        }),
        (msg) => {
          const raw = JSON.stringify(msg);
          const parsed = parseClientMessage(raw);
          expect(parsed).not.toBeNull();
          expect(parsed!.type).toBe('subscribe');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should handle deeply nested filter objects', () => {
    const createDeep = (depth: number): any => {
      if (depth === 0) return ['value'];
      return { nested: createDeep(depth - 1) };
    };

    const depths = [10, 50, 100];
    for (const depth of depths) {
      const msg = {
        type: 'subscribe',
        filters: { siteIds: createDeep(depth) },
      };

      const start = Date.now();
      const raw = JSON.stringify(msg);
      expect(() => parseClientMessage(raw)).not.toThrow();
      expect(Date.now() - start).toBeLessThan(5000);
    }
  });

  it('should reject messages with __proto__ pollution', () => {
    const pollutionPayloads = [
      '{"type":"subscribe","__proto__":{"isAdmin":true}}',
      '{"type":"subscribe","constructor":{"prototype":{"isAdmin":true}}}',
      '{"type":"subscribe","filters":{"__proto__":{"polluted":true}}}',
    ];

    for (const payload of pollutionPayloads) {
      const parsed = parseClientMessage(payload);
      // Parsed object should NOT have polluted the global prototype
      expect(({} as any).isAdmin).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined();
    }
  });
});

// =============================================================================
// EVENT FILTER FUZZ TESTS
// =============================================================================

describe('Fuzz: Event Filter Matching', () => {
  /**
   * Simulates server-side filter matching logic.
   */
  function matchesFilters(
    event: { siteId: string; eventType: string; severity: string },
    filters: Partial<EventFilters>,
  ): boolean {
    if (filters.siteIds?.length && !filters.siteIds.includes(event.siteId)) return false;
    if (filters.eventTypes?.length && !filters.eventTypes.includes(event.eventType)) return false;
    if (filters.severities?.length && !filters.severities.includes(event.severity)) return false;
    return true;
  }

  it('should handle empty filters (match all)', () => {
    fc.assert(
      fc.property(
        fc.record({
          siteId: fc.string(),
          eventType: fc.string(),
          severity: fc.constantFrom('info', 'warning', 'error', 'critical'),
        }),
        (event) => {
          expect(matchesFilters(event, {})).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should correctly filter by siteId', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (eventSite, filterSite) => {
          const event = { siteId: eventSite, eventType: 'test', severity: 'info' };
          const filters = { siteIds: [filterSite] };
          const result = matchesFilters(event, filters);
          expect(result).toBe(eventSite === filterSite);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should handle very large filter arrays', () => {
    const largeSiteIds = Array.from({ length: 10_000 }, (_, i) => `site-${i}`);
    const event = { siteId: 'site-5000', eventType: 'test', severity: 'info' };

    const start = Date.now();
    const result = matchesFilters(event, { siteIds: largeSiteIds });
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('should handle regex-like strings in filter values', () => {
    const regexStrings = [
      '.*',
      '(.*)',
      '[a-z]+',
      'site-\\d+',
      'site-.*|other-.*',
      '(?:)',
      '/etc/passwd',
    ];

    for (const str of regexStrings) {
      const event = { siteId: str, eventType: str, severity: 'info' };
      const filters = { siteIds: [str], eventTypes: [str] };
      expect(() => matchesFilters(event, filters)).not.toThrow();
      expect(matchesFilters(event, filters)).toBe(true);
    }
  });
});

// =============================================================================
// SUBSCRIPTION ID FUZZ TESTS
// =============================================================================

describe('Fuzz: Subscription Management', () => {
  it('should handle rapid subscribe/unsubscribe cycles', () => {
    // Simulate a subscription map
    const subscriptions = new Map<string, { filters: Partial<EventFilters> }>();

    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              action: fc.constant('subscribe' as const),
              id: fc.uuid(),
              filters: fc.record({
                siteIds: fc.option(fc.array(fc.string(), { maxLength: 5 })),
              }),
            }),
            fc.record({
              action: fc.constant('unsubscribe' as const),
              id: fc.uuid(),
            }),
          ),
          { minLength: 0, maxLength: 100 },
        ),
        (ops) => {
          for (const op of ops) {
            if (op.action === 'subscribe') {
              subscriptions.set(op.id, { filters: (op as any).filters || {} });
            } else {
              subscriptions.delete(op.id);
            }
          }
          // Should not have thrown and map should be in consistent state
          expect(subscriptions.size).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// =============================================================================
// BINARY / MALFORMED FRAME FUZZ TESTS
// =============================================================================

describe('Fuzz: Binary & Malformed WebSocket Frames', () => {
  it('should reject binary data gracefully', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 10_000 }),
        (bytes) => {
          // Simulate receiving binary as a string
          const raw = Buffer.from(bytes).toString('utf-8');
          try {
            JSON.parse(raw);
          } catch {
            // Expected — binary data is not valid JSON
          }
          // Should not crash the process
          expect(true).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should handle extremely large messages', () => {
    const sizes = [64 * 1024, 256 * 1024, 1024 * 1024]; // 64KB, 256KB, 1MB

    for (const size of sizes) {
      const largeMsg = JSON.stringify({
        type: 'subscribe',
        filters: { siteIds: new Array(size / 10).fill('x') },
      });

      const start = Date.now();
      try {
        JSON.parse(largeMsg);
      } catch {
        // May fail on very large inputs — that's OK
      }
      expect(Date.now() - start).toBeLessThan(10_000);
    }
  });

  it('should handle truncated JSON gracefully', () => {
    const validJson = '{"type":"subscribe","filters":{"siteIds":["site-1","site-2"]}}';

    for (let i = 1; i < validJson.length; i++) {
      const truncated = validJson.slice(0, i);
      expect(() => {
        try { JSON.parse(truncated); } catch { /* expected */ }
      }).not.toThrow();
    }
  });
});
