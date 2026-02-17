import { describe, it, expect, beforeEach } from 'vitest';
import { HealthManager } from '../health-manager';

describe('HealthManager', () => {
  let hm: HealthManager;

  beforeEach(() => {
    hm = new HealthManager(0); // no cache
  });

  it('returns healthy when no checks registered', async () => {
    const h = await hm.checkAll();
    expect(h.status).toBe('healthy');
    expect(h.services).toHaveLength(0);
  });

  it('returns healthy when all checks pass', async () => {
    hm.registerSimple('db', async () => true);
    hm.registerSimple('cache', async () => true, false);
    const h = await hm.checkAll();
    expect(h.status).toBe('healthy');
    expect(h.services).toHaveLength(2);
  });

  it('returns unhealthy when a required check fails', async () => {
    hm.registerSimple('db', async () => false, true);
    const h = await hm.checkAll();
    expect(h.status).toBe('unhealthy');
  });

  it('returns degraded when optional check fails', async () => {
    hm.registerSimple('db', async () => true, true);
    hm.registerSimple('cache', async () => false, false);
    const h = await hm.checkAll();
    expect(h.status).toBe('degraded');
  });

  it('respects dependency ordering', async () => {
    const order: string[] = [];
    hm.register({
      name: 'b',
      required: false,
      dependencies: ['a'],
      check: async () => { order.push('b'); return { name: 'b', status: 'healthy', lastCheck: new Date() }; },
    });
    hm.register({
      name: 'a',
      required: true,
      check: async () => { order.push('a'); return { name: 'a', status: 'healthy', lastCheck: new Date() }; },
    });
    await hm.checkAll();
    expect(order).toEqual(['a', 'b']);
  });

  it('handles check timeout', async () => {
    hm.register({
      name: 'slow',
      required: true,
      check: () => new Promise(() => {}), // never resolves
    });
    const h = await hm.checkAll();
    expect(h.status).toBe('unhealthy');
    expect(h.services[0].message).toContain('timeout');
  });

  it('isReady returns true when healthy', async () => {
    hm.registerSimple('db', async () => true);
    expect(await hm.isReady()).toBe(true);
  });

  it('isAlive always returns true', () => {
    expect(hm.isAlive()).toBe(true);
  });

  it('createRouter returns a router with expected routes', () => {
    const router = hm.createRouter();
    const routes = (router as any).stack.map((l: any) => l.route?.path).filter(Boolean);
    expect(routes).toContain('/healthz');
    expect(routes).toContain('/readyz');
    expect(routes).toContain('/health');
  });
});
