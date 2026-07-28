import { describe, expect, it, vi } from 'vitest';
import {
  AutoRemediationEngine,
  CRITICAL_PATH_SLOS,
  RemediationAuditPersistenceError,
  RemediationRuntime,
  RemediationRuntimeUnavailableError,
  SloRegistry,
  createGatewayFailoverAction,
  createScaleOutAction,
  type RemediationAction,
} from '../index';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const now = () => new Date(NOW);

describe('SloRegistry', () => {
  it('defines every ADR-0014 critical path with an owner, metric, and runbook', () => {
    const registry = new SloRegistry();
    const definitions = registry.list();

    expect(definitions.map(item => item.id)).toEqual(expect.arrayContaining([
      'tag-ingest-freshness',
      'control-loop-confirmation',
      'api-tag-read-availability',
      'websocket-delivery',
      'historian-durability',
      'gateway-failover-rto',
      'database-recovery-rto',
    ]));
    expect(definitions.every(item =>
      item.owner.length > 0
      && item.sli.metric.includes('/')
      && item.sli.goodEvent.length > 0
      && item.runbook.endsWith('.md'))).toBe(true);
  });

  it('evaluates a rolling error budget and excludes out-of-window samples', () => {
    const registry = new SloRegistry(CRITICAL_PATH_SLOS, { now });
    const result = registry.evaluate('tag-ingest-freshness', [
      { timestamp: '2026-07-28T11:00:00.000Z', goodEvents: 9_995, totalEvents: 10_000 },
      { timestamp: '2026-01-01T00:00:00.000Z', goodEvents: 0, totalEvents: 1_000_000 },
    ]);

    expect(result.totalEvents).toBe(10_000);
    expect(result.sli).toBe(0.9995);
    expect(result.badEvents).toBe(5);
    expect(result.burnRate).toBeCloseTo(0.5);
    expect(result.errorBudgetRemaining).toBeCloseTo(0.5);
    expect(result.status).toBe('warning');
  });

  it('reports no-data honestly and rejects invalid counters', () => {
    const registry = new SloRegistry(CRITICAL_PATH_SLOS, { now });
    expect(registry.evaluate('historian-durability', [])).toMatchObject({
      status: 'no-data',
      sli: null,
      totalEvents: 0,
    });
    expect(() => registry.evaluate('historian-durability', [{
      timestamp: NOW.toISOString(),
      goodEvents: 2,
      totalEvents: 1,
    }])).toThrow(/good <= total/);
  });
});

