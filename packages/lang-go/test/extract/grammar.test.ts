import { existsSync } from "node:fs";
import path from "node:path";
import { verifyGrammars } from "@repoatlas/treesitter";
import { describe, expect, it } from "vitest";
import { goGrammarPath } from "../../src/grammar.ts";
import { loadGoQueries } from "../../src/spec/queries.ts";

describe("go grammar", () => {
  it("resolves and loads the grammar wasm", async () => {
    const wasm = goGrammarPath();
    expect(path.isAbsolute(wasm)).toBe(true);
    expect(existsSync(wasm)).toBe(true);
    const [check] = await verifyGrammars([wasm]);
    expect(check?.ok).toBe(true);
  });

  it("honours GRAMMAR_DIR", () => {
    const wasm = goGrammarPath({ GRAMMAR_DIR: path.join(path.sep, "bundle", "grammars") });
    expect(wasm).toBe(path.join(path.sep, "bundle", "grammars", "tree-sitter-go.wasm"));
  });

  it("loads the three query files", () => {
    const q = loadGoQueries();
    expect(q.definitions).toContain("@definition.class");
    expect(q.imports).toContain("@import");
    expect(q.references).toContain("@reference.call");
  });
});
