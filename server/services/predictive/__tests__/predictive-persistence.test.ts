/**
 * Predictive-maintenance durability tests
 * ADR-0013 [13.1] / ADR-0026 "Durable approvals" row — Issue #546
 *
 * These run against a REAL file-backed SQLite database through the REAL
 * Drizzle store. Nothing is mocked and nothing is in-memory: the store is
 * closed and reopened between assertions, which is what "survives a restart"
 * actually means. A threshold that reset on restart would not be a
 * configuration, and an acknowledgement that reset on restart would not be an
 * audit record, so both are re-read on the far side of the reopen.
 *
 * Postgres gets the same two tables from
 * `migrations/0013_predictive_durable_state.sql`; the migration itself is
 * exercised in `predictive-migration.test.ts`.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from 'sqlite3';
import {
  DEFAULT_ALERT_MAX_AGE_MS,
  DEFAULT_ALERT_RETENTION_MS,
  PredictiveMaintenanceEngine,
  type EngineOptions,
} from '../engine';
import { PredictiveMaintenanceService, resolveAlertRetention } from '../index';
import { DrizzlePredictiveStore, PredictiveStoreUnavailableError } from '../store';

const OPERATOR = 'control-room-lead';
const OTHER_OPERATOR = 'night-shift-lead';

let directory: string;
let file: string;
let open: DrizzlePredictiveStore[] = [];

function store(): DrizzlePredictiveStore {
  const created = new DrizzlePredictiveStore({ sqlitePath: file });
  open.push(created);
  return created;
}

/**
 * A brand new engine on a brand new connection to the same database file.
 * This is the restart: no state is carried across in JavaScript, so anything
 * the new engine can see came out of the database.
 */
function restartedEngine(options: Omit<EngineOptions, 'store'> = {}): PredictiveMaintenanceEngine {
  return new PredictiveMaintenanceEngine({ ...options, store: store() });
}

/**
 * A spike big enough that the ensemble rates it non-`info`.
 *
 * The baseline deliberately has variance: a perfectly constant baseline gives
 * an infinite z-score, which saturates every detector no matter how the
 * thresholds are configured, and would make the desensitisation test below
 * pass for the wrong reason.
 */
function loadSpike(engine: PredictiveMaintenanceEngine, tagId: string): void {
  for (let i = 0; i < 40; i++) engine.ingestPoint(tagId, i * 1000, 10 + Math.sin(i));
  engine.ingestPoint(tagId, 41_000, 500);
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'predictive-durable-'));
  file = path.join(directory, 'predictive.sqlite');
  open = [];
});

afterEach(async () => {
  await Promise.all(open.map((instance) => instance.close()));
  await rm(directory, { recursive: true, force: true });
});

