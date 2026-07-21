import { describe, it, expect } from 'vitest';
import {
  scadaEventWireSchema,
  buildScadaEventWire,
  fromAnchorableEvent,
  SCADA_EVENTS_SUBJECT,
  type LegacyAnchorableEvent,
} from '../scada-event';

/**
 * Twin contract fixture (issue #440): the byte-identical JSON also asserted
 * by `0xSCADA-node/src/bridge.rs` test `test_canonical_wire_fixture`.
 * If you change it here, change it there in the same commit.
 */
const CANONICAL_FIXTURE = `{"asset":"TR-MAIN-01","event_type":"BREAKER_TRIP","site_id":"site-1","timestamp":"2026-03-15T22:00:00Z","payload":{"voltage":138.5},"site_name":"Substation Alpha","asset_type":"BREAKER","details":"Breaker tripped on overcurrent"}`;

describe('scada.events wire schema (#440)', () => {
  it('uses the subject the Rust node subscribes to', () => {
    expect(SCADA_EVENTS_SUBJECT).toBe('scada.events');
  });

  it('accepts the canonical twin fixture', () => {
    const parsed = scadaEventWireSchema.parse(JSON.parse(CANONICAL_FIXTURE));
    expect(parsed.asset).toBe('TR-MAIN-01');
    expect(parsed.event_type).toBe('BREAKER_TRIP');
    expect(parsed.site_id).toBe('site-1');
    expect(parsed.timestamp).toBe('2026-03-15T22:00:00Z');
  });

  it('round-trips the canonical fixture byte-identically', () => {
    // Key order is preserved by JSON.parse/stringify for these shapes, so a
    // schema-validated re-serialization must equal the fixture exactly —
    // this is what pins both repos to the same bytes.
    const wire = buildScadaEventWire(JSON.parse(CANONICAL_FIXTURE));
    expect(JSON.stringify(wire)).toBe(CANONICAL_FIXTURE);
  });

  it('REJECTS the legacy camelCase AnchorableEvent serialization (the #440 drift)', () => {
    const legacy = {
      id: 'evt-1',
      timestamp: '2026-03-15T22:00:00Z',
      eventType: 'BREAKER_TRIP',
      siteId: 'site-1',
      severity: 'critical',
      message: 'Breaker tripped',
    };
    const result = scadaEventWireSchema.safeParse(legacy);
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (strict contract)', () => {
    const withExtra = { ...JSON.parse(CANONICAL_FIXTURE), sneaky_new_field: 1 };
    expect(scadaEventWireSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rejects missing required fields and bad timestamps', () => {
    const base = JSON.parse(CANONICAL_FIXTURE);
    for (const field of ['asset', 'event_type', 'site_id', 'timestamp']) {
      const broken = { ...base };
      delete broken[field];
      expect(scadaEventWireSchema.safeParse(broken).success).toBe(false);
    }
    expect(
      scadaEventWireSchema.safeParse({ ...base, timestamp: 'yesterday' }).success
    ).toBe(false);
  });

  it('converts the legacy AnchorableEvent shape via fromAnchorableEvent', () => {
    const legacy: LegacyAnchorableEvent = {
      id: 'evt-1',
      timestamp: new Date('2026-03-15T22:00:00Z'),
      eventType: 'BREAKER_TRIP',
      siteId: 'site-1',
      severity: 'critical',
      message: 'Breaker tripped',
      data: { voltage: 138.5 },
    };
    const wire = fromAnchorableEvent(legacy, 'TR-MAIN-01');
    expect(wire.asset).toBe('TR-MAIN-01');
    expect(wire.event_type).toBe('BREAKER_TRIP');
    expect(wire.site_id).toBe('site-1');
    expect(wire.timestamp).toBe('2026-03-15T22:00:00.000Z');
    expect(wire.details).toBe('Breaker tripped');
    expect(wire.payload).toEqual({ voltage: 138.5, severity: 'critical', id: 'evt-1' });
  });
});
