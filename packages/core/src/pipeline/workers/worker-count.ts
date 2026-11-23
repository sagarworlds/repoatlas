import { availableParallelism } from "node:os";

/** Hard upper bound on extraction threads, whatever the configuration says. */
export const MAX_POOL_WORKERS = 8;
/** One worker per this many files: small repositories never pay for thread start-up. */
export const DEFAULT_FILES_PER_WORKER = 50;

/** EXTRACT_WORKERS / --workers: a thread count, or "auto" (CPU count minus one). */
export type WorkerSetting = number | "auto";

/**
 * How many worker threads to use for `fileCount` files; 0 means "extract on the main thread".
 * min(configured or CPUs-1, files / filesPerWorker, 8); fewer than 2 disables the pool,
 * because one worker is never faster than the main thread.
 */
export function computeWorkerCount(
  setting: WorkerSetting | undefined,
  fileCount: number,
  options: { cpus?: number; filesPerWorker?: number } = {},
): number {
  if (setting === undefined) return 0;
  const cpus = options.cpus ?? availableParallelism();
  const configured = setting === "auto" ? cpus - 1 : Math.floor(setting);
  const filesPerWorker = Math.max(1, options.filesPerWorker ?? DEFAULT_FILES_PER_WORKER);
  const count = Math.min(configured, Math.floor(fileCount / filesPerWorker), MAX_POOL_WORKERS);
  return count >= 2 ? count : 0;
}
