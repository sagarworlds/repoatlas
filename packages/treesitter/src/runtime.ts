import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";

/** Thrown when the web-tree-sitter runtime itself cannot start. */
export class TreeSitterInitError extends Error {
  readonly code = "TREE_SITTER_INIT_FAILED";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TreeSitterInitError";
  }
}

/** Thrown when a grammar .wasm file is missing, unreadable or incompatible. */
export class GrammarLoadError extends Error {
  readonly code = "GRAMMAR_LOAD_FAILED";
  readonly wasmPath: string;
  constructor(wasmPath: string, message: string, options?: { cause?: unknown }) {
    super(`Cannot load grammar ${wasmPath}: ${message}`, options);
    this.name = "GrammarLoadError";
    this.wasmPath = wasmPath;
  }
}

const RUNTIME_WASM_NAME = "web-tree-sitter.wasm";

/**
 * Locates web-tree-sitter's own runtime wasm file (NOT a grammar).
 *
 * - If `TREE_SITTER_WASM_DIR` is set, the file is `<dir>/web-tree-sitter.wasm`. Use this
 *   for the esbuild-bundled server: copy the file next to the bundle and set the variable.
 * - Otherwise resolve it through Node's module resolution, using a `require` created from
 *   this module's URL (the C# analogy: asking the assembly loader where a dependency lives).
 *   web-tree-sitter exports the subpath "./web-tree-sitter.wasm" for exactly this.
 *
 * The result is an absolute file-system path (with backslashes on Windows), never a
 * file: URL, never relative to process.cwd().
 */
export function resolveRuntimeWasmPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TREE_SITTER_WASM_DIR;
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override, RUNTIME_WASM_NAME);
  }
  try {
    return createRequire(import.meta.url).resolve(`web-tree-sitter/${RUNTIME_WASM_NAME}`);
  } catch (cause) {
    throw new TreeSitterInitError(
      `Cannot locate ${RUNTIME_WASM_NAME}. Install web-tree-sitter or set TREE_SITTER_WASM_DIR.`,
      { cause },
    );
  }
}

let initPromise: Promise<void> | undefined;

async function doInit(): Promise<void> {
  const wasmPath = resolveRuntimeWasmPath();
  try {
    await access(wasmPath);
  } catch (cause) {
    throw new TreeSitterInitError(`Runtime wasm not found at ${wasmPath}`, { cause });
  }
  try {
    await Parser.init({
      locateFile: (name: string) => (name === RUNTIME_WASM_NAME ? wasmPath : name),
    });
  } catch (cause) {
    throw new TreeSitterInitError("Parser.init failed", { cause });
  }
}

/**
 * Initialises the WASM runtime once. Safe to call concurrently and repeatedly: every
 * caller awaits the same promise. A failed attempt is not cached, so a later call retries.
 */
export function initTreeSitter(): Promise<void> {
  if (initPromise === undefined) {
    const attempt = doInit();
    initPromise = attempt;
    attempt.catch(() => {
      if (initPromise === attempt) initPromise = undefined;
    });
  }
  return initPromise;
}

const grammarCache = new Map<string, Promise<Language>>();

/**
 * Loads (and caches per absolute path) a grammar .wasm file. Concurrent calls for the
 * same path share one load. Failures are typed (`GrammarLoadError`) and not cached.
 */
export function loadGrammar(wasmPath: string): Promise<Language> {
  const cached = grammarCache.get(wasmPath);
  if (cached !== undefined) return cached;
  const attempt = loadGrammarUncached(wasmPath);
  grammarCache.set(wasmPath, attempt);
  attempt.catch(() => {
    if (grammarCache.get(wasmPath) === attempt) grammarCache.delete(wasmPath);
  });
  return attempt;
}

async function loadGrammarUncached(wasmPath: string): Promise<Language> {
  if (!path.isAbsolute(wasmPath)) {
    throw new GrammarLoadError(wasmPath, "path must be absolute");
  }
  try {
    await access(wasmPath);
  } catch (cause) {
    throw new GrammarLoadError(wasmPath, "file not found or unreadable", { cause });
  }
  await initTreeSitter();
  try {
    return await Language.load(wasmPath);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new GrammarLoadError(wasmPath, reason, { cause });
  }
}

export interface GrammarCheck {
  wasmPath: string;
  ok: boolean;
  /** Present when ok. */
  abiVersion?: number;
  /** Present when not ok. */
  error?: string;
}

/**
 * Loads every given grammar and reports per path. Language packages call this from their
 * own tests ("all registered grammars load" - docs/LANGUAGE_PLUGINS section 4) and assert
 * `results.every((r) => r.ok)`. Never throws for a bad grammar.
 */
export async function verifyGrammars(wasmPaths: readonly string[]): Promise<GrammarCheck[]> {
  const results: GrammarCheck[] = [];
  for (const wasmPath of wasmPaths) {
    try {
      const language = await loadGrammar(wasmPath);
      results.push({ wasmPath, ok: true, abiVersion: language.abiVersion });
    } catch (error) {
      results.push({
        wasmPath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
