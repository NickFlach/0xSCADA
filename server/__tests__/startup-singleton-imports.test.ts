import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

interface ImportGraph {
  staticImports: string[];
  dynamicImports: string[];
}

async function readImportGraph(relativePath: string): Promise<ImportGraph> {
  const sourceText = await readFile(path.resolve(relativePath), "utf8");
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const staticImports: string[] = [];
  const dynamicImports: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      staticImports.push(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      dynamicImports.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { staticImports, dynamicImports };
}

describe("startup singleton module identity", () => {
  test.each([
    {
      file: "server/index.ts",
      modules: [
        "./simulator",
        // "./agents" was dropped from this list when #37 removed the empty
        // default-agent boot stubs: the module is no longer a startup
        // dependency of index.ts at all (not deleted to go green).
        "./gateway/store-and-forward",
        "./gateway/store-and-forward-runtime",
        "./bridge",
        "./scaling/federation-runtime",
        "./gateway",
        "./services/flux",
        "./services/nats",
        "./scaling/upgrade-runtime",
        "./bridge/anchor-backend",
        "./scaling/horizontal-runtime",
      ],
    },
    {
      file: "server/health/index.ts",
      modules: [
        "../scaling/upgrade-runtime",
        "../simulator",
        "../scaling/federation-runtime",
        "../gateway/store-and-forward",
        "../gateway/store-and-forward-runtime",
        "../bridge",
        "../scaling/horizontal-runtime",
      ],
    },
    {
      file: "server/gateway/index.ts",
      modules: ["./store-and-forward"],
    },
  ])("$file keeps stateful startup modules in the static graph", async ({
    file,
    modules,
  }) => {
    const graph = await readImportGraph(file);

    // With tsx on Node 20, import() can evaluate a second copy of a module
    // already loaded by the static CJS graph. Startup initializers and serving
    // consumers must therefore use static imports for every shared singleton.
    expect(
      graph.dynamicImports.filter((specifier) => modules.includes(specifier)),
    ).toEqual([]);
    expect(graph.staticImports).toEqual(expect.arrayContaining(modules));
  });
});
