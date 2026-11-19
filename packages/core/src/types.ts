import type { AnalysisStats, GraphEdge, GraphNode, RollupRow, Unresolved } from "@repoatlas/schema";

/** Resource limits (SECURITY §3, §4). Values come from env config in the API. */
export interface Limits {
  maxTarballBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  analysisTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTarballBytes: 209_715_200,
  maxFiles: 20_000,
  maxFileBytes: 1_048_576,
  analysisTimeoutMs: 600_000,
};

export interface RepoRequest {
  owner: string;
  repo: string;
  /** Branch, tag or SHA. Undefined = default branch. */
  ref?: string | undefined;
}

/** A repository that has been fetched and safely extracted to local disk. */
export interface FetchedRepo {
  owner: string;
  repo: string;
  /** The ref that was requested, or the default branch name. */
  ref: string;
  commitSha: string;
  /** Absolute path of the directory holding the extracted files (read-only for the pipeline). */
  rootDir: string;
  /** Entries skipped during extraction (symlinks, unsafe names, oversized...). */
  skippedFiles: { reason: string; count: number }[];
}

/**
 * Where repositories come from. `GitHubFetcher` in production, `LocalDirFetcher` in tests,
 * so tests never hit the network.
 */
export interface Fetcher {
  /** Resolve `req` to a commit SHA without downloading (used for the cache lookup). */
  resolve(req: RepoRequest, signal?: AbortSignal): Promise<{ commitSha: string; ref: string }>;
  /** Download/extract into `destDir` (a fresh, empty directory owned by the caller). */
  fetch(
    req: RepoRequest,
    destDir: string,
    limits: Limits,
    signal?: AbortSignal,
  ): Promise<FetchedRepo>;
}

export interface ProgressEvent {
  phase: "fetching" | "parsing" | "resolving" | "persisting";
  filesDone: number;
  filesTotal: number;
}
export type ProgressCallback = (event: ProgressEvent) => void;

/** Output of the pipeline stages 3-9 and 11 (persisting is done by the caller). */
export interface PipelineResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rollups: RollupRow[];
  unresolved: Unresolved[];
  stats: AnalysisStats;
}