describe('configured thresholds survive process replacement (#546)', () => {
  it('restores every field, including failure limits and attribution', async () => {
    const before = restartedEngine();
    await before.setThresholds('bearing-temp', {
      minSamples: 7,
      zScoreThreshold: 4.5,
      ewmaAlpha: 0.15,
      ewmaL: 2.5,
      iqrMultiplier: 2,
      ensembleWeights: { 'z-score': 0.6, ewma: 0.3, iqr: 0.1 },
      severityThresholds: { warning: 0.5, critical: 0.8, emergency: 0.95 },
      failureLimits: { low: 5, high: 189 },
    }, OPERATOR);

    const after = restartedEngine();
    const restored = await after.getThresholds('bearing-temp');
    expect(restored).toEqual({
      tagId: 'bearing-temp',
      minSamples: 7,
      zScoreThreshold: 4.5,
      ewmaAlpha: 0.15,
      ewmaL: 2.5,
      iqrMultiplier: 2,
      ensembleWeights: { 'z-score': 0.6, ewma: 0.3, iqr: 0.1 },
      severityThresholds: { warning: 0.5, critical: 0.8, emergency: 0.95 },
      failureLimits: { low: 5, high: 189 },
    });

    const [configured] = await after.listConfiguredTags();
    expect(configured.tagId).toBe('bearing-temp');
    expect(configured.updatedBy).toBe(OPERATOR);
    expect(configured.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps a desensitised tag desensitised after a restart', async () => {
    // The behavioural version of the claim above: before #546 a restart
    // reverted this tag to the built-in defaults and it started alarming again.
    const before = restartedEngine();
    await before.setThresholds('quiet-tag', {
      zScoreThreshold: 100_000,
      ewmaL: 100_000,
      iqrMultiplier: 100_000,
    }, OPERATOR);

    const after = restartedEngine();
    loadSpike(after, 'quiet-tag');
    const assessment = await after.analyze('quiet-tag');
    expect(assessment?.severity).toBe('info');
    expect(await after.listAlerts()).toHaveLength(0);
  });

  it('does not duplicate or lose a tag when the same threshold is written twice', async () => {
    const first = restartedEngine();
    await first.setThresholds('t', { minSamples: 5 }, OPERATOR);
    const second = restartedEngine();
    await second.setThresholds('t', { zScoreThreshold: 9 }, OTHER_OPERATOR);

    const third = restartedEngine();
    const configured = await third.listConfiguredTags();
    expect(configured).toHaveLength(1);
    // Merged, not replaced: the second write kept the first write's minSamples.
    expect(configured[0].thresholds.minSamples).toBe(5);
    expect(configured[0].thresholds.zScoreThreshold).toBe(9);
    expect(configured[0].updatedBy).toBe(OTHER_OPERATOR);
  });
});

describe('alert identity and acknowledgement survive process replacement (#546)', () => {
  it('restores the alert and its acknowledgement attribution', async () => {
    const before = restartedEngine();
    loadSpike(before, 'pump-vibration');
    await before.analyze('pump-vibration');
    const [raised] = await before.listAlerts();
    expect(raised).toBeDefined();
    const acknowledgement = await before.acknowledgeAlert(raised.id, OPERATOR);
    expect(acknowledgement.status).toBe('acknowledged');

    const after = restartedEngine();
    const [restored] = await after.listAlerts();
    expect(restored.id).toBe(raised.id);
    expect(restored.tagId).toBe('pump-vibration');
    expect(restored.severity).toBe(raised.severity);
    expect(restored.score).toBeCloseTo(raised.score, 10);
    expect(restored.message).toBe(raised.message);
    expect(restored.detectors).toEqual(raised.detectors);
    expect(restored.recommendation).toBe(raised.recommendation);
    expect(restored.timestamp).toBe(raised.timestamp);
    expect(restored.acknowledged).toBe(true);
    expect(restored.acknowledgedBy).toBe(OPERATOR);
    expect(restored.acknowledgedAt).toBe(acknowledgement.alert?.acknowledgedAt);
  });

  it('does not re-raise an alert the operator already acknowledged', async () => {
    // The duplication half of the acceptance criteria. The alert id is derived
    // from tag + severity + cooldown window rather than from a per-process
    // counter, so the restarted process recognises the anomaly it already
    // reported instead of opening a second one.
    const before = restartedEngine({ alertCooldownMs: 60 * 60 * 1000 });
    loadSpike(before, 'fan-current');
    await before.analyze('fan-current');
    const [raised] = await before.listAlerts();
    await before.acknowledgeAlert(raised.id, OPERATOR);

    const after = restartedEngine({ alertCooldownMs: 60 * 60 * 1000 });
    const emitted: string[] = [];
    after.on('alert', (alert: { id: string }) => emitted.push(alert.id));
    loadSpike(after, 'fan-current');
    await after.analyze('fan-current');

    const alerts = await after.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe(raised.id);
    // Still acknowledged: the restart neither reopened it nor lost the record.
    expect(alerts[0].acknowledged).toBe(true);
    expect(alerts[0].acknowledgedBy).toBe(OPERATOR);
    // And no operator-facing alarm was re-emitted for the suppressed alert.
    expect(emitted).toEqual([]);
  });

  it('keeps the first acknowledger when a second process acknowledges the same alert', async () => {
    // Two engines on two connections to one database is the multi-replica
    // case: whoever gets there first owns the record.
    const replicaA = restartedEngine();
    const replicaB = restartedEngine();
    loadSpike(replicaA, 'valve-position');
    await replicaA.analyze('valve-position');
    const [alert] = await replicaA.listAlerts();

    const first = await replicaA.acknowledgeAlert(alert.id, OPERATOR);
    const second = await replicaB.acknowledgeAlert(alert.id, OTHER_OPERATOR);

    expect(first.status).toBe('acknowledged');
    expect(second.status).toBe('already-acknowledged');
    expect(second.alert?.acknowledgedBy).toBe(OPERATOR);

    const after = restartedEngine();
    const [persisted] = await after.listAlerts();
    expect(persisted.acknowledgedBy).toBe(OPERATOR);
  });

  it('lets a second replica see the first replica\'s alerts and configuration', async () => {
    const replicaA = restartedEngine();
    await replicaA.setThresholds('shared-tag', { minSamples: 12 }, OPERATOR);
    loadSpike(replicaA, 'shared-tag');
    await replicaA.analyze('shared-tag');

    // Never ingested anything, never configured anything — it reads the store.
    const replicaB = restartedEngine();
    expect((await replicaB.getThresholds('shared-tag')).minSamples).toBe(12);
    expect(await replicaB.listAlerts({ tagId: 'shared-tag' })).toHaveLength(1);
    const status = await replicaB.getDurableStatus();
    expect(status).toMatchObject({
      backend: 'sqlite',
      configuredTags: 1,
      activeAlerts: 1,
      totalAlerts: 1,
    });
  });
});

describe('startup hydration is deterministic (#546)', () => {
  it('reports the durable state it found, and reports it identically twice', async () => {
    const seed = restartedEngine();
    await seed.setThresholds('a', { minSamples: 5 }, OPERATOR);
    await seed.setThresholds('b', { minSamples: 6 }, OPERATOR);
    loadSpike(seed, 'a');
    await seed.analyze('a');

    const restarted = restartedEngine();
    const first = await restarted.hydrate();
    expect(first).toEqual({
      backend: 'sqlite',
      configuredTags: 2,
      totalAlerts: 1,
      unacknowledgedAlerts: 1,
    });

    // Re-hydrating must be a no-op: no row is dropped and none is created.
    const again = await restarted.hydrate();
    expect(again).toEqual(first);
    expect(await restarted.listAlerts()).toHaveLength(1);
    expect(await restarted.listConfiguredTags()).toHaveLength(2);
  });

  it('surfaces the hydrated summary through the service and its health check', async () => {
    const seed = restartedEngine();
    await seed.setThresholds('a', { minSamples: 5 }, OPERATOR);

    const service = new PredictiveMaintenanceService(30_000, { store: store() });
    try {
      expect(service.getHydration()).toBeNull();
      await service.initialize();
      expect(service.getHydration()).toMatchObject({ configuredTags: 1, totalAlerts: 0 });
      const health = await service.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.message).toContain('1 configured tag(s)');
    } finally {
      await service.shutdown();
    }
  });
});

