import { existsSync } from "node:fs";
import path from "node:path";
import { verifyGrammars } from "@repoatlas/treesitter";
import { describe, expect, it } from "vitest";
import { pythonGrammarPath } from "../../src/grammar.ts";
import { loadPythonQueries } from "../../src/spec/queries.ts";

describe("python grammar", () => {
  it("resolves and loads the grammar wasm", async () => {
    const wasm = pythonGrammarPath();
    expect(path.isAbsolute(wasm)).toBe(true);
    expect(existsSync(wasm)).toBe(true);
    const [check] = await verifyGrammars([wasm]);
    expect(check?.ok).toBe(true);
  });

  it("honours GRAMMAR_DIR", () => {
    const wasm = pythonGrammarPath({ GRAMMAR_DIR: path.join(path.sep, "bundle", "grammars") });
    expect(wasm).toBe(path.join(path.sep, "bundle", "grammars", "tree-sitter-python.wasm"));
  });

  it("loads the three query files", () => {
    const q = loadPythonQueries();
    expect(q.definitions).toContain("@definition.class");
    expect(q.imports).toContain("@import");
    expect(q.references).toContain("@reference.call");
  });
});
