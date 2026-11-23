import { readFileSync } from "node:fs";
import type { RepoView } from "@repoatlas/plugin-api";
import ts from "typescript";

/** Virtual absolute root the repo is mounted at inside the TypeScript compiler. */
export const VIRTUAL_ROOT = "/repo";

/** "src/a.ts" -> "/repo/src/a.ts" */
const IMPLEMENTATION_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];

export function toVirtualPath(rel: string): string {
  return rel === "" ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${rel}`;
}

/** "/repo/src/a.ts" -> "src/a.ts"; undefined for anything outside the virtual root. */
export function toRepoPath(abs: string): string | undefined {
  if (abs === VIRTUAL_ROOT) return "";
  if (abs.startsWith(`${VIRTUAL_ROOT}/`)) return abs.slice(VIRTUAL_ROOT.length + 1);
  return undefined;
}

/**
 * A CompilerHost that only sees the analyzed repository (through RepoView, mounted at
 * "/repo") plus TypeScript's own default lib files. It never touches the real file system
 * for anything else, so symlinks, node_modules and the host machine are invisible.
 * (C# analogy: a custom Roslyn `SourceReferenceResolver` over an in-memory file set.)
 */
export function createVirtualHost(repo: RepoView, options: ts.CompilerOptions): ts.CompilerHost {
  const libFile = ts.getDefaultLibFilePath(options).replaceAll("\\", "/");
  const libDir = libFile.slice(0, libFile.lastIndexOf("/"));
  const isLibPath = (p: string): boolean => p.startsWith(`${libDir}/`) && p.endsWith(".d.ts");

  const fileCache = new Map<string, boolean>();
  const dirCache = new Map<string, boolean>();
  const sourceCache = new Map<string, ts.SourceFile | undefined>();

  const isRepoFile = (rel: string): boolean => repo.exists(rel) && !repo.isDir(rel);
  // `foo.d.ts` next to `foo.js` (or foo.ts) is hidden from module resolution, so imports and
  // calls reach the implementation file, which is the graph node (a .d.ts has no symbols).
  const hasImplementationSibling = (rel: string): boolean => {
    if (!rel.endsWith(".d.ts")) return false;
    const base = rel.slice(0, -".d.ts".length);
    return IMPLEMENTATION_EXTENSIONS.some((ext) => isRepoFile(base + ext));
  };

  const fileExists = (p: string): boolean => {
    const cached = fileCache.get(p);
    if (cached !== undefined) return cached;
    let result = false;
    const rel = toRepoPath(p);
    if (rel !== undefined) result = isRepoFile(rel) && !hasImplementationSibling(rel);
    else if (isLibPath(p)) result = readLib(p) !== undefined;
    fileCache.set(p, result);
    return result;
  };

  const directoryExists = (p: string): boolean => {
    const cached = dirCache.get(p);
    if (cached !== undefined) return cached;
    const rel = toRepoPath(p);
    const result = rel !== undefined && repo.isDir(rel);
    dirCache.set(p, result);
    return result;
  };

  const readFile = (p: string): string | undefined => {
    const rel = toRepoPath(p);
    if (rel !== undefined) return repo.readSync(rel);
    if (isLibPath(p)) return readLib(p);
    return undefined;
  };

  return {
    getSourceFile(fileName, languageVersionOrOptions) {
      if (sourceCache.has(fileName)) return sourceCache.get(fileName);
      const text = readFile(fileName);
      const sf =
        text === undefined
          ? undefined
          : // `true` = setParentNodes: we walk up from nodes to find enclosing definitions.
            ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
      sourceCache.set(fileName, sf);
      return sf;
    },
    getDefaultLibFileName: () => libFile,
    getDefaultLibLocation: () => libDir,
    writeFile: () => {},
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getDirectories(p) {
      const rel = toRepoPath(p);
      if (rel === undefined) return [];
      return repo.list(rel).filter((name) => repo.isDir(rel === "" ? name : `${rel}/${name}`));
    },
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists,
    readFile,
    directoryExists,
    realpath: (p) => p,
  };
}

/** Reads one of TypeScript's own lib.*.d.ts files (the only real-disk access we allow). */
function readLib(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
