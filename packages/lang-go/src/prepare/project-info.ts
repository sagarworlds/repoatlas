import type { ProjectContext } from "@repoatlas/plugin-api";
import { toPosixPath } from "@repoatlas/schema";
import { parseGoMod } from "./go-mod.ts";

/**
 * What `prepare` computes. A plain JSON-friendly object (arrays and records, no Map/Set),
 * so it can be cached. `resolve` reads it back with `readGoProjectInfo`, which validates it.
 *
 * `type` instead of `interface` on purpose: an object type alias is assignable to
 * `Record<string, unknown>` (the plugin API's PluginProjectInfo); an interface is not.
 *
 * Ignored on purpose: the `go` directive, `replace`/`exclude` directives and go.work files.
 */
export type GoProjectInfo = {
  version: 1;
  /** Every go.mod that has a module line, sorted by directory ("" = repo root). */
  modules: GoModuleInfo[];
  /** Union of the `require`d module paths of all go.mod files, sorted, no duplicates. */
  requiredModules: string[];
  /**
   * Directory (repo-relative, POSIX, "" = root) -> import path, for every directory that
   * holds a `.go` file. Inside a module: `{modulePath}/{dir relative to the go.mod}`.
   * Outside every module (module-less repo): the directory path itself, "." for the root.
   */
  dirToImportPath: Record<string, string>;
};

export type GoModuleInfo = {
  /** Directory of the go.mod file. */
  dir: string;
  /** Path of its `module` directive. */
  path: string;
};

/** `GoProjectInfo` loaded into Maps and Sets for fast lookups. */
export interface GoPackageTable {
  modules: GoModuleInfo[];
  requiredModules: string[];
  dirToImportPath: Map<string, string>;
  /** First directory (in sorted order) wins when two directories share an import path. */
  importPathToDir: Map<string, string>;
  /** Directories whose import path comes from a go.mod (not from the module-less layout). */
  moduleDirs: Set<string>;
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function isUnder(dir: string, base: string): boolean {
  return base === "" || dir === base || dir.startsWith(`${base}/`);
}

/** The go.mod whose directory is the longest ancestor of (or equal to) `dir`. */
export function moduleForDir(
  dir: string,
  modules: readonly GoModuleInfo[],
): GoModuleInfo | undefined {
  let best: GoModuleInfo | undefined;
  for (const m of modules) {
    if (isUnder(dir, m.dir) && (best === undefined || m.dir.length > best.dir.length)) best = m;
  }
  return best;
}

/** Import path of a directory, and whether it comes from a go.mod. */
export function importPathForDir(
  dir: string,
  modules: readonly GoModuleInfo[],
): { importPath: string; viaModule: boolean } {
  const module = moduleForDir(dir, modules);
  if (module === undefined) return { importPath: dir === "" ? "." : dir, viaModule: false };
  const rel = module.dir === "" ? dir : dir.slice(module.dir.length + 1);
  return { importPath: rel === "" ? module.path : `${module.path}/${rel}`, viaModule: true };
}

/** Pure core of `goPrepare`: go.mod contents and the claimed `.go` paths in, info out. */
export function computeGoProjectInfo(
  goFilePaths: readonly string[],
  goMods: readonly { dir: string; text: string }[],
): GoProjectInfo {
  const modules: GoModuleInfo[] = [];
  const required = new Set<string>();
  for (const mod of goMods) {
    const parsed = parseGoMod(mod.text);
    for (const r of parsed.requires) required.add(r);
    if (parsed.modulePath !== undefined) modules.push({ dir: mod.dir, path: parsed.modulePath });
  }
  modules.sort((a, b) => compareCodeUnits(a.dir, b.dir));

  const dirs = new Set<string>();
  for (const path of goFilePaths) dirs.add(dirOf(toPosixPath(path)));
  const dirToImportPath: Record<string, string> = {};
  for (const dir of [...dirs].sort(compareCodeUnits)) {
    dirToImportPath[dir] = importPathForDir(dir, modules).importPath;
  }
  return {
    version: 1,
    modules,
    requiredModules: [...required].sort(compareCodeUnits),
    dirToImportPath,
  };
}

const MAX_GO_MOD_FILES = 200;
const MAX_GO_MOD_BYTES = 1_000_000;

/** Directories that may hold a go.mod: the root, every ancestor of a `.go` directory, and any listed one. */
function goModDirs(ctx: ProjectContext, goDirs: ReadonlySet<string>): string[] {
  const found = new Set<string>([""]);
  for (const dir of goDirs) {
    const parts = dir.split("/").filter((p) => p !== "");
    for (let n = 1; n <= parts.length; n++) found.add(parts.slice(0, n).join("/"));
  }
  for (const file of ctx.allFiles) {
    const path = toPosixPath(file.path);
    if (path === "go.mod" || path.endsWith("/go.mod")) found.add(dirOf(path));
  }
  return [...found].sort(
    (a, b) => a.split("/").length - b.split("/").length || compareCodeUnits(a, b),
  );
}

/**
 * Plugin `prepare` step: reads every go.mod (module path and requires only, nothing is
 * executed) and maps each `.go` directory to its import path. Never throws for bad go.mod
 * content; an unreadable go.mod is skipped.
 */
export async function goPrepare(ctx: ProjectContext): Promise<GoProjectInfo> {
  const goFiles = ctx.files.map((f) => toPosixPath(f.path)).filter((p) => p.endsWith(".go"));
  const goDirs = new Set(goFiles.map(dirOf));
  const goMods: { dir: string; text: string }[] = [];
  for (const dir of goModDirs(ctx, goDirs)) {
    if (goMods.length >= MAX_GO_MOD_FILES) break;
    const path = dir === "" ? "go.mod" : `${dir}/go.mod`;
    try {
      if (!ctx.repo.exists(path)) continue;
      const text = await ctx.repo.read(path);
      if (text !== undefined && text.length <= MAX_GO_MOD_BYTES) goMods.push({ dir, text });
    } catch {
      // An unreadable go.mod is treated as absent.
    }
  }
  return computeGoProjectInfo(goFiles, goMods);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function isModuleList(value: unknown): value is GoModuleInfo[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as { dir?: unknown }).dir === "string" &&
        typeof (m as { path?: unknown }).path === "string",
    )
  );
}