describe('durable-state failures are observable and fail closed (#546)', () => {
  /** A store pointed at a path that cannot be opened as a database. */
  function brokenEngine(): PredictiveMaintenanceEngine {
    const broken = new DrizzlePredictiveStore({ sqlitePath: directory });
    open.push(broken);
    return new PredictiveMaintenanceEngine({ store: broken });
  }

  it('refuses a threshold write rather than keeping it in memory', async () => {
    const engine = brokenEngine();
    const errors: Array<{ error: string }> = [];
    engine.on('store-error', (event: { error: string }) => errors.push(event));

    await expect(engine.setThresholds('t', { minSamples: 5 }, OPERATOR))
      .rejects.toBeInstanceOf(PredictiveStoreUnavailableError);
    // Observable: the failure is emitted and retained for /status.
    expect(errors.length).toBeGreaterThan(0);
    expect(engine.getLastStoreError()).toEqual(expect.any(String));
    // Fail closed: the value was NOT retained anywhere.
    await expect(engine.getThresholds('t'))
      .rejects.toBeInstanceOf(PredictiveStoreUnavailableError);
  });

  it('refuses an acknowledgement and an alert generation', async () => {
    const engine = brokenEngine();
    await expect(engine.acknowledgeAlert('PMA-anything', OPERATOR))
      .rejects.toBeInstanceOf(PredictiveStoreUnavailableError);

    const emitted: unknown[] = [];
    engine.on('alert', (alert) => emitted.push(alert));
    loadSpike(engine, 't');
    await expect(engine.analyze('t')).rejects.toBeInstanceOf(PredictiveStoreUnavailableError);
    // No alarm is raised for an alert that was never recorded — an operator
    // must never see an alarm they cannot then acknowledge.
    expect(emitted).toEqual([]);
  });

  it('reports the service as unhealthy while the store is unreachable', async () => {
    const broken = new DrizzlePredictiveStore({ sqlitePath: directory });
    open.push(broken);
    const service = new PredictiveMaintenanceService(30_000, { store: broken });
    try {
      await service.initialize();
      expect(service.getHydration()).toBeNull();
      const health = await service.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.message).toContain('durable store unavailable');
    } finally {
      await service.shutdown();
    }
  });

  it('recovers once the store becomes reachable again', async () => {
    // The refusal must be a state of the store, not a latch: the same engine
    // that just failed has to work again once the database can be opened.
    const missing = path.join(directory, 'not-created-yet');
    const recovering = new DrizzlePredictiveStore({
      sqlitePath: path.join(missing, 'predictive.sqlite'),
    });
    open.push(recovering);
    const engine = new PredictiveMaintenanceEngine({ store: recovering });

    await expect(engine.setThresholds('t', { minSamples: 5 }, OPERATOR))
      .rejects.toBeInstanceOf(PredictiveStoreUnavailableError);
    expect(engine.getLastStoreError()).toEqual(expect.any(String));

    await mkdir(missing, { recursive: true });
    await engine.setThresholds('t', { minSamples: 5 }, OPERATOR);
    expect(engine.getLastStoreError()).toBeNull();
    expect((await engine.getThresholds('t')).minSamples).toBe(5);
  });
});