describe('AutoRemediationEngine', () => {
  it('dry-runs without side effects and then executes with a distinct key', async () => {
    let replicas = 2;
    const setReplicas = vi.fn(async (_component: string, desired: number) => {
      replicas = desired;
    });
    const action = createScaleOutAction({
      currentReplicas: async () => replicas,
      setReplicas,
      readyReplicas: async () => replicas,
    });
    const engine = new AutoRemediationEngine([action], { cooldownMs: 0 }, { now });
    const context = { component: 'gateway', desiredReplicas: 4, maximumReplicas: 6 };

    const plan = await engine.execute({
      actionId: 'scale-out',
      context,
      idempotencyKey: 'scale-gateway-plan-1',
      dryRun: true,
    });
    expect(plan.status).toBe('planned');
    expect(setReplicas).not.toHaveBeenCalled();

    const result = await engine.execute({
      actionId: 'scale-out',
      context,
      idempotencyKey: 'scale-gateway-apply-1',
    });
    expect(result).toMatchObject({ status: 'succeeded', changed: true, verified: true });
    expect(setReplicas).toHaveBeenCalledTimes(1);
    expect(replicas).toBe(4);
  });

  it('reuses idempotent results and rejects key collisions', async () => {
    let replicas = 1;
    const action = createScaleOutAction({
      currentReplicas: async () => replicas,
      setReplicas: async (_component, desired) => { replicas = desired; },
      readyReplicas: async () => replicas,
    });
    const engine = new AutoRemediationEngine([action], { cooldownMs: 0 }, { now });
    const request = {
      actionId: 'scale-out',
      context: { component: 'api', desiredReplicas: 2, maximumReplicas: 4 },
      idempotencyKey: 'incident-123-scale',
    };

    const first = await engine.execute(request);
    const replay = await engine.execute(request);
    expect(first.reused).toBe(false);
    expect(replay.reused).toBe(true);
    expect(replay.executionId).toBe(first.executionId);
    await expect(engine.execute({
      ...request,
      context: { ...request.context, desiredReplicas: 3 },
    })).rejects.toThrow(/already used/);
  });

  it('blocks failover when no healthy peer can accept shards', async () => {
    const failover = vi.fn();
    const action = createGatewayFailoverAction({
      inspect: async () => ({ healthy: false, activeGatewayCount: 1, affectedShardCount: 8 }),
      failover,
      verifyCoverage: async () => true,
      restore: async () => undefined,
    });
    const engine = new AutoRemediationEngine([action], { cooldownMs: 0 }, { now });

    const result = await engine.execute({
      actionId: 'gateway-failover',
      context: { gatewayId: 'gw-1' },
      idempotencyKey: 'incident-456-failover',
    });
    expect(result.status).toBe('blocked');
    expect(result.message).toMatch(/no healthy peer/i);
    expect(failover).not.toHaveBeenCalled();
  });

  it('rolls back a change that fails post-change verification', async () => {
    let replicas = 2;
    const action = createScaleOutAction({
      currentReplicas: async () => replicas,
      setReplicas: async (_component, desired) => { replicas = desired; },
      readyReplicas: async () => 0,
    });
    const engine = new AutoRemediationEngine([action], { cooldownMs: 0 }, { now });

    const result = await engine.execute({
      actionId: 'scale-out',
      context: { component: 'historian', desiredReplicas: 4, maximumReplicas: 5 },
      idempotencyKey: 'incident-789-scale',
    });
    expect(result).toMatchObject({
      status: 'rolled-back',
      changed: false,
      verified: false,
      rollbackAttempted: true,
    });
    expect(replicas).toBe(2);
  });

  it('rechecks desired state immediately before mutation and never scales down', async () => {
    const setReplicas = vi.fn(async () => undefined);
    let inspection = 0;
    const action = createScaleOutAction({
      currentReplicas: async () => {
        inspection += 1;
        return inspection === 1 ? 1 : 5;
      },
      setReplicas,
      readyReplicas: async () => 5,
    });
    const engine = new AutoRemediationEngine([action], { cooldownMs: 0 }, { now });
    const result = await engine.execute({
      actionId: 'scale-out',
      context: { component: 'api', desiredReplicas: 3, maximumReplicas: 4 },
      idempotencyKey: 'concurrent-scale-out',
    });
    expect(result).toMatchObject({ status: 'skipped', changed: false });
    expect(result.message).toMatch(/scale-down is forbidden/);
    expect(setReplicas).not.toHaveBeenCalled();
  });

  it('requires an approver above the automatic risk ceiling', async () => {
    const dangerous: RemediationAction<Record<string, never>> = {
      id: 'promote-database',
      description: 'Promote a replica',
      risk: 'high',
      scope: () => 'primary',
      precondition: async () => ({ needed: true, safe: true, reason: 'primary unavailable' }),
      execute: async () => ({ changed: true, message: 'promoted' }),
    };
    const engine = new AutoRemediationEngine(
      [dangerous],
      { maxAutomaticRisk: 'medium', cooldownMs: 0 },
      { now },
    );

    const blocked = await engine.execute({
      actionId: dangerous.id,
      context: {},
      idempotencyKey: 'db-promote-unapproved',
    });
    expect(blocked.status).toBe('blocked');
    const approved = await engine.execute({
      actionId: dangerous.id,
      context: {},
      idempotencyKey: 'db-promote-approved',
      approvedBy: 'incident-commander@example.com',
    });
    expect(approved.status).toBe('succeeded');
    expect(engine.getAuditLog()).toHaveLength(2);
  });

  it('enforces the configured action allowlist', async () => {
    const action = createScaleOutAction({
      currentReplicas: async () => 1,
      setReplicas: async () => undefined,
      readyReplicas: async () => 2,
    });
    const engine = new AutoRemediationEngine(
      [action],
      { allowedActionIds: [], cooldownMs: 0 },
      { now },
    );
    const result = await engine.execute({
      actionId: action.id,
      context: { component: 'api', desiredReplicas: 2, maximumReplicas: 3 },
      idempotencyKey: 'not-allowlisted',
    });
    expect(result.status).toBe('blocked');
    expect(result.message).toMatch(/allowlist/);
  });

  it('starts cooldown at mutation time after a slow precondition', async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let firstPrecondition = true;
    const execute = vi.fn(async () => ({ changed: true, message: 'changed' }));
    const action: RemediationAction<Record<string, never>> = {
      id: 'slow-check',
      description: 'slow precondition',
      risk: 'low',
      scope: () => 'shared',
      precondition: async () => {
        if (firstPrecondition) {
          firstPrecondition = false;
          await gate;
        }
        return { needed: true, safe: true, reason: 'needed' };
      },
      execute,
    };
    const engine = new AutoRemediationEngine(
      [action],
      { cooldownMs: 60_000 },
      { now: () => new Date(clock) },
    );

    const first = engine.execute({
      actionId: action.id,
      context: {},
      idempotencyKey: 'slow-first',
    });
    clock = 10 * 60_000;
    release();
    expect((await first).status).toBe('succeeded');
    const second = await engine.execute({
      actionId: action.id,
      context: {},
      idempotencyKey: 'slow-second',
    });
    expect(second.status).toBe('blocked');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('snapshots request context and cached results across async boundaries', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let observed = 0;
    const action: RemediationAction<{ desired: number }> = {
      id: 'snapshot',
      description: 'snapshot input',
      risk: 'low',
      scope: () => 'shared',
      precondition: async () => {
        await gate;
        return { needed: true, safe: true, reason: 'needed' };
      },
      execute: async context => {
        observed = context.desired;
        return { changed: true, message: 'changed' };
      },
    };
    const engine = new AutoRemediationEngine([action], { cooldownMs: 0 }, { now });
    const context = { desired: 2 };
    const request = { actionId: action.id, context, idempotencyKey: 'snapshot-1' };
    const running = engine.execute(request);
    context.desired = 99;
    release();
    const result = await running;
    expect(observed).toBe(2);
    result.status = 'failed';
    expect((await engine.execute({ ...request, context: { desired: 2 } })).status).toBe('succeeded');
  });
});

