/**
 * Regression guard for #638.
 *
 * Ubiquity and L2 Rollup had no consumers or real backends. They nevertheless
 * started timers, manufactured operator-shaped results, and called themselves
 * healthy. Neither may remain importable or participate in the generic service
 * lifecycle.
 *
 * Compliance had the same defect, but #632 landed an evidence-backed
 * certification toolkit in its place before this change, so it is kept and is
 * instead held to the PRNG guard below like every other lifecycle service.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as services from '../index';
import { getServicesHealthStatus, serviceRegistry } from '../index';

const SERVICES_DIR = path.dirname(fileURLToPath(new URL('../index.ts', import.meta.url)));
const SERVICE_INDEX_SOURCE = readFileSync(path.join(SERVICES_DIR, 'index.ts'), 'utf8');
const LIFECYCLE_START = SERVICE_INDEX_SOURCE.indexOf(
  'export async function initializeServices',
);
const LIFECYCLE_END = SERVICE_INDEX_SOURCE.indexOf(
  'export const serviceRegistry',
);
const LIFECYCLE_SOURCE = SERVICE_INDEX_SOURCE.slice(LIFECYCLE_START, LIFECYCLE_END);

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionTypeScriptFiles(absolute);
    }
    return entry.isFile()
      && entry.name.endsWith('.ts')
      && !entry.name.endsWith('.test.ts')
      ? [absolute]
      : [];
  });
}

describe('#638 — fabricated services are absent from the platform lifecycle', () => {
  it.each(['ubiquity', 'l2-rollup'])(
    'deletes the unused %s service',
    (name) => {
      expect(existsSync(path.join(SERVICES_DIR, name, 'index.ts'))).toBe(false);
      expect(existsSync(path.join(SERVICES_DIR, `${name}.ts`))).toBe(false);
    },
  );

  it('cannot import any deleted service', async () => {
    await expect(import('../ubiquity')).rejects.toThrow();
    await expect(import('../l2-rollup')).rejects.toThrow();
  });

  it('exports no deleted service symbols from the barrel', () => {
    const exported = Object.keys(services);
    expect(exported).not.toContain('UbiquityService');
    expect(exported).not.toContain('ubiquityService');
    expect(exported).not.toContain('L2RollupService');
    expect(exported).not.toContain('l2RollupService');
  });

  it('offers no fabricated service through dynamic lookup', () => {
    expect(Object.keys(serviceRegistry)).not.toContain('ubiquity');
    expect(Object.keys(serviceRegistry)).not.toContain('l2Rollup');
  });

  it('does not boot or health-check Ubiquity or L2 Rollup', async () => {
    expect(LIFECYCLE_START).toBeGreaterThanOrEqual(0);
    expect(LIFECYCLE_END).toBeGreaterThan(LIFECYCLE_START);
    expect(LIFECYCLE_SOURCE).not.toMatch(/import\(['"]\.\/ubiquity['"]\)/);
    expect(LIFECYCLE_SOURCE).not.toMatch(/import\(['"]\.\/l2-rollup['"]\)/);

    const health = await getServicesHealthStatus();
    expect(Object.keys(health)).not.toContain('ubiquity');
    expect(Object.keys(health)).not.toContain('l2Rollup');
  });

  it('keeps the evidence-backed compliance service in the lifecycle (#632)', async () => {
    expect(existsSync(path.join(SERVICES_DIR, 'compliance', 'index.ts'))).toBe(true);
    expect(Object.keys(services)).toContain('complianceService');
    expect(Object.keys(serviceRegistry)).toContain('compliance');
    expect(LIFECYCLE_SOURCE).toMatch(/import\(['"]\.\/compliance['"]\)/);
    expect(Object.keys(await getServicesHealthStatus())).toContain('compliance');
  });
});

describe('#638 — a lifecycle service cannot fabricate results with a PRNG', () => {
  it('allows no PRNG in any service entry point', () => {
    const serviceEntryPoints = readdirSync(SERVICES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
      .map((entry) => path.join(SERVICES_DIR, entry.name, 'index.ts'))
      .filter(existsSync);
    const offenders = serviceEntryPoints
      .filter((file) => /Math\s*\.\s*random\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SERVICES_DIR, file).replaceAll('\\', '/'));

    expect(offenders).toEqual([]);
  });

  it('finds no Math.random call in any booted or health-reported module', () => {
    const lifecycleModules = [
      ...LIFECYCLE_SOURCE.matchAll(/import\(['"]\.\/([^'"]+)['"]\)/g),
    ].map((match) => match[1]);
    const uniqueModules = [...new Set(lifecycleModules)];

    expect(uniqueModules.length).toBeGreaterThan(0);
    const offenders = uniqueModules.flatMap((moduleName) => {
      const moduleDirectory = path.join(SERVICES_DIR, moduleName);
      const files = existsSync(moduleDirectory)
        ? productionTypeScriptFiles(moduleDirectory)
        : [path.join(SERVICES_DIR, `${moduleName}.ts`)];

      return files
        .filter((file) => /Math\s*\.\s*random\s*\(/.test(readFileSync(file, 'utf8')))
        .map((file) => path.relative(SERVICES_DIR, file).replaceAll('\\', '/'));
    });

    expect(offenders).toEqual([]);
  });
});
