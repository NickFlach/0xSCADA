/**
 * The type-name header regexes in the three markdown parsers.
 *
 * These matched `\s*` around the header keywords, and `\s` matches newlines, so
 * a header could span lines — and the trailing `\s*` overlapped the `(.+)`
 * capture that followed it, which is what CodeQL flags as `js/polynomial-redos`
 * (alerts #181-183). Blueprint files are uploaded, so the input is untrusted.
 *
 * These cases pin the behaviour the narrowed regexes must keep: every
 * well-formed spelling of the header still parses, including the padded and
 * unspaced ones, and the name is still trimmed. They also pin the one thing
 * that deliberately changed — a header is now a single line.
 */

import { describe, expect, it } from "vitest";

import { parseCMTypeMarkdown } from "../cm-type-parser";
import { parsePhaseTypeMarkdown } from "../phase-type-parser";
import { parseUnitTypeMarkdown } from "../unit-type-parser";

/** `[parser, keyword]` — the header differs only in the keyword. */
const PARSERS = [
  [parseCMTypeMarkdown, "CM"],
  [parsePhaseTypeMarkdown, "PHASE"],
  [parseUnitTypeMarkdown, "UNIT"],
] as const;

describe.each(PARSERS)("%o header matching (%s TYPE)", (parse, keyword) => {
  it("accepts the ordinary spelling", () => {
    expect(parse(`# ${keyword} TYPE: Widget`)?.name).toBe("Widget");
  });

  it("accepts the header with no spaces at all", () => {
    expect(parse(`#${keyword}TYPE:Widget`)?.name).toBe("Widget");
  });

  it("trims padding on both sides of the name", () => {
    expect(parse(`#   ${keyword}   TYPE:    Widget   `)?.name).toBe("Widget");
  });

  it("finds the header part-way through a document", () => {
    const content = `Some prose.\n\n# ${keyword} TYPE: Valve\n\n## Inputs\n`;
    expect(parse(content)?.name).toBe("Valve");
  });

  it("rejects a header with no name", () => {
    expect(parse(`# ${keyword} TYPE:`)).toBeNull();
  });

  it("rejects a header split across lines", () => {
    // `\s` matched newlines, so both of these used to parse. A header is one
    // line; accepting these was the same ambiguity the ReDoS alert names.
    expect(parse(`#\n${keyword} TYPE: Widget`)).toBeNull();
    expect(parse(`# ${keyword}\nTYPE: Widget`)).toBeNull();
  });

  it("does not degrade on a long run of whitespace after the header", () => {
    // The shape CodeQL describes: the keyword, then many repetitions of ' '.
    // A linear matcher finishes this instantly; a quadratic one does not.
    const content = `#${keyword}TYPE:${" ".repeat(50_000)}\n`;
    const started = Date.now();
    parse(content);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
