import { promises as fsPromises, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import { isSafeRelativePath } from "@repoatlas/schema";
import type { RepoView } from "./types.ts";

/**
 * A read-only RepoView over a real directory (used by fixtures/tests and the CLI).
 *
 * Safety rules (docs/SECURITY.md):
 * - Inputs are POSIX repo-relative paths. Anything that is not `isSafeRelativePath`, or that
 *   resolves outside `rootDir`, behaves as "does not exist".
 * - Symlinks are never followed: a symlink (at any level of the path) counts as non-existent.
 */
export function createDirRepoView(rootDir: string): RepoView {
  const root = path.resolve(rootDir);

  /** Returns the absolute path for a safe relative path, or undefined when unsafe. */
  function toAbsolute(rel: string): string | undefined {
    if (rel === "") return root;
    if (!isSafeRelativePath(rel)) return undefined;
    // ":" in a segment would address NTFS alternate data streams on Windows.
    if (process.platform === "win32" && rel.includes(":")) return undefined;
    const abs = path.join(root, ...rel.split("/"));
    const back = path.relative(root, abs);
    if (back === "" || back.startsWith("..") || path.isAbsolute(back)) return undefined;
    return abs;
  }

  /** lstat of the target, or undefined if missing/unsafe/behind a symlink. */
  function safeStat(rel: string): { abs: string; stat: Stats } | undefined {
    const abs = toAbsolute(rel);
    if (abs === undefined) return undefined;
    try {
      // Check every ancestor too: lstat on "link/file" would follow "link".
      if (rel !== "") {
        const parts = rel.split("/").filter((p) => p !== "");
        let current = root;
        for (const part of parts.slice(0, -1)) {
          current = path.join(current, part);
          const s = lstatSync(current);
          if (s.isSymbolicLink() || !s.isDirectory()) return undefined;
        }
      }
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) return undefined;
      return { abs, stat };
    } catch {
      return undefined;
    }
  }

  function readSync(rel: string): string | undefined {
    const hit = safeStat(rel);
    if (!hit?.stat.isFile()) return undefined;
    try {
      return readFileSync(hit.abs, "utf8");
    } catch {
      return undefined;
    }
  }

  return {
    exists: (rel) => safeStat(rel) !== undefined,
    isDir: (rel) => safeStat(rel)?.stat.isDirectory() === true,
    readSync,
    async read(rel) {
      const hit = safeStat(rel);
      if (!hit?.stat.isFile()) return undefined;
      try {
        return await fsPromises.readFile(hit.abs, "utf8");
      } catch {
        return undefined;
      }
    },
    list(dir) {
      const hit = safeStat(dir);
      if (!hit?.stat.isDirectory()) return [];
      try {
        return readdirSync(hit.abs, { withFileTypes: true })
          .filter((e) => !e.isSymbolicLink())
          .map((e) => e.name)
          .sort();
      } catch {
        return [];
      }
    },
  };
}
