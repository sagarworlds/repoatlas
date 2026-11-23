/**
 * Version of the analysis output format and algorithms. Part of the cache key
 * (owner, repo, commitSha, analyzerVersion): bump it whenever the pipeline would produce
 * different output for the same input, so stored analyses are recomputed.
 */
export const ANALYZER_VERSION = "2";

/** Hard caps on graph size (stats.truncated is set when one is hit). */
export const MAX_NODES = 500_000;
export const MAX_EDGES = 2_000_000;
