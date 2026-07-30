/**
 * Field simulator — continuous analog process tags
 * Issue #5
 *
 * The discrete event stream fires every ~10s and carries mostly categorical
 * payloads, so predictive/twin/SPC had no realistic numeric series in dev.
 * These tests cover the analog path: the generator is pure and seeded (so the
 * series is reproducible), values stay inside the physical band, the emitter
 * is wired to SIMULATOR_ANALOG_INTERVAL_MS, and every broadcast value is a
 * finite number rather than a stringified payload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TagUpdate } from '../websocket/tag-stream';

const broadcastTagUpdate = vi.fn<(u: TagUpdate) => void>();
const publishAsset = vi.fn();
const publishScadaEvent = vi.fn();
const publishAlarm = vi.fn();

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('../websocket/tag-stream', () => ({
  tagStreamServer: { broadcastTagUpdate: (u: TagUpdate) => broadcastTagUpdate(u) },
}));
vi.mock('../websocket/cached-event-bridge', () => ({
  cachedEventBridge: { publishAlarm: (a: unknown) => publishAlarm(a) },
}));
vi.mock('../services/flux', () => ({
  getFluxPublisher: () => ({ publishAsset: (...args: unknown[]) => publishAsset(...args) }),
}));
vi.mock('../services/nats', () => ({
  natsPublisher: { publishScadaEvent: (e: unknown) => publishScadaEvent(e) },
}));
vi.mock('../bridge', () => ({ getAnchorPipeline: () => null }));

import {
  ANALOG_CHANNELS,
  FieldSimulator,
  analogChannelsForAsset,
  generateAnalogSample,
  seedForTag,
  type AnalogChannelSpec,
} from '../simulator';

/** Every analog tag the six demo assets are expected to emit, in order. */
const EXPECTED_TAGS = [
  'TR-MAIN-01.TEMPERATURE',
  'TR-MAIN-01.LOAD_PERCENT',
  'BK-FEEDER-01.CURRENT',
  'INV-01.DC_VOLTAGE',
  'INV-01.AC_POWER_KW',
  'MCC-PUMP-01.MOTOR_CURRENT',
  'BK-FEEDER-02.CURRENT',
  'INV-02.DC_VOLTAGE',
  'INV-02.AC_POWER_KW',
];

const ALL_SPECS: AnalogChannelSpec[] = Object.values(ANALOG_CHANNELS).flatMap((s) => [...s]);

