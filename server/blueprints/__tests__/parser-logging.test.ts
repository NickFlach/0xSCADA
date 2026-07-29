import { readdir, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../../logger", () => ({
  default: { warn },
}));

import { parseCMTypeMarkdown } from "../cm-type-parser";
import { importBlueprints } from "../importer";
import { parsePhaseTypeMarkdown } from "../phase-type-parser";
import { parseUnitTypeMarkdown } from "../unit-type-parser";

async function productionTypeScriptModules(directory: URL): Promise<URL[]> {
  const modules: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "__tests__") {
      modules.push(
        ...(await productionTypeScriptModules(
          new URL(`${entry.name}/`, directory),
        )),
      );
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      modules.push(new URL(entry.name, directory));
    }
  }
  return modules;
}

describe("blueprint parser logging", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("keeps uploaded filenames out of log messages for every parser", () => {
    const forged = "\r\n{\"level\":50,\"msg\":\"FORGED\"}\u001b[31m";
    const names = {
      cm: `cm-type-uploaded${forged}.md`,
      unit: `unit-type-uploaded${forged}.md`,
      phase: `phase-type-uploaded${forged}.md`,
    };

    const result = importBlueprints({
      cmTypePackage: [{ name: names.cm, content: "invalid" }],
      designSpec: {
        cmInstances: [],
        unitTypes: [{ name: names.unit, content: "invalid" }],
        unitInstances: [],
        phaseTypes: [{ name: names.phase, content: "invalid" }],
      },
    });

    expect(result.warnings).toHaveLength(3);
    expect(warn.mock.calls).toEqual([
      [
        { sourceFile: names.cm },
        "Could not find CM TYPE header in blueprint file",
      ],
      [
        { sourceFile: names.unit },
        "Could not find UNIT TYPE header in blueprint file",
      ],
      [
        { sourceFile: names.phase },
        "Could not find PHASE TYPE header in blueprint file",
      ],
    ]);
    for (const [, message] of warn.mock.calls) {
      expect(message).not.toContain("uploaded");
      expect(message).not.toContain("\n");
      expect(message).not.toContain("\r");
      expect(message).not.toContain("\u001b");
    }
  });

  it("preserves ordinary missing-header behavior with structured context", () => {
    expect(parseCMTypeMarkdown("invalid", "cm-type-pump.md")).toBeNull();
    expect(parseUnitTypeMarkdown("invalid", "unit-type-line.md")).toBeNull();
    expect(parsePhaseTypeMarkdown("invalid", "phase-type-fill.md")).toBeNull();

    expect(warn.mock.calls).toEqual([
      [
        { sourceFile: "cm-type-pump.md" },
        "Could not find CM TYPE header in blueprint file",
      ],
      [
        { sourceFile: "unit-type-line.md" },
        "Could not find UNIT TYPE header in blueprint file",
      ],
      [
        { sourceFile: "phase-type-fill.md" },
        "Could not find PHASE TYPE header in blueprint file",
      ],
    ]);
  });

  it("does not warn for valid files and preserves their source filenames", () => {
    expect(
      parseCMTypeMarkdown("# CM TYPE: Pump", "cm-type-pump.md"),
    ).toMatchObject({ name: "Pump", sourceFile: "cm-type-pump.md" });
    expect(
      parseUnitTypeMarkdown("# UNIT TYPE: Line", "unit-type-line.md"),
    ).toMatchObject({ name: "Line", sourceFile: "unit-type-line.md" });
    expect(
      parsePhaseTypeMarkdown("# PHASE TYPE: Fill", "phase-type-fill.md"),
    ).toMatchObject({ name: "Fill", sourceFile: "phase-type-fill.md" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("blueprint production logging guard", () => {
  it("does not bypass the structured logger with console calls", async () => {
    const directory = new URL("..", import.meta.url);
    const modules = await productionTypeScriptModules(directory);

    for (const module of modules) {
      const source = await readFile(module, "utf8");
      expect(source, module.pathname).not.toMatch(/\bconsole\s*\./);
    }
  });
});
