import { rm } from "node:fs/promises";
import { AnalysisError, analyzeRepository, type ProgressEvent } from "@repoatlas/core";
import type { FastifyBaseLogger } from "fastify";
import { limitsFromConfig } from "../config.ts";
import type { ApiDeps } from "../context.ts";
import { evictOldAnalyses, removeSourcesIfUnused } from "./evict.ts";
import { withSourceStorage } from "./materialize.ts";
import { encodeError, tmpDirFor } from "./storage.ts";

export interface JobEnv {
  deps: ApiDeps;
  log: FastifyBaseLogger;
  /** True once shutdown started: an aborted job then stays non-terminal for recovery. */
  isShuttingDown: () => boolean;
}

const PROGRESS_WRITE_INTERVAL_MS = 250;

/**
 * The background job for one analysis: fetch -> pipeline -> persist -> done/failed.
 * Never throws: every failure becomes `status: failed` with a safe message.
 */
export async function runAnalysisJob(
  env: JobEnv,
  analysisId: string,
  cancelSignal: AbortSignal,
): Promise<void> {
  const { store, fetcher, plugins, config } = env.deps;
  const log = env.log.child({ analysisId });

  const record = store.getAnalysis(analysisId);
  if (!record || record.status === "done" || record.status === "failed") return;

  const limits = limitsFromConfig(config);
  const tmpDir = tmpDirFor(config.dataDir, analysisId);
  // Either the caller cancels (shutdown) or the wall-clock timeout fires.
  const signal = AbortSignal.any([cancelSignal, AbortSignal.timeout(limits.analysisTimeoutMs)]);

  let lastWrite = 0;
  let lastPhase = "";
  const onProgress = (event: ProgressEvent): void => {
    const now = Date.now();
    const finished = event.filesTotal > 0 && event.filesDone >= event.filesTotal;
    if (event.phase === lastPhase && !finished && now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) {
      return;
    }
    lastPhase = event.phase;
    lastWrite = now;
    store.updateAnalysis(analysisId, {
      status: event.phase,
      progress: {
        phase: event.phase,
        filesDone: event.filesDone,
        filesTotal: event.filesTotal,
      },
    });
  };

  try {
    store.updateAnalysis(analysisId, {
      status: "fetching",
      progress: { phase: "fetching", filesDone: 0, filesTotal: 0 },
    });

    const outcome = await analyzeRepository({
      fetcher: withSourceStorage(fetcher, config.dataDir, tmpDir),
      request: { owner: record.owner, repo: record.repo, ref: record.ref },
      limits,
      plugins,
      destDirFor: () => tmpDir,
      onResolved: (info) => store.updateAnalysis(analysisId, { commitSha: info.commitSha }),
      onProgress,
      signal,
    });
    if (outcome.status !== "analyzed") {
      throw new AnalysisError("INTERNAL", "Analysis was unexpectedly skipped.");
    }

    const { result, fetched } = outcome;
    store.updateAnalysis(analysisId, {
      status: "persisting",
      progress: { phase: "persisting", filesDone: 0, filesTotal: 0 },
    });
    // One SQLite transaction: either the whole graph is stored or none of it.
    store.saveGraph(analysisId, {
      nodes: result.nodes,
      edges: result.edges,
      rollups: result.rollups,
      unresolved: result.unresolved,
    });
    store.updateAnalysis(analysisId, {
      status: "done",
      commitSha: fetched.commitSha,
      stats: result.stats,
      progress: null,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    log.info({ nodes: result.nodes.length, edges: result.edges.length }, "analysis done");

    // Housekeeping must never turn a finished analysis into a failed one.
    await evictOldAnalyses(store, config.dataDir, config.cacheMaxAnalyses, log).catch((evictErr) =>
      log.warn({ err: evictErr }, "eviction failed"),
    );
  } catch (err) {
    await handleFailure(env, analysisId, err, log);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleFailure(
  env: JobEnv,
  analysisId: string,
  err: unknown,
  log: FastifyBaseLogger,
): Promise<void> {
  if (err instanceof AnalysisError && err.code === "CANCELLED" && env.isShuttingDown()) {
    // Leave the row non-terminal: the next boot re-queues it (see recovery.ts).
    log.info("analysis interrupted by shutdown");
    return;
  }
  let code = "INTERNAL";
  let message = "The analysis failed because of an internal error.";
  if (err instanceof AnalysisError) {
    code = err.code;
    // AnalysisError messages are written to be safe for users (no paths, no secrets).
    if (err.code !== "INTERNAL") message = err.message;
  } else {
    log.error({ err }, "analysis crashed");
  }
  try {
    env.deps.store.updateAnalysis(analysisId, {
      status: "failed",
      progress: null,
      error: encodeError(code, message),
      finishedAt: new Date().toISOString(),
    });
  } catch (storeErr) {
    log.error({ err: storeErr }, "could not record analysis failure");
    return;
  }
  // The extracted sources are useless for a failed analysis; free the disk now.
  const sha = env.deps.store.getAnalysis(analysisId)?.commitSha;
  if (sha) {
    await removeSourcesIfUnused(env.deps.store, env.deps.config.dataDir, sha, log).catch(
      () => undefined,
    );
  }
}
