/**
 * Single service startup path (#10).
 *
 * `server/services/index.ts` exported `initializeServices()` and
 * `getServicesHealthStatus()` that nothing called, while `registerRoutes` started
 * services one at a time with `void <service>.initialize()`. Two half-paths meant
 * neither was authoritative: services in the exported list were never started,
 * and services started by routes.ts were never health-reported.
 *
 * These tests boot the service layer through the one remaining path and assert
 * each registered service actually reports `healthy: true` from its own
 * `healthCheck()` — not that a list has entries. The expected roster is spelled
 * out here rather than derived from `MANAGED_SERVICES`, so dropping a service
 * from the boot list fails this suite instead of quietly shrinking its own oracle.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MANAGED_SERVICES,
  getServicesHealthStatus,
  initializeServices,
} from '../index';
// Imported from their own modules, not through the barrel: this is what proves
// the boot path initialized the same singleton instance that server/routes.ts
// and the route handlers hold (#541).
import { alarmCorrelationService } from '../alarm-correlation';
import { complianceService } from '../compliance';
import { geometryService } from '../geometry';
import { marketplaceService } from '../marketplace';
import { nlQueryService } from '../nlquery';
import { optimizationService } from '../optimization';
import { predictiveMaintenanceService } from '../predictive';
import { spcService } from '../spc';
import { tuningService } from '../tuning';
import { digitalTwinService } from '../twin';

const SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(new URL('../index.ts', import.meta.url))),
  '..',
);

/**
 * The comment each ad-hoc `initialize()` call carried. Assembled at runtime so
 * this guard is not itself a hit for the repo-wide grep it enforces.
 */
const WORKAROUND_MARKER = ['has no callers', 'at startup'].join(' ');

function typeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

/**
 * Every service the platform must start at boot, in the order it must start
 * them. Independent of MANAGED_SERVICES on purpose.
 */
const EXPECTED_SERVICES = [
  'compliance',
  'geometry',
  'optimization',
  'spc',
  'alarmCorrelation',
  'twin',
  'predictive',
  'tuning',
  'marketplace',
  'nlquery',
] as const;

/** The services `registerRoutes` used to start ad hoc, before #10. */
const PREVIOUSLY_AD_HOC = [
  'compliance',
  'predictive',
  'alarmCorrelation',
  'twin',
  'tuning',
  'marketplace',
  'nlquery',
] as const;

let sqliteDirectory: string;
const originalEnv = {
  sqlitePath: process.env.SQLITE_DATABASE_PATH,
  approvers: process.env.PID_TUNING_APPROVERS,
};

beforeAll(async () => {
  // Durable stores back predictive thresholds and the tuning audit trail; point
  // them at a scratch SQLite file so the boot exercised here is the real one.
  sqliteDirectory = await mkdtemp(path.join(tmpdir(), 'oxscada-startup-'));
  process.env.SQLITE_DATABASE_PATH = path.join(sqliteDirectory, 'startup.sqlite');
  // Tuning reports unhealthy with an empty approver allowlist by design: the
  // feature would be mounted with no principal able to approve a gain change.
  process.env.PID_TUNING_APPROVERS = 'startup-test-approver';

  await initializeServices();
}, 60_000);