function buildTable(
  modules: GoModuleInfo[],
  requiredModules: string[],
  dirToImportPath: Map<string, string>,
): GoPackageTable {
  const importPathToDir = new Map<string, string>();
  const moduleDirs = new Set<string>();
  for (const dir of [...dirToImportPath.keys()].sort(compareCodeUnits)) {
    const importPath = dirToImportPath.get(dir) as string;
    if (!importPathToDir.has(importPath)) importPathToDir.set(importPath, dir);
    if (moduleForDir(dir, modules) !== undefined) moduleDirs.add(dir);
  }
  return { modules, requiredModules, dirToImportPath, importPathToDir, moduleDirs };
}

/** Validates the `info` handed to `resolve`. Returns undefined when it is not a GoProjectInfo. */
export function readGoProjectInfo(info: unknown): GoPackageTable | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const raw = info as Record<string, unknown>;
  if (raw.version !== 1 || !isModuleList(raw.modules) || !isStringRecord(raw.dirToImportPath)) {
    return undefined;
  }
  const required = raw.requiredModules;
  const requiredModules =
    Array.isArray(required) && required.every((r) => typeof r === "string")
      ? (required as string[])
      : [];
  return buildTable(raw.modules, requiredModules, new Map(Object.entries(raw.dirToImportPath)));
}

/** Fallback when no usable info exists: a module-less layout over the given directories. */
export function tableFromDirs(dirs: Iterable<string>): GoPackageTable {
  const map = new Map<string, string>();
  for (const dir of dirs) map.set(dir, importPathForDir(dir, []).importPath);
  return buildTable([], [], map);
}

/** The table extended with module-less (or module-relative) import paths for unknown dirs. */
export function withDirs(table: GoPackageTable, dirs: Iterable<string>): GoPackageTable {
  const missing = [...dirs].filter((d) => !table.dirToImportPath.has(d));
  if (missing.length === 0) return table;
  const map = new Map(table.dirToImportPath);
  for (const dir of missing) map.set(dir, importPathForDir(dir, table.modules).importPath);
  return buildTable(table.modules, table.requiredModules, map);
}
