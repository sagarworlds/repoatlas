// Copies the production externals (and their runtime dependencies) out of the pnpm
// workspace install into <app>/node_modules as plain folders (no symlinks), so the result
// can be copied to the server with Explorer/robocopy. Versions are exactly the ones the
// lockfile installed. Nothing is downloaded and no repo script runs.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

/** Build-only dependencies that are not needed at runtime. */
const BUILD_ONLY = new Set(["node-addon-api"]);

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
}

/** Finds the folder of an installed package, starting the lookup from `fromDir`. */
export function findPackageDir(name: string, fromDir: string): string {
  const req = createRequire(path.join(fromDir, "noop.js"));
  // Walk up from the resolved entry file to the folder whose package.json has this name.
  let dir = path.dirname(req.resolve(name));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest) && readPackageJson(dir).name === name) return realpathSync(dir);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate package folder for ${name}`);
    dir = parent;
  }
}

/** Skips build inputs and other platforms' native binaries to keep the bundle small. */
export function shouldCopy(pkgName: string, relPath: string): boolean {
  const rel = relPath.split(path.sep).join("/");
  if (pkgName === "better-sqlite3") {
    if (rel === "deps" || rel.startsWith("deps/")) return false; // SQLite C sources
    if (rel === "src" || rel.startsWith("src/")) return false; // C++ sources
    if (rel === "binding.gyp") return false;
    if (rel.startsWith("prebuilds/"))
      return rel === `prebuilds/${process.platform}-${process.arch}.node`;
  }
  return true;
}

/**
 * Copies each package in `names` plus its runtime dependencies into `<appDir>/node_modules`.
 * `fromDirs` maps a package name to a directory from which it can be resolved.
 * Returns name -> exact installed version.
 */
export function copyProductionPackages(
  names: readonly string[],
  fromDirs: Record<string, string>,
  appDir: string,
): Record<string, string> {
  const versions: Record<string, string> = {};
  const nodeModules = path.join(appDir, "node_modules");
  const visit = (name: string, fromDir: string): void => {
    if (name in versions) return;
    const src = findPackageDir(name, fromDir);
    const pkg = readPackageJson(src);
    versions[name] = pkg.version;
    const dest = path.join(nodeModules, ...name.split("/"));
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, {
      recursive: true,
      filter: (file) => {
        const rel = path.relative(src, file);
        return rel === "" || shouldCopy(name, rel);
      },
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!BUILD_ONLY.has(dep)) visit(dep, src);
    }
  };
  for (const name of names) {
    const from = fromDirs[name];
    if (from === undefined) throw new Error(`No resolve directory for ${name}`);
    visit(name, from);
  }
  return versions;
}
