import type { RepoView } from "@repoatlas/plugin-api";

/** Workspace package name -> repo-relative directory (POSIX, "" is the repo root). */
export type WorkspacePackages = Record<string, string>;

/**
 * Reads the glob list under the top-level "packages:" key of pnpm-workspace.yaml.
 * Only the simple form is supported (a block list of "- glob" lines); there is no YAML
 * dependency on purpose. Negated globs ("!x") are dropped.
 */
export function parsePnpmWorkspaceGlobs(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      // A new top-level key: only "packages:" is interesting.
      inPackages = /^packages\s*:/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!m?.[1]) continue;
    const glob = m[1].replace(/^["']|["']$/g, "");
    if (!glob.startsWith("!")) globs.push(glob);
  }
  return globs;
}

/** `workspaces` in package.json is either string[] or { packages: string[] }. */
export function parsePackageJsonWorkspaces(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const ws = (json as Record<string, unknown>).workspaces;
  const list = Array.isArray(ws)
    ? ws
    : typeof ws === "object" && ws !== null
      ? (ws as Record<string, unknown>).packages
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((g): g is string => typeof g === "string" && !g.startsWith("!"));
}

function normalizeDir(glob: string): string {
  let g = glob.replaceAll("\\", "/");
  while (g.startsWith("./")) g = g.slice(2);
  while (g.endsWith("/")) g = g.slice(0, -1);
  return g;
}

/**
 * Expands "dir/*", "dir/**" and plain directory globs against the repo. Only trailing-wildcard
 * globs are supported (that covers nearly every real workspace file).
 */
export function expandWorkspaceGlob(repo: RepoView, glob: string): string[] {
  const g = normalizeDir(glob);
  if (g.includes("..")) return [];
  const star = g.indexOf("*");
  if (star < 0) return repo.isDir(g) ? [g] : [];
  const base = g.slice(0, star).replace(/\/$/, "");
  const rest = g.slice(star);
  if (rest !== "*" && rest !== "**") return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const name of repo.list(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const child = dir === "" ? name : `${dir}/${name}`;
      if (!repo.isDir(child)) continue;
      out.push(child);
      if (rest === "**" && depth < 4) walk(child, depth + 1);
    }
  };
  walk(base, 0);
  return out;
}

function readJson(repo: RepoView, path: string): unknown {
  const text = repo.readSync(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined; // manifests are data; a broken one is just ignored
  }
}

/** Finds workspace packages (name -> directory) from pnpm-workspace.yaml and package.json. */
export function buildWorkspacePackages(repo: RepoView): WorkspacePackages {
  const globs: string[] = [];
  const yaml = repo.readSync("pnpm-workspace.yaml");
  if (yaml !== undefined) globs.push(...parsePnpmWorkspaceGlobs(yaml));
  globs.push(...parsePackageJsonWorkspaces(readJson(repo, "package.json")));

  const packages: WorkspacePackages = {};
  for (const glob of globs) {
    for (const dir of expandWorkspaceGlob(repo, glob)) {
      const manifest = readJson(repo, `${dir}/package.json`);
      const name =
        typeof manifest === "object" && manifest !== null
          ? (manifest as Record<string, unknown>).name
          : undefined;
      if (typeof name === "string" && name !== "" && packages[name] === undefined) {
        packages[name] = dir;
      }
    }
  }
  return packages;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];

function withExtensions(base: string): string[] {
  const out = TS_EXTENSIONS.map((ext) => `${base}${ext}`);
  for (const ext of TS_EXTENSIONS) out.push(`${base}/index${ext}`);
  return out;
}

/** Swaps a build-output extension/dir for its likely source twin ("dist/a.js" -> "src/a"). */
function sourceCandidates(entry: string): string[] {
  let e = normalizeDir(entry);
  e = e.replace(/\.(d\.ts|d\.mts|d\.cts|ts|tsx|mts|cts|js|mjs|cjs|jsx)$/, "");
  const out = [e];
  const swapped = e.replace(/^(dist|lib|build|out)\//, "src/");
  if (swapped !== e) out.push(swapped);
  return out;
}

function manifestEntries(repo: RepoView, dir: string): string[] {
  const manifest = readJson(repo, dir === "" ? "package.json" : `${dir}/package.json`);
  if (typeof manifest !== "object" || manifest === null) return [];
  const m = manifest as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["source", "types", "typings", "module", "main"]) {
    const v = m[key];
    if (typeof v === "string") out.push(v);
  }
  const exp = m.exports;
  if (typeof exp === "string") out.push(exp);
  else if (typeof exp === "object" && exp !== null) {
    const root = (exp as Record<string, unknown>)["."];
    if (typeof root === "string") out.push(root);
    else if (typeof root === "object" && root !== null) {
      for (const v of Object.values(root)) if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

/**
 * Resolves "@acme/utils" or "@acme/utils/sub" to a repo file when "@acme/utils" is a
 * workspace package. Looks at package.json entry fields (mapping dist/ -> src/ because
 * nothing is built) and then at conventional index files. Returns a POSIX repo path.
 */
export function resolveWorkspaceImport(
  repo: RepoView,
  packages: WorkspacePackages,
  specifier: string,
): string | undefined {
  // Longest package name wins ("@a/b-c" vs "@a/b").
  const names = Object.keys(packages).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const dir = packages[name];
    if (dir === undefined) continue;
    const sub = specifier === name ? "" : specifier.slice(name.length + 1);
    const prefix = dir === "" ? "" : `${dir}/`;
    const candidates: string[] = [];
    if (sub === "") {
      for (const entry of manifestEntries(repo, dir)) {
        for (const c of sourceCandidates(entry)) candidates.push(...withExtensions(prefix + c));
      }
      candidates.push(...withExtensions(`${prefix}src/index`), ...withExtensions(`${prefix}index`));
    } else {
      candidates.push(...withExtensions(prefix + sub), ...withExtensions(`${prefix}src/${sub}`));
    }
    for (const c of candidates) {
      if (repo.exists(c) && !repo.isDir(c)) return c;
    }
  }
  return undefined;
}

/**
 * `paths` entries that make the TypeScript compiler itself resolve workspace package
 * names ("@acme/utils" -> its entry file, "@acme/utils/*" -> its src or root). Without
 * them the checker sees an unresolved module, types every imported symbol as `any`, and
 * cross-package calls, extends and type references would be lost. Targets are absolute
 * virtual paths, so they do not depend on where a tsconfig declared its own `paths`.
 */
export function workspacePathMappings(
  repo: RepoView,
  packages: WorkspacePackages,
  toVirtual: (repoPath: string) => string,
): Record<string, string[]> {
  const mappings: Record<string, string[]> = {};
  for (const [name, dir] of Object.entries(packages)) {
    if (dir === "") continue; // the repo root package: "/*" would shadow everything
    const entry = resolveWorkspaceImport(repo, packages, name);
    if (entry !== undefined) mappings[name] = [toVirtual(entry)];
    mappings[`${name}/*`] = [toVirtual(`${dir}/src/*`), toVirtual(`${dir}/*`)];
  }
  return mappings;
}
