/**
 * YAML scalar escaping in the served OpenAPI spec (CodeQL js/incomplete-sanitization #14).
 *
 * `jsonToYaml` quoted a value only when it contained `:`, `#`, or started with
 * `*`, and even then escaped just `\` and `"`. Every other control character
 * went through raw.
 *
 * That matters because the spec is enriched at runtime from gateway
 * configuration — CORS origins, route descriptions — so the values are not all
 * authored by hand. A raw carriage return inside a quoted scalar is invalid
 * YAML: the parser treats it as a line ending, so the document truncates there
 * and every path after it silently vanishes from the served spec. A consumer
 * generating a client gets a well-formed document that is missing endpoints.
 *
 * `jsonToYaml` is module-private, so these drive it through the public
 * `registerSwaggerRoutes` surface via the `/openapi.yaml` route.
 */

import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerSwaggerRoutes } from "../swagger-ui";

const ESC = String.fromCharCode(27);

let server: Server;
let baseUrl: string;

/** Fetch the served spec as text. */
async function servedYaml(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/docs/openapi.yaml`);
  return res.text();
}

beforeAll(async () => {
  const app = express();
  registerSwaggerRoutes(app);
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

describe("the served OpenAPI YAML carries no raw control characters", () => {
  it("responds with a spec at all", async () => {
    const yaml = await servedYaml();
    expect(yaml.length).toBeGreaterThan(0);
    expect(yaml).toMatch(/openapi:/);
  });

  it("contains no bare carriage return or C0 control character", async () => {
    // `\n` is the line separator and is expected; nothing else should appear.
    const yaml = await servedYaml();
    const offenders = [...yaml].filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (code < 32 && char !== "\n") || code === 127;
    });
    expect(offenders).toEqual([]);
  });

  it("parses as a sequence of complete lines, none truncated mid-value", async () => {
    const yaml = await servedYaml();
    // A truncating control character would leave a line ending inside what
    // should have been one scalar, producing an unbalanced quote count.
    for (const line of yaml.split("\n")) {
      const quotes = (line.match(/(?<!\\)"/g) ?? []).length;
      expect(quotes % 2).toBe(0);
    }
  });

  it("escapes a control character injected through a description", async () => {
    // Exercised directly rather than through config, so the assertion does not
    // depend on which gateway options happen to be set in this environment.
    const { quoteYamlStringForTest } = await import("../swagger-ui");
    expect(quoteYamlStringForTest("a\rb")).toBe('"a\\rb"');
    expect(quoteYamlStringForTest(`x${ESC}[0m`)).toBe('"x\\u001b[0m"');
    expect(quoteYamlStringForTest('a\\b"c')).toBe('"a\\\\b\\"c"');
  });
});
