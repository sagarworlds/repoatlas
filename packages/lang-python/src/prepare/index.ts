import type { ProjectContext } from "@repoatlas/plugin-api";
import { toPosixPath } from "@repoatlas/schema";
import { type ManifestFindings, readPyproject, readSetupCfg } from "./manifests.ts";
import {
  computeProjectInfo,
  inferConventionalRoots,
  type PythonProjectInfo,
} from "./project-info.ts";

export { iniLines, parseIni } from "./ini.ts";
export { readPyproject, readSetupCfg } from "./manifests.ts";
export {
  computeProjectInfo,
  inferConventionalRoots,
  isInitFile,
  type ModuleTable,
  moduleNameFor,
  type PythonProjectInfo,
  readProjectInfo,
  tableFromPaths,
} from "./project-info.ts";
export { isStdlibModule, PYTHON_STDLIB_MODULES } from "./stdlib.ts";
export { parseToml, type TomlTable, type TomlValue } from "./toml.ts";

const MAX_MANIFESTS = 100;
const MAX_MANIFEST_BYTES = 1_000_000;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Manifest paths (pyproject.toml, setup.cfg): the root ones always, nested ones in order. */
function manifestPaths(ctx: ProjectContext): string[] {
  const found = new Set<string>(["pyproject.toml", "setup.cfg"]);
  for (const file of ctx.allFiles) {
    const path = toPosixPath(file.path);
    const name = baseName(path);
    if ((name === "pyproject.toml" || name === "setup.cfg") && file.bytes <= MAX_MANIFEST_BYTES) {
      found.add(path);
    }
  }
  return [...found]
    .filter((p) => ctx.repo.exists(p))
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))
    .slice(0, MAX_MANIFESTS);
}

async function readManifest(ctx: ProjectContext, path: string): Promise<ManifestFindings> {
  const empty: ManifestFindings = { roots: [], projectNames: [] };
  const text = await ctx.repo.read(path);
  if (text === undefined) return empty;
  const baseDir = dirOf(path);
  return baseName(path) === "pyproject.toml"
    ? readPyproject(text, baseDir)
    : readSetupCfg(text, baseDir);
}

/**
 * Plugin `prepare` step. Finds package roots (repo root, `src/`, directories named by
 * pyproject.toml / setup.cfg, and layouts implied by `__init__.py` files) and computes
 * module names for every Python file. Only reads through `ctx.repo`. Never throws: any
 * failure falls back to roots inferred from the file list alone.
 */
export async function pythonPrepare(ctx: ProjectContext): Promise<PythonProjectInfo> {
  const pythonFiles = ctx.files.map((f) => toPosixPath(f.path)).filter((p) => p.endsWith(".py"));
  const allPaths = [...ctx.allFiles.map((f) => toPosixPath(f.path)), ...pythonFiles];
  const roots = new Set<string>(["", ...inferConventionalRoots(allPaths)]);
  const projectNames: string[] = [];
  try {
    if (ctx.repo.isDir("src")) roots.add("src");
    for (const path of manifestPaths(ctx)) {
      const findings = await readManifest(ctx, path);
      projectNames.push(...findings.projectNames);
      for (const root of findings.roots) {
        if (root === "" || ctx.repo.isDir(root)) roots.add(root);
      }
    }
  } catch {
    // A broken RepoView must not fail the analysis; keep what was inferred so far.
  }
  return computeProjectInfo(pythonFiles, roots, projectNames);
}
