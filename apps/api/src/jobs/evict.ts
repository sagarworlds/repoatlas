import { rm } from "node:fs/promises";
import type { GraphStore } from "@repoatlas/store";
import type { FastifyBaseLogger } from "fastify";
import { sourcesDirFor } from "./storage.ts";

/**
 * Keeps at most `keep` finished (done or failed) analyses: deletes the oldest ones (rows
 * cascade to their graph) and removes a commit's sources directory once no live analysis
 * refers to that commit. A failed analysis does not pin sources (it has no graph to read).
 */
export async function evictOldAnalyses(
  store: GraphStore,
  dataDir: string,
  keep: number,
  log: FastifyBaseLogger,
): Promise<number> {
  const evictable = store.listEvictable(keep);
  if (evictable.length === 0) return 0;

  const shas = new Set<string>();
  for (const analysis of evictable) {
    if (analysis.commitSha) shas.add(analysis.commitSha);
    store.deleteAnalysis(analysis.id);
  }

  for (const sha of shas) await removeSourcesIfUnused(store, dataDir, sha, log);
  log.info({ evicted: evictable.length }, "evicted old analyses");
  return evictable.length;
}

/**
 * Deletes `sources/{sha}` unless a done or in-flight analysis still needs it. Failed rows
 * are ignored on purpose: they keep their error message but never read sources.
 */
export async function removeSourcesIfUnused(
  store: GraphStore,
  dataDir: string,
  sha: string,
  log: FastifyBaseLogger,
): Promise<void> {
  // Large limit: includes in-flight rows, which may still need the sources.
  const needed = store
    .listAnalyses(1_000_000)
    .some((a) => a.commitSha === sha && a.status !== "failed");
  if (needed) return;
  try {
    await rm(sourcesDirFor(dataDir, sha), { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, sha }, "could not remove unused sources");
  }
}
