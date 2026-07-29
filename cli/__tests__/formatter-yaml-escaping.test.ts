/**
 * YAML scalar escaping in the CLI formatter (CodeQL js/incomplete-sanitization #24).
 *
 * `oxscada ... -o yaml` output gets piped into other tools, and the values in it
 * come from API responses rather than from the operator typing them. The quoted
 * branch escaped `\`, `"` and `\n` but left every other control character raw.
 *
 * A raw carriage return inside a double-quoted scalar is invalid YAML: the
 * parser treats it as a line ending, so the document truncates there and every
 * key after it silently disappears. Silent truncation is the bad outcome — the
 * consumer gets a well-formed document that is missing data.
 */

import { describe, expect, it } from "vitest";

import {
  formatYaml,
  hasControlCharacter,
  quoteYamlString,
} from "../src/lib/formatter.js";

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe("hasControlCharacter", () => {
  it("is false for ordinary and non-ASCII text", () => {
    expect(hasControlCharacter("")).toBe(false);
    expect(hasControlCharacter("PUMP-1 online")).toBe(false);
    expect(hasControlCharacter("Störung — 温度 ⚠")).toBe(false);
  });

  it("is true for every C0 control character and DEL", () => {
    expect(hasControlCharacter("a\nb")).toBe(true);
    expect(hasControlCharacter("a\rb")).toBe(true);
    expect(hasControlCharacter("a\tb")).toBe(true);
    expect(hasControlCharacter(`a${NUL}b`)).toBe(true);
    expect(hasControlCharacter(`a${ESC}b`)).toBe(true);
    expect(hasControlCharacter(`a${DEL}b`)).toBe(true);
  });
});

describe("quoteYamlString", () => {
  it("escapes the backslash BEFORE anything it adds", () => {
    // Order matters: escaping quotes first would turn `\` + `"` into `\\"`,
    // which re-escapes the backslash the second pass just introduced.
    expect(quoteYamlString('a\\b"c')).toBe('"a\\\\b\\"c"');
  });

  it("leaves a literal backslash-n distinguishable from a real newline", () => {
    expect(quoteYamlString("a\\nb")).toBe('"a\\\\nb"');
    expect(quoteYamlString("a\nb")).toBe('"a\\nb"');
  });

  it("escapes carriage return, which would otherwise truncate the document", () => {
    const quoted = quoteYamlString("visible\rhidden");
    expect(quoted).toBe('"visible\\rhidden"');
    expect(quoted).not.toContain("\r");
  });

  it("escapes tab, ANSI escapes, NUL and DEL", () => {
    expect(quoteYamlString("a\tb")).toBe('"a\\tb"');
    expect(quoteYamlString(`${ESC}[31m`)).toBe('"\\u001b[31m"');
    expect(quoteYamlString(`a${NUL}b`)).toBe('"a\\u0000b"');
    expect(quoteYamlString(`a${DEL}b`)).toBe('"a\\u007fb"');
  });

  it("passes non-ASCII through unharmed", () => {
    expect(quoteYamlString("Störung — 温度 ⚠")).toBe('"Störung — 温度 ⚠"');
  });
});

describe("formatYaml routes control characters into the quoted branch", () => {
  it("emits no raw control character for a value carrying one", () => {
    const yaml = formatYaml({ detail: "refused\rall clear" });
    expect(yaml).toContain("\\r");
    expect(yaml.split("\n")).toHaveLength(1);
  });

  it("still quotes the cases it always did", () => {
    expect(formatYaml("value: with colon")).toContain('"');
    expect(formatYaml("true")).toContain('"');
    expect(formatYaml("123")).toContain('"');
  });

  it("leaves a plain value unquoted", () => {
    expect(formatYaml("online")).toBe("online");
  });
});
