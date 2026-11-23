export { BUNDLED_WORKER_FILE, locateWorkerEntry, type WorkerEntry } from "./entry-location.ts";
export type { FromWorkerMessage, ToWorkerMessage } from "./messages.ts";
export {
  createExtractionPool,
  DEFAULT_RESOURCE_LIMITS,
  type ExtractionPool,
  type PoolFile,
  type PoolOptions,
  type PoolOutcome,
  type PoolSession,
  type PoolStats,
} from "./pool.ts";
export {
  acquireSharedPool,
  type PoolLease,
  type SharedPoolOptions,
  sharedPoolStats,
  shutdownSharedPool,
} from "./shared-pool.ts";
export {
  computeWorkerCount,
  DEFAULT_FILES_PER_WORKER,
  MAX_POOL_WORKERS,
  type WorkerSetting,
} from "./worker-count.ts";
