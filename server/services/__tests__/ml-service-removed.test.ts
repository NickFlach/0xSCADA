/**
 * Regression guard for #605 — `server/services/ml` is gone, not merely unwired.
 *
 * The removed service fabricated every number it produced: inference was
 * `setTimeout(resolve, 50)` followed by `Math.random()` anomaly/maintenance
 * scores and a `0.7 + Math.random() * 0.3` confidence, and "training" was
 * `setTimeout(resolve, 2000)` followed by `accuracy = 0.85 + Math.random()*0.1`.
 * #599 removed its only HTTP exposure; it was still constructed at import time
 * by the services barrel, still listed in the boot sequence, and still reported
 * `healthy: true` in the aggregate health surface.
 *
 * These assertions are about the platform's honesty, not about tidiness:
 *  - nothing may be able to import an `mlService` symbol and treat it as real;
 *  - the aggregate health surface may not name an ML subsystem, because there
 *    is none to report on.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as services from '../index';
import { getServicesHealthStatus, serviceRegistry } from '../index';

const SERVICES_DIR = path.dirname(fileURLToPath(new URL('../index.ts', import.meta.url)));

describe('#605 — the fabricating ML service is removed', () => {
  it('has no ml module on disk', () => {
    expect(existsSync(path.join(SERVICES_DIR, 'ml'))).toBe(false);
    expect(existsSync(path.join(SERVICES_DIR, 'ml.ts'))).toBe(false);
  });

  it('cannot be imported, so no boot entry or future caller can resurrect it', async () => {
    await expect(import('../ml')).rejects.toThrow();
  });

  it('exports no ML symbol from the services barrel', () => {
    const exported = Object.keys(services);
    expect(exported).not.toContain('mlService');
    expect(exported).not.toContain('MLService');
    // The barrel re-exported the service's whole type/value surface with
    // `export * from './ml'`; check the value-side leftovers are gone too.
    expect(exported.filter((name) => /^ml/i.test(name))).toEqual([]);
  });

  it('has no ml entry in the dynamic service registry', () => {
    expect(Object.keys(serviceRegistry)).not.toContain('ml');
  });
});

describe('#605 — the aggregate health surface makes no ML claim', () => {
  it('reports no ml subsystem at all', async () => {
    const health = await getServicesHealthStatus();

    expect(Object.keys(health)).not.toContain('ml');
    for (const [name, entry] of Object.entries(health)) {
      expect(name.toLowerCase()).not.toContain('ml');
      expect(entry.message.toLowerCase()).not.toContain('ml service');
      expect(entry.message.toLowerCase()).not.toContain('models ready');
    }
  });

  it('only reports on subsystems that exist in server/services', async () => {
    // A health key with no module behind it is the defect this issue is about:
    // an operator-facing claim about a capability the process does not have.
    const moduleForHealthKey: Record<string, string> = {
      cache: 'cache',
      compliance: 'compliance',
      flux: 'flux',
      geometry: 'geometry',
      ubiquity: 'ubiquity',
      l2Rollup: 'l2-rollup',
      optimization: 'optimization',
      spc: 'spc',
      twin: 'twin',
      predictive: 'predictive',
      tuning: 'tuning',
      marketplace: 'marketplace',
      // Joined the reported surface with the single startup path (#10); both
      // were already started ad hoc by registerRoutes.
      alarmCorrelation: 'alarm-correlation',
      nlquery: 'nlquery',
    };

    const health = await getServicesHealthStatus();

    for (const key of Object.keys(health)) {
      const dir = moduleForHealthKey[key];
      expect(dir, `health surface reports unknown subsystem "${key}"`).toBeDefined();
      expect(
        existsSync(path.join(SERVICES_DIR, dir as string)),
        `health key "${key}" has no module at server/services/${dir}`,
      ).toBe(true);
    }
  });
});