const ENV_KEYS = [
  'SIMULATOR_ENABLED',
  'SIMULATOR_INTERVAL_MS',
  'SIMULATOR_ANALOG_INTERVAL_MS',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  broadcastTagUpdate.mockClear();
  publishAsset.mockClear();
  publishScadaEvent.mockClear();
  publishAlarm.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

/** Build a started simulator under the supplied env, with fake timers active. */
async function startSimulator(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.useFakeTimers();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const sim = new FieldSimulator();
  await sim.initialize();
  sim.start();
  return sim;
}

describe('analog channel specs', () => {
  it('gives every simulated asset type 1-3 channels', () => {
    for (const assetType of ['TRANSFORMER', 'BREAKER', 'INVERTER', 'MCC']) {
      const channels = analogChannelsForAsset(assetType);
      expect(channels.length).toBeGreaterThanOrEqual(1);
      expect(channels.length).toBeLessThanOrEqual(3);
    }
  });

  it('returns no channels for an unknown asset type', () => {
    expect(analogChannelsForAsset('NO_SUCH_TYPE')).toHaveLength(0);
  });

  it('keeps drift plus noise inside the declared band for every spec', () => {
    for (const spec of ALL_SPECS) {
      expect(spec.baseline - spec.amplitude - spec.noise).toBeGreaterThanOrEqual(spec.min);
      expect(spec.baseline + spec.amplitude + spec.noise).toBeLessThanOrEqual(spec.max);
    }
  });
});

describe('generateAnalogSample determinism', () => {
  const spec = ANALOG_CHANNELS.TRANSFORMER[0];

  it('is pure — the same seed and elapsed time reproduce the series exactly', () => {
    const a = Array.from({ length: 200 }, (_, i) => generateAnalogSample(spec, i * 2000, 12345));
    const b = Array.from({ length: 200 }, (_, i) => generateAnalogSample(spec, i * 2000, 12345));
    expect(a).toEqual(b);
    // A constant series would satisfy equality vacuously — it must actually move.
    expect(new Set(a).size).toBeGreaterThan(100);
  });

  it('produces a different series for a different seed', () => {
    const a = Array.from({ length: 100 }, (_, i) => generateAnalogSample(spec, i * 2000, 12345));
    const b = Array.from({ length: 100 }, (_, i) => generateAnalogSample(spec, i * 2000, 54321));
    expect(a).not.toEqual(b);
  });

  it('draws no entropy from Math.random', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    for (const s of ALL_SPECS) {
      for (let i = 0; i < 50; i++) generateAnalogSample(s, i * 2000, seedForTag(`X.${s.channel}`));
    }
    expect(randomSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  it('gives two assets sharing a spec independent series', () => {
    const spec2 = ANALOG_CHANNELS.BREAKER[0];
    const a = Array.from({ length: 100 }, (_, i) =>
      generateAnalogSample(spec2, i * 2000, seedForTag('BK-FEEDER-01.CURRENT')));
    const b = Array.from({ length: 100 }, (_, i) =>
      generateAnalogSample(spec2, i * 2000, seedForTag('BK-FEEDER-02.CURRENT')));
    expect(a).not.toEqual(b);
  });

  it('hashes tag names to distinct, finite, non-negative seeds', () => {
    const seeds = EXPECTED_TAGS.map(seedForTag);
    expect(new Set(seeds).size).toBe(EXPECTED_TAGS.length);
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('generateAnalogSample bounds', () => {
  it('stays inside [min, max] and finite over a full drift period', () => {
    for (const spec of ALL_SPECS) {
      const seed = seedForTag(`SAMPLE.${spec.channel}`);
      // 2s cadence across one full drift period — every phase of the sine.
      const steps = Math.ceil(spec.periodMs / 2000);
      const values: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const v = generateAnalogSample(spec, i * 2000, seed);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(spec.min);
        expect(v).toBeLessThanOrEqual(spec.max);
        values.push(v);
      }
      // The band must actually be exercised: the drift alone spans 2*amplitude.
      const span = Math.max(...values) - Math.min(...values);
      expect(span).toBeGreaterThan(spec.amplitude);
    }
  });

  it('clamps a spec whose swing would leave the physical band', () => {
    const clipped: AnalogChannelSpec = {
      channel: 'CLIPPED', unit: '%', baseline: 50, amplitude: 200, noise: 5,
      periodMs: 100_000, min: 0, max: 100,
    };
    const values = Array.from({ length: 200 }, (_, i) => generateAnalogSample(clipped, i * 500, 99));
    expect(Math.max(...values)).toBe(100);
    expect(Math.min(...values)).toBe(0);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('analog emission wiring', () => {
  it('broadcasts every asset channel once per SIMULATOR_ANALOG_INTERVAL_MS', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'true',
      SIMULATOR_ANALOG_INTERVAL_MS: '2000',
      SIMULATOR_INTERVAL_MS: '3600000', // park the discrete stream out of the way
    });

    expect(broadcastTagUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(broadcastTagUpdate.mock.calls.map(([u]) => u.tagName)).toEqual(EXPECTED_TAGS);

    vi.advanceTimersByTime(4000);
    expect(broadcastTagUpdate).toHaveBeenCalledTimes(EXPECTED_TAGS.length * 3);

    sim.stop();
  });

  it('honours a custom analog interval', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'true',
      SIMULATOR_ANALOG_INTERVAL_MS: '500',
      SIMULATOR_INTERVAL_MS: '3600000',
    });

    vi.advanceTimersByTime(2000);
    expect(broadcastTagUpdate).toHaveBeenCalledTimes(EXPECTED_TAGS.length * 4);

    sim.stop();
  });

  it('falls back to the 2s default when the interval env var is not a positive number', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'true',
      SIMULATOR_ANALOG_INTERVAL_MS: 'not-a-number',
      SIMULATOR_INTERVAL_MS: '3600000',
    });

    vi.advanceTimersByTime(1999);
    expect(broadcastTagUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(broadcastTagUpdate).toHaveBeenCalledTimes(EXPECTED_TAGS.length);

    sim.stop();
  });

  it('broadcasts finite numbers with good quality — never a stringified payload', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'true',
      SIMULATOR_ANALOG_INTERVAL_MS: '2000',
      SIMULATOR_INTERVAL_MS: '3600000',
    });

    vi.advanceTimersByTime(20_000);
    expect(broadcastTagUpdate.mock.calls.length).toBe(EXPECTED_TAGS.length * 10);

    for (const [update] of broadcastTagUpdate.mock.calls) {
      expect(typeof update.value).toBe('number');
      expect(Number.isFinite(update.value as number)).toBe(true);
      expect(update.quality).toBe('good');
      expect(Number.isFinite(new Date(update.timestamp).getTime())).toBe(true);
    }

    sim.stop();
  });

  it('advances elapsed time by one interval per tick, seeded by tag name', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'true',
      SIMULATOR_ANALOG_INTERVAL_MS: '2000',
      SIMULATOR_INTERVAL_MS: '3600000',
    });

    vi.advanceTimersByTime(6000); // three ticks: elapsed 0, 2000, 4000
    const temps = broadcastTagUpdate.mock.calls
      .filter(([u]) => u.tagName === 'TR-MAIN-01.TEMPERATURE')
      .map(([u]) => u.value);

    const spec = ANALOG_CHANNELS.TRANSFORMER[0];
    const seed = seedForTag('TR-MAIN-01.TEMPERATURE');
    expect(temps).toEqual([
      generateAnalogSample(spec, 0, seed),
      generateAnalogSample(spec, 2000, seed),
      generateAnalogSample(spec, 4000, seed),
    ]);

    sim.stop();
  });

  it('emits nothing when SIMULATOR_ENABLED is false', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'false',
      SIMULATOR_ANALOG_INTERVAL_MS: '2000',
    });

    vi.advanceTimersByTime(60_000);
    expect(broadcastTagUpdate).not.toHaveBeenCalled();

    sim.stop();
  });

  it('stops emitting after stop()', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'true',
      SIMULATOR_ANALOG_INTERVAL_MS: '2000',
      SIMULATOR_INTERVAL_MS: '3600000',
    });

    vi.advanceTimersByTime(2000);
    const afterFirstTick = broadcastTagUpdate.mock.calls.length;
    expect(afterFirstTick).toBe(EXPECTED_TAGS.length);

    sim.stop();
    vi.advanceTimersByTime(60_000);
    expect(broadcastTagUpdate.mock.calls.length).toBe(afterFirstTick);
  });
});

describe('discrete event stream is unchanged', () => {
  it('still publishes events on SIMULATOR_INTERVAL_MS alongside the analog stream', async () => {
    const sim = await startSimulator({
      SIMULATOR_ENABLED: 'true',
      SIMULATOR_ANALOG_INTERVAL_MS: '3600000', // park the analog stream out of the way
      SIMULATOR_INTERVAL_MS: '10000',
    });

    vi.advanceTimersByTime(30_000);
    expect(publishAsset).toHaveBeenCalledTimes(3);
    expect(publishScadaEvent).toHaveBeenCalledTimes(3);

    // Discrete tags keep the ASSET.EVENT_TYPE convention, distinct from the
    // analog channels — no analog channel name may appear here.
    const analogChannels = new Set(ALL_SPECS.map((s) => s.channel));
    const eventTags = broadcastTagUpdate.mock.calls.map(([u]) => u.tagName);
    expect(eventTags).toHaveLength(3);
    for (const tag of eventTags) {
      expect(analogChannels.has(tag.split('.')[1])).toBe(false);
    }

    sim.stop();
  });
});
