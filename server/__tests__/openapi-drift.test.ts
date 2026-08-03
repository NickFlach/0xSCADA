/**
 * OpenAPI drift gate (#54).
 *
 * docs/openapi.yaml validated as a document while silently not describing the
 * tuning, marketplace, or intelligence surfaces at all — anyone generating a
 * client got a server that no longer exists. This gate enumerates the Express
 * routes ACTUALLY mounted for those families (from the routers' own stacks,
 * the same objects server/routes.ts mounts) and fails when a mounted route is
 * absent from the spec — so the next service PR cannot silently skip
 * documentation.
 *
 * The enumeration is live: add a route to one of these routers and this test
 * fails until docs/openapi.yaml documents it. Express `:param` segments are
 * translated to OpenAPI `{param}` style.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import type { Router } from 'express';
import { tuningRoutes } from '../routes/tuning';
import { marketplaceRoutes } from '../routes/marketplace';
import { intelligenceRoutes } from '../routes/intelligence';

interface RouteEntry {
  method: string;
  path: string;
}

/** Enumerate METHOD + path for every route layer on an Express 4 router. */
function mountedRoutes(router: Router, prefix: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const stack = (router as unknown as {
    stack: Array<{
      route?: { path: string; methods: Record<string, boolean> };
    }>;
  }).stack;

  for (const layer of stack) {
    if (!layer.route) continue;
    const openapiPath = prefix + layer.route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) out.push({ method: method.toUpperCase(), path: openapiPath });
    }
  }
  return out;
}

const spec = load(
  readFileSync(resolve(__dirname, '../../docs/openapi.yaml'), 'utf8'),
) as { paths?: Record<string, Record<string, unknown>> };

const specPaths = spec.paths ?? {};

const families: Array<{ name: string; router: Router; prefix: string }> = [
  { name: 'tuning', router: tuningRoutes, prefix: '/api/tuning' },
  { name: 'marketplace', router: marketplaceRoutes, prefix: '/api/marketplace' },
  { name: 'intelligence', router: intelligenceRoutes, prefix: '/api/intelligence' },
];

describe('OpenAPI drift gate (#54): mounted routes must be documented', () => {
  it('enumerates a sane number of mounted routes (guard against a broken scan)', () => {
    const total = families.reduce(
      (n, f) => n + mountedRoutes(f.router, f.prefix).length,
      0,
    );
    // 12 tuning + 16 marketplace + 9 intelligence as of #54 — a floor, not a pin.
    expect(total).toBeGreaterThanOrEqual(30);
  });

  for (const family of families) {
    it(`every mounted /api/${family.name} route appears in docs/openapi.yaml`, () => {
      const missing: string[] = [];
      for (const { method, path } of mountedRoutes(family.router, family.prefix)) {
        const doc = specPaths[path];
        if (!doc || !(method.toLowerCase() in doc)) {
          missing.push(`${method} ${path}`);
        }
      }
      expect(
        missing,
        `mounted but undocumented in docs/openapi.yaml — add them (or retire the route)`,
      ).toEqual([]);
    });
  }
});
