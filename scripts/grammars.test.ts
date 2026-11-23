import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copyGrammars, DATA_DIRS, GRAMMAR_FILES, renderEnvDefaultsBanner } from "./grammars.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("copyGrammars", () => {
  it("copies the runtime and every listed grammar with names preserved", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grammars-"));
    try {
      copyGrammars(dir, repoRoot);
      const files = readdirSync(path.join(dir, "grammars")).sort();
      expect(files).toEqual(GRAMMAR_FILES.map((g) => g.file).sort());
      expect(files).toContain("web-tree-sitter.wasm");
      for (const lang of ["python", "go", "java"]) {
        expect(files).toContain(`tree-sitter-${lang}.wasm`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when a package is not installed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grammars-"));
    try {
      expect(() =>
        copyGrammars(dir, repoRoot, [
          { pkg: "tree-sitter-nope", file: "x.wasm", from: "packages/lang-python" },
        ]),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderEnvDefaultsBanner", () => {
  it("sets the grammar and data variables only when unset", () => {
    const banner = renderEnvDefaultsBanner([{ env: "X_DIR", from: "a", dest: "queries/x" }]);
    expect(banner).toContain('"GRAMMAR_DIR","grammars"');
    expect(banner).toContain('"TREE_SITTER_WASM_DIR","grammars"');
    expect(banner).toContain('"X_DIR","queries/x"');
    expect(banner).toContain('(process.env[name] ?? "") === ""');
  });

  it("defaults a queries folder for every language plugin", () => {
    expect(DATA_DIRS.map((d) => d.env).sort()).toEqual([
      "GO_QUERIES_DIR",
      "JAVA_QUERIES_DIR",
      "PYTHON_QUERIES_DIR",
    ]);
    const banner = renderEnvDefaultsBanner();
    expect(banner).toContain("queries/go");
    expect(banner).toContain("queries/java");
  });
});