afterAll(async () => {
  for (const shutdown of [
    () => tuningService.shutdown(),
    () => predictiveMaintenanceService.shutdown(),
    () => alarmCorrelationService.shutdown(),
    () => marketplaceService.shutdown(),
    () => nlQueryService.shutdown(),
    () => digitalTwinService.shutdown(),
  ]) {
    await shutdown().catch(() => { /* best effort */ });
  }
  if (originalEnv.sqlitePath === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = originalEnv.sqlitePath;
  if (originalEnv.approvers === undefined) delete process.env.PID_TUNING_APPROVERS;
  else process.env.PID_TUNING_APPROVERS = originalEnv.approvers;
  // The predictive store keeps its connection open for the life of the process
  // by design — no shutdown() closes it — so on Windows the scratch file is
  // still locked here. Losing a temp directory is not a test result.
  await rm(sqliteDirectory, { recursive: true, force: true })
    .catch(() => { /* OS temp cleanup will collect it */ });
});

describe('#10 — booting the service layer starts every registered service', () => {
  it('registers exactly the expected roster, in dependency order', () => {
    expect(MANAGED_SERVICES.map((entry) => entry.key)).toEqual([...EXPECTED_SERVICES]);
  });

  it.each([...EXPECTED_SERVICES])(
    'reports %s healthy after initializeServices()',
    async (key) => {
      const health = await getServicesHealthStatus();
      const status = health[key];

      expect(status, `no health entry for "${key}"`).toBeDefined();
      expect(
        status.healthy,
        `${key} is registered in the startup path but reports: ${status.message}`,
      ).toBe(true);
      expect(status.message).not.toBe('');
    },
  );

  it('health-reports every service it boots, and nothing it does not', async () => {
    const health = await getServicesHealthStatus();
    expect(Object.keys(health).sort()).toEqual([...EXPECTED_SERVICES].sort());
  });

  it('initialized the same singleton instances the routes hold', async () => {
    // Read each service's own healthCheck() directly rather than through the
    // aggregate: a second module instance would report "not initialized" here
    // while the aggregate still looked green.
    const direct = await Promise.all([
      complianceService.healthCheck(),
      geometryService.healthCheck(),
      optimizationService.healthCheck(),
      spcService.healthCheck(),
      alarmCorrelationService.healthCheck(),
      digitalTwinService.healthCheck(),
      predictiveMaintenanceService.healthCheck(),
      tuningService.healthCheck(),
      marketplaceService.healthCheck(),
      nlQueryService.healthCheck(),
    ]);

    expect(direct).toHaveLength(EXPECTED_SERVICES.length);
    for (const status of direct) {
      expect(status.healthy, status.message).toBe(true);
    }
  });

  it('is idempotent — a second boot leaves every service healthy', async () => {
    await initializeServices();

    const health = await getServicesHealthStatus();
    const unhealthy = Object.entries(health)
      .filter(([, status]) => !status.healthy)
      .map(([key, status]) => `${key}: ${status.message}`);

    expect(unhealthy).toEqual([]);
  });
});

describe('#10 — the startup path is the only startup path', () => {
  const routesSource = readFileSync(path.join(SERVER_DIR, 'routes.ts'), 'utf8');
  const bootSource = readFileSync(path.join(SERVER_DIR, 'index.ts'), 'utf8');

  it('adopted every service registerRoutes used to start ad hoc', () => {
    const registered = MANAGED_SERVICES.map((entry) => entry.key);
    for (const key of PREVIOUSLY_AD_HOC) {
      expect(registered, `${key} was dropped from the startup path`).toContain(key);
    }
  });

  it('leaves no initialize() call in registerRoutes', () => {
    expect(routesSource).not.toMatch(/\.initialize\(\)/);
  });

  it('leaves the workaround comment nowhere under server/', () => {
    const offenders = typeScriptFiles(SERVER_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes(WORKAROUND_MARKER))
      .map((file) => path.relative(SERVER_DIR, file).replaceAll('\\', '/'));

    expect(offenders).toEqual([]);
  });

  it('keeps httpServer-scoped wiring in registerRoutes', () => {
    // Order-sensitive hooks that need the HTTP server must NOT have moved.
    expect(routesSource).toContain('tagStreamServer.onTagUpdate');
    expect(routesSource).toContain('digitalTwinService.shutdown()');
    expect(routesSource).toContain('tuningService.shutdown()');
    expect(routesSource).toContain('nlQueryService.shutdown()');
    expect(routesSource).toContain('complianceService.registerCollector');
  });

  it('calls initializeServices() exactly once from the boot sequence', () => {
    expect(bootSource).toContain('initializeServices');
    expect([...bootSource.matchAll(/await initializeServices\(\)/g)]).toHaveLength(1);
  });
});

describe('#10 — getServicesHealthStatus is wired into the health surface', () => {
  it('is registered as a health check, not left half-alive', () => {
    const healthSource = readFileSync(path.join(SERVER_DIR, 'health', 'index.ts'), 'utf8');
    expect(healthSource).toContain('getServicesHealthStatus');
    expect(healthSource).toMatch(/name: 'services'/);
  });

  it('reports an unhealthy service by name so an operator can act on it', async () => {
    // A service that has been shut down is the observable stand-in for one that
    // failed to boot: the aggregate must name it rather than average it away.
    await nlQueryService.shutdown();
    try {
      const health = await getServicesHealthStatus();
      expect(health.nlquery.healthy).toBe(false);
      expect(health.nlquery.message).toMatch(/not initialized/i);
    } finally {
      await nlQueryService.initialize();
    }
  });
});
