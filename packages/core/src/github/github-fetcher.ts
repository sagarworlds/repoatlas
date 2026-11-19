import { pipeline, Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { AnalysisError } from "../errors.ts";
import { throwIfAborted } from "../security/abort.ts";
import { extractTarball } from "../security/tar-extract.ts";
import type { FetchedRepo, Fetcher, Limits, RepoRequest } from "../types.ts";

export interface GitHubFetcherOptions {
  /** Optional GitHub token. Only ever sent to the API host, never to redirect targets. */
  token?: string | undefined;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to https://api.github.com */
  apiBase?: string;
}

const CODELOAD_HOST = "codeload.github.com";
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Only the fields we use; zod validates the untrusted JSON at the boundary.
const RepoInfoSchema = z.object({
  private: z.boolean(),
  default_branch: z.string().min(1),
  size: z.number().nonnegative(),
});
const CommitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

interface ResolvedRepo {
  commitSha: string;
  ref: string;
  /** Repository size in KB as reported by the API. */
  sizeKb: number;
}

/** Fetches public repositories from GitHub via the REST API and tarball download. */
export class GitHubFetcher implements Fetcher {
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly apiOrigin: string;
  private readonly apiBase: string;

  constructor(options: GitHubFetcherOptions = {}) {
    this.token = options.token !== undefined && options.token !== "" ? options.token : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const base = new URL(options.apiBase ?? "https://api.github.com");
    this.apiOrigin = base.origin;
    this.apiBase = base.origin; // path-less: we always build paths ourselves
  }

  async resolve(
    req: RepoRequest,
    signal?: AbortSignal,
  ): Promise<{ commitSha: string; ref: string }> {
    const { commitSha, ref } = await this.resolveInternal(req, signal);
    return { commitSha, ref };
  }

  async fetch(
    req: RepoRequest,
    destDir: string,
    limits: Limits,
    signal?: AbortSignal,
  ): Promise<FetchedRepo> {
    const resolved = await this.resolveInternal(req, signal);
    if (resolved.sizeKb * 1024 > limits.maxTarballBytes) {
      throw new AnalysisError("REPO_TOO_LARGE", "Repository is larger than the allowed size");
    }

    const url = `${this.apiBase}/repos/${seg(req.owner)}/${seg(req.repo)}/tarball/${resolved.commitSha}`;
    const response = await this.request(url, signal);
    if (response.status === 404) {
      await discard(response);
      throw new AnalysisError("REPO_NOT_FOUND", "Repository archive not found");
    }
    if (!response.ok) await this.fail(response, "tarball download");

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limits.maxTarballBytes) {
      await discard(response);
      throw new AnalysisError("REPO_TOO_LARGE", "Repository archive exceeds the allowed size");
    }
    if (response.body === null) {
      throw new AnalysisError("INTERNAL", "GitHub returned an empty archive response");
    }

    // network -> byte counter (compressed limit) -> gunzip -> safe extractor.
    // `pipeline` destroys every stream when one fails and passes the error downstream.
    const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
    const tarBytes = pipeline(
      body,
      createByteLimiter(limits.maxTarballBytes),
      createGunzip(),
      () => {
        // Errors surface through the extractor's iteration of `tarBytes`.
      },
    );

    try {
      const extracted = await extractTarball(tarBytes, destDir, limits, signal);
      return {
        owner: req.owner,
        repo: req.repo,
        ref: resolved.ref,
        commitSha: resolved.commitSha,
        rootDir: destDir,
        skippedFiles: extracted.skipped,
      };
    } catch (err) {
      throwIfAborted(signal);
      if (err instanceof AnalysisError) throw err;
      throw new AnalysisError("INTERNAL", "Failed to download or unpack the repository archive", {
        cause: err,
      });
    }
  }

  /** Repo metadata + commit SHA lookup shared by resolve() and fetch(). */
  private async resolveInternal(req: RepoRequest, signal?: AbortSignal): Promise<ResolvedRepo> {
    const repoPath = `/repos/${seg(req.owner)}/${seg(req.repo)}`;
    const repoRes = await this.request(`${this.apiBase}${repoPath}`, signal);
    if (repoRes.status === 404) {
      await discard(repoRes);
      throw new AnalysisError("REPO_NOT_FOUND", "Repository not found (or it is private)");
    }
    if (!repoRes.ok) await this.fail(repoRes, "repository lookup");
    const info = RepoInfoSchema.safeParse(await readJson(repoRes));
    if (!info.success) {
      throw new AnalysisError("INTERNAL", "Unexpected response from GitHub (repository lookup)");
    }
    if (info.data.private) {
      throw new AnalysisError("REPO_PRIVATE", "Private repositories are not supported");
    }

    const ref = req.ref ?? info.data.default_branch;
    // Encode each path segment ourselves; slashes in refs stay as separators.
    const encodedRef = ref.split("/").map(seg).join("/");
    const commitRes = await this.request(
      `${this.apiBase}${repoPath}/commits/${encodedRef}`,
      signal,
    );
    if (commitRes.status === 404 || commitRes.status === 422) {
      await discard(commitRes);
      throw new AnalysisError("REPO_NOT_FOUND", `Ref "${ref}" was not found in the repository`);
    }
    if (!commitRes.ok) await this.fail(commitRes, "commit lookup");
    const commit = CommitSchema.safeParse(await readJson(commitRes));
    if (!commit.success) {
      throw new AnalysisError("INTERNAL", "Unexpected response from GitHub (commit lookup)");
    }
    return { commitSha: commit.data.sha, ref, sizeKb: info.data.size };
  }

  /**
   * GET with manual redirect handling (SSRF defence). Redirects are followed only to
   * codeload.github.com over https or to the API origin itself; the Authorization header is
   * attached only when the current URL is on the API origin.
   */
  private async request(startUrl: string, signal?: AbortSignal): Promise<Response> {
    let current = new URL(startUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      throwIfAborted(signal);
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "repoatlas",
      };
      if (this.token !== undefined && current.origin === this.apiOrigin) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      let response: Response;
      try {
        response = await this.fetchImpl(current.toString(), {
          headers,
          redirect: "manual",
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (err) {
        throwIfAborted(signal);
        // Do not include the underlying error text: it could echo request details.
        throw new AnalysisError("INTERNAL", "Could not reach GitHub", { cause: err });
      }

      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      await discard(response);
      if (location === null) {
        throw new AnalysisError("INTERNAL", "GitHub redirect without a target");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new AnalysisError("INTERNAL", "GitHub redirect to an invalid URL");
      }
      if (!this.isAllowedRedirect(next)) {
        throw new AnalysisError("INTERNAL", "Refused a redirect to a host that is not allowed");
      }
      current = next;
    }
    throw new AnalysisError("INTERNAL", "Too many redirects from GitHub");
  }

  private isAllowedRedirect(url: URL): boolean {
    if (url.username !== "" || url.password !== "") return false;
    if (url.origin === this.apiOrigin) return true;
    return url.protocol === "https:" && url.hostname === CODELOAD_HOST && url.port === "";
  }

  /** Map an unsuccessful, non-404 response to an AnalysisError. Never returns. */
  private async fail(response: Response, what: string): Promise<never> {
    const status = response.status;
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.get("retry-after") !== null));
    const reset = response.headers.get("x-ratelimit-reset");
    await discard(response);
    if (rateLimited) {
      const resetAt =
        reset !== null && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000) : undefined;
      const when =
        resetAt !== undefined && !Number.isNaN(resetAt.getTime())
          ? ` Resets at ${resetAt.toISOString()}.`
          : "";
      throw new AnalysisError("RATE_LIMITED", `GitHub API rate limit reached.${when}`);
    }
    throw new AnalysisError("INTERNAL", `GitHub request failed (${what}, HTTP ${status})`);
  }
}

/** encodeURIComponent for one path segment (C# analogy: Uri.EscapeDataString). */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/** Release the connection of a response whose body we do not need. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore: best effort
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AnalysisError("INTERNAL", "GitHub returned invalid JSON");
  }
}

/** Passes bytes through; fails with REPO_TOO_LARGE once more than `limit` bytes have passed. */
function createByteLimiter(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(
          new AnalysisError("REPO_TOO_LARGE", "Repository archive exceeds the allowed size"),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
}
