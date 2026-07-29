/**
 * The non-`/api` surfaces that touch the filesystem must stay rate-limited
 * (CodeQL js/missing-rate-limiting #2, #3, #15, #122).
 *
 * Each of `static.ts`, `vite.ts` and `swagger.ts` already ran the hand-rolled
 * `rateLimitMiddleware`, which is the real bound — it can be Redis-backed and
 * so applies fleet-wide. It is invisible to static analysis, so each of them
 * also runs an `express-rate-limit` limiter at the same window and limit.
 *
 * The regression this guards against is someone deleting the second limiter as
 * redundant. It is not redundant: it is the only one a scanner can see, and
 * being per-process it is the one that still holds when Redis is unavailable.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { swaggerRouter } from "../swagger";

const SERVER_DIR = path.dirname(fileURLToPath(new URL("../swagger.ts", import.meta.url)));

const GUARDED_MODULES = ["static.ts", "vite.ts", "swagger.ts"] as const;

/**
 * Names bound to `factory(...)` in this source, that are also referenced
 * somewhere else in it.
 *
 * Counting references, not just the declaration, is the whole point: a limiter
 * that is constructed and never passed to `use()`/`get()` reads exactly like a
 * working one, and an assertion that only matched `factory(` would pass while
 * the surface sat wide open.
 */
function installedLimiters(source: string, factory: string): string[] {
  const declarations = [...source.matchAll(
    new RegExp(`const\\s+(\\w+)\\s*=\\s*${factory}\\(`, "g"),
  )].map((match) => match[1]);

  return declarations.filter((name) => {
    const uses = source.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
    return uses.length > 1;
  });
}

describe("scanner-visible limiters are wired on every filesystem surface", () => {
  it.each(GUARDED_MODULES)("%s imports express-rate-limit", (file) => {
    const source = readFileSync(path.join(SERVER_DIR, file), "utf8");
    expect(source).toMatch(/from ['"]express-rate-limit['"]/);
  });

  it.each(GUARDED_MODULES)("%s installs an express-rate-limit limiter", (file) => {
    const source = readFileSync(path.join(SERVER_DIR, file), "utf8");
    // Either bound to a name that is then used, or passed inline to `use(`.
    const named = installedLimiters(source, "expressRateLimit").length > 0;
    const inline = /use\(\s*\n?\s*expressRateLimit\(\{/.test(source);
    expect(named || inline).toBe(true);
  });

  it.each(GUARDED_MODULES)("%s still installs the real Redis-capable limiter", (file) => {
    // The express-rate-limit layer is a backstop, not a replacement: dropping
    // `rateLimitMiddleware` would silently narrow the bound to one process.
    const source = readFileSync(path.join(SERVER_DIR, file), "utf8");
    expect(installedLimiters(source, "rateLimitMiddleware")).not.toEqual([]);
  });
});

describe("the swagger router actually rejects a flood", () => {
  // A real socket rather than an injected request: the limiter keys on the
  // client address, which only exists on a genuine connection.
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use("/api/docs", swaggerRouter);
    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 429 once the window limit is exceeded", async () => {
    const limit = 100;
    let sawTooManyRequests = false;

    // The two limiters share a 60s window, so a single pass past the limit is
    // enough — nothing resets between iterations.
    for (let i = 0; i < limit + 5; i += 1) {
      const res = await fetch(`${baseUrl}/api/docs/openapi.yaml`);
      await res.arrayBuffer();
      if (res.status === 429) {
        sawTooManyRequests = true;
        break;
      }
    }

    expect(sawTooManyRequests).toBe(true);
  }, 30_000);
});
