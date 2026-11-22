// Which .wasm files ship in <bundle>/app/grammars. Adding a language in M4 is one line.
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { findPackageDir } from "./bundle-deps.ts";

export interface GrammarFile {
  /** npm package that contains the file. */
  pkg: string;
  /** File name inside the package folder; it is copied with the same name. */
  file: string;
  /** Workspace package folder (relative to the repo root) from which `pkg` is resolvable. */
  from: string;
}

/** The web-tree-sitter runtime plus one entry per language grammar. */
export const GRAMMAR_FILES: readonly GrammarFile[] = [
  { pkg: "web-tree-sitter", file: "web-tree-sitter.wasm", from: "packages/treesitter" },
  { pkg: "tree-sitter-python", file: "tree-sitter-python.wasm", from: "packages/lang-python" },
];

/** Folder name inside the app folder. Must match apps/api/src/config.ts. */
export const GRAMMARS_DIR_NAME = "grammars";

/** Pure: absolute source path of one entry. Throws if the package is not installed. */
export function grammarSourcePath(entry: GrammarFile, repoRoot: string): string {
  const pkgDir = findPackageDir(entry.pkg, path.join(repoRoot, ...entry.from.split("/")));
  return path.join(pkgDir, entry.file);
}

/** Copies every entry into <appDir>/grammars. Fails loudly if a file is missing. */
export function copyGrammars(
  appDir: string,
  repoRoot: string,
  entries: readonly GrammarFile[] = GRAMMAR_FILES,
): string[] {
  const dest = path.join(appDir, GRAMMARS_DIR_NAME);
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const entry of entries) {
    const src = grammarSourcePath(entry, repoRoot);
    if (!existsSync(src)) {
      throw new Error(`Grammar file missing: ${src} (package ${entry.pkg}). Run pnpm install.`);
    }
    copyFileSync(src, path.join(dest, entry.file));
    copied.push(entry.file);
  }
  return copied;
}

/** Extra data folders copied into the app folder, each exposed to the server by an env var. */
export interface DataDir {
  env: string;
  /** Source folder relative to the repo root. */
  from: string;
  /** Destination relative to the app folder (forward slashes). */
  dest: string;
}

export const DATA_DIRS: readonly DataDir[] = [
  { env: "PYTHON_QUERIES_DIR", from: "packages/lang-python/queries", dest: "queries/python" },
];

/** Copies each data folder into the app folder. Fails loudly if a source is missing. */
export function copyDataDirs(
  appDir: string,
  repoRoot: string,
  entries: readonly DataDir[] = DATA_DIRS,
): void {
  for (const entry of entries) {
    const src = path.join(repoRoot, ...entry.from.split("/"));
    if (!existsSync(src)) throw new Error(`Data folder missing: ${src}`);
    cpSync(src, path.join(appDir, ...entry.dest.split("/")), { recursive: true });
  }
}

/**
 * JavaScript prepended to server.js. HttpPlatformHandler cannot set environment variables,
 * and ES module imports run before the rest of the file, so the defaults must be set in a
 * banner (it runs first, before any bundled module such as the Python plugin reads them).
 * The app folder is three levels above <app>/apps/api/dist/server.js. An explicit
 * environment variable always wins; a folder that does not exist is skipped.
 */
export function renderEnvDefaultsBanner(
  dataDirs: readonly DataDir[] = DATA_DIRS,
  grammarsDir: string = GRAMMARS_DIR_NAME,
): string {
  const entries: Array<[string, string]> = [
    ["GRAMMAR_DIR", grammarsDir],
    ["TREE_SITTER_WASM_DIR", grammarsDir],
    ...dataDirs.map((d): [string, string] => [d.env, d.dest]),
  ];
  return [
    'import { existsSync as __existsSync } from "node:fs";',
    'import { join as __join, resolve as __resolve } from "node:path";',
    "{",
    '  const appRoot = __resolve(__dirname, "..", "..", "..");',
    `  for (const [name, rel] of ${JSON.stringify(entries)}) {`,
    "    const dir = __join(appRoot, ...rel.split('/'));",
    '    if ((process.env[name] ?? "") === "" && __existsSync(dir)) process.env[name] = dir;',
    "  }",
    "}",
  ].join("\n");
}
