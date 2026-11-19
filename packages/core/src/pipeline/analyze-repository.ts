import type { LanguagePlugin } from "@repoatlas/plugin-api";
import { throwIfAborted } from "../security/abort.ts";
import type {
  FetchedRepo,
  Fetcher,
  Limits,
  PipelineResult,
  ProgressCallback,
  RepoRequest,
} from "../types.ts";
import { runPipeline } from "./run-pipeline.ts";

export interface AnalyzeRepositoryOptions {
  fetcher: Fetcher;
  request: RepoRequest;
  limits: Limits;
  plugins: LanguagePlugin[];
  /** Fresh, empty directory to extract the repository into, chosen from the commit SHA. */
  destDirFor: (commitSha: string) => string | Promise<string>;
  /** Cache check: return true to skip the download and analysis for this commit. */
  shouldSkip?:
    | ((info: { commitSha: string; ref: string }) => boolean | Promise<boolean>)
    | undefined;
  onProgress?: ProgressCallback | undefined;
  /** Called as soon as the ref is resolved to a commit (before any download). */
  onResolved?: ((info: { commitSha: string; ref: string }) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export type AnalyzeRepositoryResult =
  | { status: "skipped"; commitSha: string; ref: string }
  | { status: "analyzed"; fetched: FetchedRepo; result: PipelineResult };

/**
 * The function the API job and the CLI call: resolve the ref to a commit SHA, let the
 * caller short-circuit on a cache hit, fetch the repository, then run the pipeline.
 */
export async function analyzeRepository(
  options: AnalyzeRepositoryOptions,
): Promise<AnalyzeRepositoryResult> {
  const { fetcher, request, limits, signal } = options;

  try {
    options.onProgress?.({ phase: "fetching", filesDone: 0, filesTotal: 0 });
  } catch {
    // A faulty progress listener must never break the analysis.
  }
  const resolved = await fetcher.resolve(request, signal);
  options.onResolved?.(resolved);
  throwIfAborted(signal);

  if (options.shouldSkip && (await options.shouldSkip(resolved))) {
    return { status: "skipped", commitSha: resolved.commitSha, ref: resolved.ref };
  }

  const destDir = await options.destDirFor(resolved.commitSha);
  // Fetch the exact commit we resolved, not the moving branch name.
  const downloaded = await fetcher.fetch(
    { ...request, ref: resolved.commitSha },
    destDir,
    limits,
    signal,
  );
  // Report the ref the user asked for (or the default branch), not the SHA we pinned.
  const fetched: FetchedRepo = { ...downloaded, ref: resolved.ref };
  throwIfAborted(signal);

  const result = await runPipeline({
    fetched,
    plugins: options.plugins,
    limits,
    onProgress: options.onProgress,
    signal,
  });
  return { status: "analyzed", fetched, result };
}
