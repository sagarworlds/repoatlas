import { toPosixPath } from "@repoatlas/schema";

/**
 * What `prepare` computes. It is a plain JSON-friendly object (arrays and records, no Map
 * or Set), so it can be cached or serialised. `resolve` reads it back with
 * `readProjectInfo`, which validates the shape.
 *
 * `type` instead of `interface` on purpose: an object type alias is assignable to
 * `Record<string, unknown>` (the plugin API's PluginProjectInfo); an interface is not.
 */
export type PythonProjectInfo = {
  version: 1;
  /** Package roots, POSIX, repo-relative, sorted. "" is the repo root. */
  roots: string[];
  /** Dotted module name -> repo-relative file ("shop.models" -> "src/shop/models.py"). */
  moduleToFile: Record<string, string>;
  /** Repo-relative file -> dotted module name. `__init__.py` maps to its package name. */
  fileToModule: Record<string, string>;
  /** Every package name, including implicit namespace packages (directories without __init__). */
  packages: string[];
  /** First segments of all internal module names: imports of anything else are external. */
  internalTopLevel: string[];
  /** Internal top-level names that match a project name from a manifest. */
  mainPackages: string[];
};

/** `PythonProjectInfo` loaded into Maps and Sets for fast lookups. */
export interface ModuleTable {
  roots: string[];
  moduleToFile: Map<string, string>;
  fileToModule: Map<string, string>;
  packages: Set<string>;
  internalTopLevel: Set<string>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isInitFile(path: string): boolean {
  return path === "__init__.py" || path.endsWith("/__init__.py");
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Roots implied by `__init__.py` files: for a chain of package directories the root is the
 * parent of the topmost one. `lib/pkg/sub/__init__.py` + `lib/pkg/__init__.py` gives "lib".
 */
export function inferConventionalRoots(paths: readonly string[]): string[] {
  const initDirs = new Set<string>();
  for (const raw of paths) {
    const path = toPosixPath(raw);
    if (isInitFile(path)) initDirs.add(dirOf(path));
  }
  const roots = new Set<string>();
  for (const dir of initDirs) {
    if (dir === "") continue; // an __init__.py at the repo root says nothing about the root
    let top = dir;
    while (top !== "" && initDirs.has(dirOf(top))) top = dirOf(top);
    roots.add(dirOf(top));
  }
  return [...roots];
}

/** Longest root that contains `path` ("" matches everything). */
function bestRoot(path: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    const contains = root === "" || path.startsWith(`${root}/`);
    if (contains && (best === undefined || root.length > best.length)) best = root;
  }
  return best;
}

/**
 * Dotted module name of a `.py` file relative to the best matching root, or undefined when
 * the file cannot be imported by name (a directory such as `my-app` is not an identifier).
 * `__init__.py` names its package; a root-level `__init__.py` has no name.
 */
export function moduleNameFor(path: string, roots: readonly string[]): string | undefined {
  const posix = toPosixPath(path);
  if (!posix.endsWith(".py")) return undefined;
  const root = bestRoot(posix, roots);
  if (root === undefined) return undefined;
  const relative = root === "" ? posix : posix.slice(root.length + 1);
  const segments = relative.slice(0, -".py".length).split("/");
  if (segments[segments.length - 1] === "__init__") segments.pop();
  if (segments.length === 0 || !segments.every((s) => IDENTIFIER.test(s))) return undefined;
  return segments.join(".");
}

function normalizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "_");
}

/**
 * Pure core of `prepare`: module maps from the Python file list and the chosen roots.
 * Paths are normalised to POSIX first, so Windows-style input gives the same answer.
 * When two files claim one module name (`a.py` and `a/__init__.py`, or two roots), the
 * package wins, then the alphabetically first path. Both files keep their own entry in
 * `fileToModule`.
 */
export function computeProjectInfo(
  pythonFiles: readonly string[],
  rootCandidates: Iterable<string>,
  projectNames: readonly string[] = [],
): PythonProjectInfo {
  const roots = [...new Set([...rootCandidates, ""].map(toPosixPath))].sort();
  const files = [...new Set(pythonFiles.map(toPosixPath))].sort();

  const candidates = new Map<string, string[]>();
  const fileToModule: [string, string][] = [];
  for (const file of files) {
    const name = moduleNameFor(file, roots);
    if (name === undefined) continue;
    fileToModule.push([file, name]);
    const list = candidates.get(name);
    if (list) list.push(file);
    else candidates.set(name, [file]);
  }

  const moduleToFile: [string, string][] = [];
  const packages = new Set<string>();
  const internalTop = new Set<string>();
  for (const [name, list] of candidates) {
    const winner = list.find(isInitFile) ?? list[0];
    if (winner === undefined) continue;
    moduleToFile.push([name, winner]);
    const parts = name.split(".");
    internalTop.add(parts[0] as string);
    // Every proper prefix is a package (possibly an implicit namespace package).
    for (let n = 1; n < parts.length; n++) packages.add(parts.slice(0, n).join("."));
    if (list.some(isInitFile)) packages.add(name);
  }

  const wanted = new Set(projectNames.map(normalizeProjectName));
  const mainPackages = [...internalTop].filter((top) => wanted.has(normalizeProjectName(top)));

  return {
    version: 1,
    roots,
    moduleToFile: Object.fromEntries(moduleToFile),
    fileToModule: Object.fromEntries(fileToModule),
    packages: [...packages].sort(),
    internalTopLevel: [...internalTop].sort(),
    mainPackages: mainPackages.sort(),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

/** Validates data from `prepare` (it may have been through a cache) and loads it. */
export function readProjectInfo(info: unknown): ModuleTable | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const raw = info as Record<string, unknown>;
  if (raw.version !== 1) return undefined;
  const { roots, moduleToFile, fileToModule, packages, internalTopLevel } = raw;
  if (
    !isStringArray(roots) ||
    !isStringRecord(moduleToFile) ||
    !isStringRecord(fileToModule) ||
    !isStringArray(packages) ||
    !isStringArray(internalTopLevel)
  ) {
    return undefined;
  }
  return {
    roots,
    moduleToFile: new Map(Object.entries(moduleToFile)),
    fileToModule: new Map(Object.entries(fileToModule)),
    packages: new Set(packages),
    internalTopLevel: new Set(internalTopLevel),
  };
}

/** Builds a table straight from file paths, for when `info` is missing or malformed. */
export function tableFromPaths(paths: readonly string[]): ModuleTable {
  const posix = paths.map(toPosixPath);
  const roots = new Set<string>(inferConventionalRoots(posix));
  if (posix.some((p) => p.startsWith("src/"))) roots.add("src");
  const info = computeProjectInfo(
    posix.filter((p) => p.endsWith(".py")),
    roots,
  );
  // computeProjectInfo output always validates.
  return readProjectInfo(info) as ModuleTable;
}
