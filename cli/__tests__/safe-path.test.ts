/**
 * Path safety for server-supplied export filenames (CodeQL js/http-to-file-access
 * #144-147).
 *
 * `oxscada blueprints export` and `export-all` named their output files after
 * fields in the API response. Neither `path.join` nor `path.resolve` sanitises
 * anything, so a hostile or compromised server choosing `blueprint.name` chose
 * where the CLI wrote — anywhere the operator could write, on what is typically
 * an engineering workstation.
 */

import path from "path";
import { describe, expect, it } from "vitest";

import { resolveWithinDirectory, safeFileName } from "../src/lib/safe-path.js";

const NUL = String.fromCharCode(0);

describe("safeFileName", () => {
  it("leaves an ordinary name alone", () => {
    expect(safeFileName("PIDController")).toBe("PIDController");
    expect(safeFileName("Pump 1 (spare)")).toBe("Pump 1 (spare)");
  });

  it("flattens every path separator", () => {
    expect(safeFileName("a/b")).toBe("a_b");
    expect(safeFileName("a\\b")).toBe("a_b");
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
  });

  it("refuses to produce a traversal segment", () => {
    for (const name of ["..", ".", "...", "./..", "../"]) {
      const safe = safeFileName(name);
      expect(safe).not.toBe("..");
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
    }
  });

  it("strips a leading dot so the file is not hidden", () => {
    expect(safeFileName(".bashrc")).toBe("bashrc");
  });

  it("strips trailing dots and spaces, which Windows drops anyway", () => {
    // Otherwise "report." and "report" collide and one silently overwrites
    // the other.
    expect(safeFileName("report.")).toBe("report");
    expect(safeFileName("report ")).toBe("report");
  });

  it("removes control characters", () => {
    expect(safeFileName(`a${NUL}b`)).toBe("a_b");
  });

  it("falls back rather than yielding an empty name", () => {
    expect(safeFileName("")).toBe("unnamed");
    expect(safeFileName("...")).toBe("unnamed");
    expect(safeFileName("   ")).toBe("unnamed");
    expect(safeFileName("", "blueprint")).toBe("blueprint");
  });

  it("defuses Windows reserved device names", () => {
    // Opening `CON` or `NUL` talks to a device, not a file.
    for (const reserved of ["CON", "nul", "COM1", "lpt9", "AUX.yaml"]) {
      expect(safeFileName(reserved, "bp")).toMatch(/^bp-/);
    }
  });
});

describe("resolveWithinDirectory", () => {
  const base = path.resolve("exports", "cm-types");

  it("resolves an ordinary name inside the directory", () => {
    const resolved = resolveWithinDirectory(base, "Valve.yaml");
    expect(resolved).toBe(path.join(base, "Valve.yaml"));
  });

  it("contains a traversal attempt instead of escaping", () => {
    const resolved = resolveWithinDirectory(base, "../../../pwned.yaml");
    expect(path.dirname(resolved)).toBe(base);
    expect(resolved.startsWith(base)).toBe(true);
  });

  it("contains an absolute path, which path.join would have honoured", () => {
    const resolved = resolveWithinDirectory(base, "/etc/cron.d/backdoor");
    expect(path.dirname(resolved)).toBe(base);
  });

  it("contains a Windows absolute path", () => {
    const resolved = resolveWithinDirectory(base, "C:\\Windows\\System32\\evil.yaml");
    expect(path.dirname(resolved)).toBe(base);
  });

  it("never returns the directory itself", () => {
    // A name reducing to nothing must become a file in the directory, not the
    // directory — writing to it would fail with EISDIR at best.
    const resolved = resolveWithinDirectory(base, "..", "fallback");
    expect(resolved).not.toBe(base);
    expect(path.dirname(resolved)).toBe(base);
  });
});

describe("the pre-fix behaviour these replace", () => {
  it("path.join did escape the directory", () => {
    // Documents why the change was needed: this is what the code did before.
    expect(path.join("exports/cm-types", "../../../pwned.yaml")).toBe(
      path.join("..", "pwned.yaml"),
    );
  });

  it("path.resolve discarded the base entirely for an absolute name", () => {
    expect(path.resolve("exports", "/etc/passwd")).toBe(path.resolve("/etc/passwd"));
  });
});
