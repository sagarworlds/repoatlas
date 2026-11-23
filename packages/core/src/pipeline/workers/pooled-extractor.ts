import type { LanguagePlugin, PluginProjectInfo } from "@repoatlas/plugin-api";
import type { FileExtraction, LanguageId } from "@repoatlas/schema";
import { createDefaultRegistry } from "../../plugins/default-registry.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { LoadedFile } from "../read-sources.ts";
import { errorMessage } from "../util.ts";
import { acceptExtraction } from "./accept.ts";
import type { PoolSession } from "./pool.ts";
import { acquireSharedPool, type PoolLease } from "./shared-pool.ts";
import { computeWorkerCount, type WorkerSetting } from "./worker-count.ts";

/** Pipeline-level settings for the extraction pool (undefined = single thread). */
export interface ExtractPoolSettings {
  /** Thread count, or "auto" for CPUs minus one. 0 or 1 means no pool. */
  workers: WorkerSetting;
  /** Files per worker before another thread is worth starting (default 50). Tests lower it. */
  filesPerWorker?: number | undefined;
  /** Replaces the shared pool (tests). Return undefined to say "no threads available". */
  acquirePool?: ((maxWorkers: number) => PoolLease | undefined) | undefined;
}

/** Extracts files on worker threads; falls back to `fallback` when the pool is unusable. */
export interface PooledExtractor {
  /** Number of threads this extractor asked for (also its concurrency basis). */
  readonly workerCount: number;
  extract(file: LoadedFile, language: LanguageId | undefined): Promise<FileExtraction | undefined>;
  close(): void;
}

/**
 * Worker threads can only run plugins they can load themselves: Tier 1, per-file, and
 * registered in the default registry (the same object, not just the same id).
 */
export function isPoolable(plugin: LanguagePlugin): boolean {
  return (
    plugin.tier === 1 &&
    plugin.analyzeProject === undefined &&
    createDefaultRegistry().byId(plugin.id) === plugin
  );
}

export interface PooledExtractorInput {
  settings: ExtractPoolSettings | undefined;
  plugin: LanguagePlugin;
  info: PluginProjectInfo;
  /** Files that really need extraction (cache hits excluded). */
  fileCount: number;
  signal: AbortSignal;
  diagnostics: Diagnostics;
  /** The single-thread path: used when the pool breaks mid-run. */
  fallback(file: LoadedFile, language: LanguageId | undefined): Promise<FileExtraction | undefined>;
}

/** Returns undefined when the work should run on the main thread (the default). */
export function openPooledExtractor(input: PooledExtractorInput): PooledExtractor | undefined {
  const { settings, plugin, diagnostics, signal } = input;
  if (settings === undefined || !isPoolable(plugin)) return undefined;
  const workerCount = computeWorkerCount(settings.workers, input.fileCount, {
    filesPerWorker: settings.filesPerWorker,
  });
  if (workerCount === 0) return undefined;

  let lease: PoolLease | undefined;
  let session: PoolSession | undefined;
  try {
    lease = (settings.acquirePool ?? acquireSharedPool)(workerCount);
    session = lease?.pool.openSession(plugin.id, input.info, signal);
  } catch (err) {
    // For example `info` holds a function and cannot be sent to a thread.
    diagnostics.addPluginError(plugin.id, "pool", err);
  }
  if (lease === undefined || session === undefined) {
    lease?.release();
    return undefined;
  }
  const activeSession = session;
  const activeLease = lease;
  let poolFailed = false;

  return {
    workerCount,
    async extract(file, language) {
      if (language === undefined) {
        diagnostics.addSkip("extract-error");
        return undefined;
      }
      if (poolFailed) return input.fallback(file, language);
      const outcome = await activeSession.extract({
        path: file.path,
        bytes: file.bytes,
        content: file.content,
        language,
      });
      if (outcome.ok) {
        const extraction = acceptExtraction(outcome.extraction, file.path);
        if (extraction) return extraction;
        diagnostics.addSkip("invalid-extraction");
        return undefined;
      }
      if (outcome.reason === "aborted" && signal.aborted) return undefined; // the caller checks
      if (outcome.reason === "unavailable" || outcome.reason === "aborted") {
        if (!poolFailed) {
          poolFailed = true;
          diagnostics.addPluginError(
            plugin.id,
            "pool",
            outcome.message ?? errorMessage("pool unavailable"),
          );
        }
        return input.fallback(file, language);
      }
      diagnostics.addSkip(outcome.reason);
      return undefined;
    },
    close() {
      activeSession.close();
      activeLease.release();
    },
  };
}
