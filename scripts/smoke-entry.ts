/// <reference path="../packages/treesitter/node_modules/web-tree-sitter/web-tree-sitter.d.ts" />
// Bundle smoke test. Built by verify-bundle.ts into a TEMPORARY file inside the verification
// bundle (never shipped). Proves that the esbuild-bundled web-tree-sitter finds its wasm
// files through the bundle layout (no env vars set by the caller) and parses Python.
// Exit code 0 = ok, 1 = failure. Prints one JSON line.
import path from "node:path";
import { Parser } from "web-tree-sitter";
import { initTreeSitter, loadGrammar } from "../packages/treesitter/src/index.ts";

const SOURCE = [
  "import os",
  "class User:",
  "    def save(self):",
  "        return os.getcwd()",
  "def main():",
  "    User().save()",
  "",
].join("\n");

try {
  const grammarDir = process.env.GRAMMAR_DIR ?? "";
  await initTreeSitter();
  const language = await loadGrammar(path.join(grammarDir, "tree-sitter-python.wasm"));
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(SOURCE);
  if (tree === null) throw new Error("parse returned null");
  const root = tree.rootNode;
  const ok = root.type === "module" && !root.hasError && root.namedChildCount === 3;
  const summary = { ok, rootType: root.type, children: root.namedChildCount };
  tree.delete();
  parser.delete();
  console.log(JSON.stringify(summary));
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.log(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  process.exit(1);
}
