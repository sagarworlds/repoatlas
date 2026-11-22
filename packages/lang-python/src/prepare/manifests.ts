import { isSafeRelativePath, toPosixPath } from "@repoatlas/schema";
import { iniLines, parseIni } from "./ini.ts";
import { getString, getStringList, getTable, getTableList, parseToml } from "./toml.ts";

/** Package roots and project names found in one manifest. Roots are repo-relative. */
export interface ManifestFindings {
  roots: string[];
  projectNames: string[];
}

/** `baseDir/relative` as a clean repo-relative path, or undefined for unsafe input. */
export function joinSafe(baseDir: string, relative: string): string | undefined {
  const rel = toPosixPath(relative.trim());
  if (!isSafeRelativePath(rel)) return undefined;
  if (baseDir === "") return rel;
  return rel === "" ? baseDir : `${baseDir}/${rel}`;
}

/**
 * `package-dir` maps a package to its directory. `"" = "src"` means root `src`.
 * `shop = "lib/shop"` means root `lib` (the directory must end with the package path).
 */
function rootFromPackageDir(pkg: string, dir: string): string | undefined {
  const cleaned = toPosixPath(dir.trim());
  if (pkg === "") return cleaned;
  const suffix = pkg.split(".").join("/");
  if (cleaned === suffix) return "";
  if (cleaned.endsWith(`/${suffix}`)) return cleaned.slice(0, -(suffix.length + 1));
  return undefined;
}

function dirName(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? undefined : path.slice(0, slash);
}

/** Roots and names from the parts of `pyproject.toml` that we understand. */
export function readPyproject(text: string, baseDir: string): ManifestFindings {
  const toml = parseToml(text);
  const rels: string[] = [];
  const projectNames: string[] = [];

  const projectName = getString(getTable(toml, "project"), "name");
  if (projectName) projectNames.push(projectName);

  // setuptools
  const setuptools = getTable(toml, "tool", "setuptools");
  rels.push(...getStringList(getTable(setuptools ?? {}, "packages", "find"), "where"));
  const packageDir = getTable(setuptools ?? {}, "package-dir");
  for (const [pkg, dir] of Object.entries(packageDir ?? {})) {
    if (typeof dir !== "string") continue;
    const root = rootFromPackageDir(pkg, dir);
    if (root !== undefined) rels.push(root);
  }

  // poetry: packages = [{ include = "x", from = "src" }]
  const poetry = getTable(toml, "tool", "poetry");
  for (const entry of getTableList(poetry, "packages")) {
    const from = getString(entry, "from");
    if (from) rels.push(from);
  }
  const poetryName = getString(poetry, "name");
  if (poetryName) projectNames.push(poetryName);

  // hatch: packages = ["src/shop"] means root "src"
  const build = getTable(toml, "tool", "hatch", "build");
  const wheel = getTable(build ?? {}, "targets", "wheel");
  for (const entry of [...getStringList(wheel, "packages"), ...getStringList(build, "packages")]) {
    const parent = dirName(toPosixPath(entry));
    if (parent !== undefined) rels.push(parent);
  }

  // flit and pdm
  const flitName = getString(getTable(toml, "tool", "flit", "module"), "name");
  if (flitName) projectNames.push(flitName);
  const pdmDir = getString(getTable(toml, "tool", "pdm", "build"), "package-dir");
  if (pdmDir) rels.push(pdmDir);

  return { roots: joinAll(baseDir, rels), projectNames };
}

/** Roots and the project name from `setup.cfg`. */
export function readSetupCfg(text: string, baseDir: string): ManifestFindings {
  const ini = parseIni(text);
  const rels: string[] = [];
  const projectNames: string[] = [];

  const name = ini.get("metadata")?.get("name");
  if (name) projectNames.push(name.trim());

  for (const line of iniLines(ini.get("options")?.get("package_dir"))) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const root = rootFromPackageDir(line.slice(0, eq).trim(), line.slice(eq + 1));
    if (root !== undefined) rels.push(root);
  }
  for (const where of iniLines(ini.get("options.packages.find")?.get("where"))) rels.push(where);

  return { roots: joinAll(baseDir, rels), projectNames };
}

function joinAll(baseDir: string, rels: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of rels) {
    const joined = joinSafe(baseDir, rel);
    if (joined !== undefined) out.push(joined);
  }
  return out;
}
