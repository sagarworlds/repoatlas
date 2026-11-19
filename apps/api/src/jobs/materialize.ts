import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FetchedRepo, Fetcher, Limits, RepoRequest } from "@repoatlas/core";
import { sourcesDirFor, sourcesRoot } from "./storage.ts";

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Wraps a Fetcher so the extracted sources end up in DATA_DIR/sources/{sha}:
 *  - if that directory already exists (an earlier analysis of the same commit) it is reused
 *    and nothing is downloaded;
 *  - otherwise the inner fetcher extracts into `tmpDir` and the directory is renamed into
 *    place (atomic on one volume), so a half-extracted tree is never visible as sources/{sha};
 *  - a fetcher that ignores `destDir` (LocalDirFetcher in tests) is copied into place so the
 *    source endpoint always reads from DATA_DIR/sources.
 * `analyzeRepository` always calls `fetch` with `ref` = the resolved commit SHA.
 */
export function withSourceStorage(inner: Fetcher, dataDir: string, tmpDir: string): Fetcher {
  return {
    resolve: (req, signal) => inner.resolve(req, signal),

    async fetch(
      req: RepoRequest,
      _destDir: string,
      limits: Limits,
      signal?: AbortSignal,
    ): Promise<FetchedRepo> {
      const sha = req.ref ?? "";
      const target = sourcesDirFor(dataDir, sha);

      if (await isDirectory(target)) {
        return {
          owner: req.owner,
          repo: req.repo,
          ref: sha,
          commitSha: sha,
          rootDir: target,
          skippedFiles: [],
        };
      }

      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      const fetched = await inner.fetch(req, tmpDir, limits, signal);
      if (path.resolve(fetched.rootDir) !== path.resolve(tmpDir)) {
        await cp(fetched.rootDir, tmpDir, { recursive: true });
      }

      await mkdir(sourcesRoot(dataDir), { recursive: true });
      try {
        await rename(tmpDir, target);
      } catch (err) {
        // Another job may have stored the same commit meanwhile: then use theirs.
        if (!(await isDirectory(target))) throw err;
        await rm(tmpDir, { recursive: true, force: true });
      }
      return { ...fetched, rootDir: target };
    },
  };
}
