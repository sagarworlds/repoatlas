import type { ProjectContext, RepoView } from "@repoatlas/plugin-api";

/** In-memory RepoView for unit tests: `{ "src/a.ts": "export const a = 1;" }`. */
export function memoryRepo(files: Record<string, string>): RepoView {
  const dirs = new Set<string>([""]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    exists: (p) => p in files || dirs.has(p),
    isDir: (p) => dirs.has(p),
    readSync: (p) => files[p],
    read: async (p) => files[p],
    list(dir) {
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = new Set<string>();
      for (const p of [...Object.keys(files), ...dirs]) {
        if (p !== "" && p.startsWith(prefix)) {
          const first = p.slice(prefix.length).split("/")[0];
          if (first) names.add(first);
        }
      }
      return [...names].sort();
    },
  };
}

export function memoryContext(files: Record<string, string>): ProjectContext {
  const repo = memoryRepo(files);
  const all = Object.keys(files).map((path) => ({ path, bytes: files[path]?.length ?? 0 }));
  return {
    files: all.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f.path) && !f.path.endsWith(".d.ts")),
    allFiles: all,
    repo,
  };
}
