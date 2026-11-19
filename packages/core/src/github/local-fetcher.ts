import { createHash } from "node:crypto";
import path from "node:path";
import { AnalysisError } from "../errors.ts";
import type { FetchedRepo, Fetcher, Limits, RepoRequest } from "../types.ts";

export interface LocalDirFetcherOptions {
  /** Absolute path of an existing directory. It is used in place, never copied. */
  dir: string;
  /** Defaults to a deterministic 40-char hex string derived from the directory path. */
  commitSha?: string;
  owner?: string;
  repo?: string;
  ref?: string;
}

/**
 * A Fetcher that serves a directory already on disk (tests, the CLI, pipeline tests).
 * `fetch` ignores `destDir` and `limits`: nothing is copied or extracted.
 */
export class LocalDirFetcher implements Fetcher {
  private readonly dir: string;
  private readonly commitSha: string;
  private readonly options: LocalDirFetcherOptions;

  constructor(options: LocalDirFetcherOptions) {
    if (!path.isAbsolute(options.dir)) {
      throw new AnalysisError("INTERNAL", "LocalDirFetcher requires an absolute directory path");
    }
    this.options = options;
    this.dir = path.resolve(options.dir);
    this.commitSha = options.commitSha ?? createHash("sha1").update(this.dir, "utf8").digest("hex");
    if (!/^[0-9a-f]{40}$/.test(this.commitSha)) {
      throw new AnalysisError("INTERNAL", "commitSha must be 40 lowercase hex characters");
    }
  }

  private refFor(req: RepoRequest): string {
    return this.options.ref ?? req.ref ?? "local";
  }

  resolve(req: RepoRequest): Promise<{ commitSha: string; ref: string }> {
    return Promise.resolve({ commitSha: this.commitSha, ref: this.refFor(req) });
  }

  fetch(req: RepoRequest, _destDir: string, _limits: Limits): Promise<FetchedRepo> {
    return Promise.resolve({
      owner: this.options.owner ?? req.owner,
      repo: this.options.repo ?? req.repo,
      ref: this.refFor(req),
      commitSha: this.commitSha,
      rootDir: this.dir,
      skippedFiles: [],
    });
  }
}
