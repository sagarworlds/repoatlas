import type { ResourceLimits } from "node:worker_threads";
import type { PluginProjectInfo } from "@repoatlas/plugin-api";
import type { LanguageId } from "@repoatlas/schema";
import type { WorkerEntry } from "./entry-location.ts";

/** A file to extract (what the worker needs; no plugin objects cross the thread boundary). */
export interface PoolFile {
  path: string;
  bytes: number;
  content: string;
  language: LanguageId;
}

/**
 * The result of one file. `extraction` is untrusted: the caller must validate it with the schema.
 * "unavailable" means the pool itself is broken (workers cannot start): the caller should
 * extract on the main thread instead. "aborted" means the session was cancelled.
 */
export type PoolOutcome =
  | { ok: true; extraction: unknown }
  | {
      ok: false;
      reason: "extract-error" | "timeout" | "unavailable" | "aborted";
      message?: string;
    };

export interface PoolSession {
  extract(file: PoolFile): Promise<PoolOutcome>;
  /** Drops this session's queued files and tells the workers to forget it. */
  close(): void;
}

export interface PoolStats {
  /** Workers started over the lifetime of the pool (replacements included). */
  spawned: number;
  /** Workers that died (crash, watchdog) or were recycled and had to be replaced. */
  replaced: number;
  /** Workers alive right now (starting or ready). */
  alive: number;
  /** Files answered with a result by a worker. */
  completed: number;
}

export interface ExtractionPool {
  /** Starts a session for one analysis. Throws when `info` cannot be sent to a thread. */
  openSession(pluginId: string, info: PluginProjectInfo, signal?: AbortSignal): PoolSession;
  /** Raises the thread cap (never lowers it). */
  allowWorkers(count: number): void;
  stats(): PoolStats;
  /** Terminates all workers; pending files end as "aborted". */
  close(): Promise<void>;
}

export interface PoolOptions {
  maxWorkers: number;
  entry: WorkerEntry;
  /** Per-thread memory limits so one hostile file cannot take the server down. */
  resourceLimits?: ResourceLimits;
  /** A worker that does not answer its current file within this time is killed. */
  watchdogMs?: number;
  /** A worker that is not ready within this time is killed. */
  startupTimeoutMs?: number;
  /** Files sent to one worker at a time (one running plus queued ones that hide latency). */
  maxInFlightPerWorker?: number;
  /** A worker is replaced after this many files, to bound the growth of its wasm memory. */
  recycleAfterJobs?: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 768,
  maxYoungGenerationSizeMb: 64,
};