describe('alert retention is configured independently of the history window (#546)', () => {
  it('defaults to 90 days for acknowledged alerts and 365 days absolute', () => {
    expect(resolveAlertRetention({} as NodeJS.ProcessEnv)).toEqual({
      alertRetentionMs: DEFAULT_ALERT_RETENTION_MS,
      alertMaxAgeMs: DEFAULT_ALERT_MAX_AGE_MS,
    });
  });

  it('reads both windows from the environment', () => {
    expect(resolveAlertRetention({
      PREDICTIVE_ALERT_RETENTION_MS: '1000',
      PREDICTIVE_ALERT_MAX_AGE_MS: '5000',
    } as NodeJS.ProcessEnv)).toEqual({ alertRetentionMs: 1000, alertMaxAgeMs: 5000 });
  });

  it('never lets the absolute cut-off fall below the acknowledged window', () => {
    // Otherwise an acknowledged alert would outlive an unacknowledged one.
    expect(resolveAlertRetention({
      PREDICTIVE_ALERT_RETENTION_MS: '5000',
      PREDICTIVE_ALERT_MAX_AGE_MS: '1000',
    } as NodeJS.ProcessEnv)).toEqual({ alertRetentionMs: 5000, alertMaxAgeMs: 5000 });
  });

  it('ignores unusable values rather than disabling retention', () => {
    expect(resolveAlertRetention({
      PREDICTIVE_ALERT_RETENTION_MS: '0',
      PREDICTIVE_ALERT_MAX_AGE_MS: 'not-a-number',
    } as NodeJS.ProcessEnv)).toEqual({
      alertRetentionMs: DEFAULT_ALERT_RETENTION_MS,
      alertMaxAgeMs: DEFAULT_ALERT_MAX_AGE_MS,
    });
  });

  it('does not persist raw prediction history', async () => {
    // The scope split the issue asks for: sampled data stays in the bounded
    // in-process window, only operator config and alert/audit state go durable.
    const engine = restartedEngine();
    loadSpike(engine, 'history-tag');
    await engine.analyze('history-tag');
    expect(engine.getHistory('history-tag').length).toBe(41);

    const after = restartedEngine();
    expect(after.getHistory('history-tag')).toEqual([]);
    expect(after.getTrackedTags()).toEqual([]);
    // ...but the alert the history produced did survive.
    expect(await after.listAlerts({ tagId: 'history-tag' })).toHaveLength(1);
  });
});

