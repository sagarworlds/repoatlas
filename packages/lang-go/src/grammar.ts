import { createRequire } from "node:module";
import path from "node:path";

const WASM_FILE = "tree-sitter-go.wasm";

/**
 * Absolute path of the Go grammar .wasm. Normally it is found inside the
 * `tree-sitter-go` npm package. A bundled server sets GRAMMAR_DIR to the folder where
 * the build copied the grammar files (docs/DEPLOYMENT.md).
 */
export function goGrammarPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GRAMMAR_DIR;
  if (override !== undefined && override !== "") return path.join(override, WASM_FILE);
  return createRequire(import.meta.url).resolve(`tree-sitter-go/${WASM_FILE}`);
}