describe('RemediationRuntime', () => {
  it('fails closed until adapters are configured and durably audits execution', async () => {
    const runtime = new RemediationRuntime();
    await expect(runtime.execute({
      actionId: 'scale-out',
      context: { component: 'api', desiredReplicas: 2, maximumReplicas: 3 },
      idempotencyKey: 'runtime-unconfigured',
    })).rejects.toBeInstanceOf(RemediationRuntimeUnavailableError);

    let replicas = 1;
    const append = vi.fn(async () => undefined);
    runtime.configure({
      scaleOut: {
        currentReplicas: async () => replicas,
        setReplicas: async (_component, value) => { replicas = value; },
        readyReplicas: async () => replicas,
      },
      auditSink: { append },
      policy: { cooldownMs: 0 },
    });
    const result = await runtime.execute({
      actionId: 'scale-out',
      context: { component: 'api', desiredReplicas: 2, maximumReplicas: 3 },
      idempotencyKey: 'runtime-configured',
    });
    expect(result.status).toBe('succeeded');
    expect(runtime.status()).toMatchObject({
      configured: true,
      actions: [{ id: 'scale-out' }],
    });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      executionId: result.executionId,
      status: 'succeeded',
    }));
  });

  it('surfaces durable audit failure after preserving the idempotent action result', async () => {
    let replicas = 1;
    let failAudit = true;
    const runtime = new RemediationRuntime();
    runtime.configure({
      scaleOut: {
        currentReplicas: async () => replicas,
        setReplicas: async (_component, value) => { replicas = value; },
        readyReplicas: async () => replicas,
      },
      auditSink: {
        append: async () => {
          if (failAudit) throw new Error('disk unavailable');
        },
      },
      policy: { cooldownMs: 0 },
    });
    const request = {
      actionId: 'scale-out',
      context: { component: 'api', desiredReplicas: 2, maximumReplicas: 3 },
      idempotencyKey: 'audit-retry',
    };
    await expect(runtime.execute(request)).rejects.toBeInstanceOf(RemediationAuditPersistenceError);
    expect(replicas).toBe(2);
    failAudit = false;
    const replay = await runtime.execute(request);
    expect(replay).toMatchObject({ status: 'succeeded', reused: true });
  });
});
