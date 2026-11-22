import { createRequire } from "node:module";
import path from "node:path";

const WASM_FILE = "tree-sitter-python.wasm";

/**
 * Absolute path of the Python grammar .wasm. Normally it is found inside the
 * `tree-sitter-python` npm package. A bundled server sets GRAMMAR_DIR to the folder where
 * the build copied the grammar files (docs/DEPLOYMENT.md).
 */
export function pythonGrammarPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GRAMMAR_DIR;
  if (override !== undefined && override !== "") return path.join(override, WASM_FILE);
  return createRequire(import.meta.url).resolve(`tree-sitter-python/${WASM_FILE}`);
}
