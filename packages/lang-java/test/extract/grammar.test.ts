import { existsSync } from "node:fs";
import path from "node:path";
import { verifyGrammars } from "@repoatlas/treesitter";
import { describe, expect, it } from "vitest";
import { javaGrammarPath } from "../../src/grammar.ts";
import { loadJavaQueries } from "../../src/spec/queries.ts";

describe("java grammar", () => {
  it("resolves and loads the grammar wasm", async () => {
    const wasm = javaGrammarPath();
    expect(path.isAbsolute(wasm)).toBe(true);
    expect(existsSync(wasm)).toBe(true);
    const [check] = await verifyGrammars([wasm]);
    expect(check?.ok).toBe(true);
  });

  it("honours GRAMMAR_DIR", () => {
    const wasm = javaGrammarPath({ GRAMMAR_DIR: path.join(path.sep, "bundle", "grammars") });
    expect(wasm).toBe(path.join(path.sep, "bundle", "grammars", "tree-sitter-java.wasm"));
  });

  it("loads the three query files", () => {
    const q = loadJavaQueries();
    expect(q.definitions).toContain("@definition.class");
    expect(q.imports).toContain("@import");
    expect(q.references).toContain("@reference.call");
  });
});
