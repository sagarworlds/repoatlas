import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GrammarLoadError,
  initTreeSitter,
  loadGrammar,
  resolveRuntimeWasmPath,
  verifyGrammars,
} from "./runtime.ts";
import { pythonGrammarPath } from "./test-spec.ts";

describe("initTreeSitter", () => {
  it("is safe to call concurrently and repeatedly", async () => {
    const calls = Array.from({ length: 10 }, () => initTreeSitter());
    expect(new Set(calls).size).toBe(1); // every caller shares one promise
    await Promise.all(calls);
    await expect(initTreeSitter()).resolves.toBeUndefined();
  });
});

describe("resolveRuntimeWasmPath", () => {
  it("finds the runtime wasm as an absolute path by default", () => {
    const p = resolveRuntimeWasmPath({});
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith("web-tree-sitter.wasm")).toBe(true);
    expect(p.startsWith("file:")).toBe(false);
  });
  it("honours TREE_SITTER_WASM_DIR", () => {
    const dir = path.resolve(tmpdir(), "ts-wasm-dir");
    expect(resolveRuntimeWasmPath({ TREE_SITTER_WASM_DIR: dir })).toBe(
      path.join(dir, "web-tree-sitter.wasm"),
    );
  });
  it("ignores a blank override", () => {
    expect(
      resolveRuntimeWasmPath({ TREE_SITTER_WASM_DIR: "  " }).endsWith("web-tree-sitter.wasm"),
    ).toBe(true);
  });
});

describe("loadGrammar", () => {
  it("loads a grammar and caches it per path", async () => {
    const [a, b] = await Promise.all([
      loadGrammar(pythonGrammarPath()),
      loadGrammar(pythonGrammarPath()),
    ]);
    expect(a).toBe(b);
    expect(a.name).toBe("python");
  });

  it("throws GrammarLoadError for a missing file", async () => {
    const missing = path.resolve(tmpdir(), "definitely-missing-grammar.wasm");
    await expect(loadGrammar(missing)).rejects.toBeInstanceOf(GrammarLoadError);
    await expect(loadGrammar(missing)).rejects.toMatchObject({
      code: "GRAMMAR_LOAD_FAILED",
      wasmPath: missing,
    });
  });

  it("throws GrammarLoadError for a relative path", async () => {
    await expect(loadGrammar("grammar.wasm")).rejects.toBeInstanceOf(GrammarLoadError);
  });

  it("throws GrammarLoadError for a file that is not a grammar", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ts-bad-grammar-"));
    try {
      const bad = path.join(dir, "bad.wasm");
      await writeFile(bad, "not wasm at all");
      await expect(loadGrammar(bad)).rejects.toBeInstanceOf(GrammarLoadError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyGrammars", () => {
  it("reports ok and failed grammars without throwing", async () => {
    const missing = path.resolve(tmpdir(), "nope.wasm");
    const results = await verifyGrammars([pythonGrammarPath(), missing]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0]?.abiVersion).toBeGreaterThan(0);
    expect(results[1]).toMatchObject({ ok: false, wasmPath: missing });
    expect(results[1]?.error).toContain("not found");
  });
});