describe('the store releases its handle (#546)', () => {
  it('closes the connection even when close() races an in-flight connect()', async () => {
    // `connect()` publishes `this.connection` from a `.then()` callback. A
    // close() that lands in that gap used to clear a still-undefined field and
    // then have the pending open write a live handle back, leaking the
    // descriptor (and, on Postgres, the server-side session) with no reference
    // left to close it. Closing must therefore wait for the open to settle.
    const racing = new DrizzlePredictiveStore({ sqlitePath: file });
    const opening = racing.ready();
    await racing.close();
    await opening.catch(() => undefined);

    expect(racing.backend()).toBe('unopened');
    // Proof the OS handle really went: on Windows an open SQLite file cannot
    // be unlinked, so this throws EBUSY if the descriptor was leaked.
    await rm(file, { force: true });
  });
});

describe('the durable tables really are on disk (#546)', () => {
  it('writes rows a plain SQLite client can read back', async () => {
    const engine = restartedEngine();
    await engine.setThresholds('disk-tag', { minSamples: 5 }, OPERATOR);
    loadSpike(engine, 'disk-tag');
    await engine.analyze('disk-tag');
    const [alert] = await engine.listAlerts();
    await engine.acknowledgeAlert(alert.id, OPERATOR);
    await Promise.all(open.map((instance) => instance.close()));
    open = [];

    const raw = new Database(file);
    try {
      const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        raw.all(
          'SELECT tag_id, updated_by FROM predictive_tag_thresholds',
          (error, result) => (error ? reject(error) : resolve(result as Array<Record<string, unknown>>)),
        );
      });
      expect(rows).toEqual([{ tag_id: 'disk-tag', updated_by: OPERATOR }]);

      const alerts = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        raw.all(
          'SELECT id, acknowledged, acknowledged_by FROM predictive_alerts',
          (error, result) => (error ? reject(error) : resolve(result as Array<Record<string, unknown>>)),
        );
      });
      expect(alerts).toEqual([
        { id: alert.id, acknowledged: 1, acknowledged_by: OPERATOR },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        raw.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('rejects an acknowledged row with no acknowledger at the database level', async () => {
    // The CHECK constraint is the last line of defence for attribution: even a
    // direct SQL writer cannot record an anonymous acknowledgement.
    const engine = restartedEngine();
    loadSpike(engine, 'constraint-tag');
    await engine.analyze('constraint-tag');
    const [alert] = await engine.listAlerts();
    await Promise.all(open.map((instance) => instance.close()));
    open = [];

    const raw = new Database(file);
    try {
      await expect(new Promise<void>((resolve, reject) => {
        raw.run(
          'UPDATE predictive_alerts SET acknowledged = 1 WHERE id = ?',
          [alert.id],
          (error) => (error ? reject(error) : resolve()),
        );
      })).rejects.toThrow(/constraint/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        raw.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
