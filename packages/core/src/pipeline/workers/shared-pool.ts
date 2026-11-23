import { locateWorkerEntry } from "./entry-location.ts";
import { createExtractionPool, type ExtractionPool, type PoolStats } from "./pool.ts";

/**
 * One lazily created pool per process, shared by all analyses. With ANALYSIS_CONCURRENCY=2
 * two analyses would otherwise start 2 x N threads and fight over the same cores; with one
 * shared pool the thread count stays at the cap and their files are interleaved fairly.
 * Reference counting closes the pool a while after the last analysis has released it.
 */
export interface PoolLease {
  readonly pool: ExtractionPool;
  /** Gives the pool back. Calling it twice is harmless. */
  release(): void;
}

export interface SharedPoolOptions {
  /** How long an unused pool stays alive (default 30 s). */
  idleTimeoutMs?: number;
  /** Builds the pool; tests replace it. Returns undefined when threads are not available. */
  create?: (maxWorkers: number) => ExtractionPool | undefined;
}

interface SharedState {
  pool: ExtractionPool;
  refs: number;
  idleTimer: NodeJS.Timeout | undefined;
}

let shared: SharedState | undefined;

function createRealPool(maxWorkers: number): ExtractionPool | undefined {
  const entry = locateWorkerEntry();
  return entry ? createExtractionPool({ maxWorkers, entry }) : undefined;
}

/** Returns a lease on the shared pool, or undefined when no worker entry can be found. */
export function acquireSharedPool(
  maxWorkers: number,
  options: SharedPoolOptions = {},
): PoolLease | undefined {
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  if (shared === undefined) {
    const pool = (options.create ?? createRealPool)(maxWorkers);
    if (pool === undefined) return undefined;
    shared = { pool, refs: 0, idleTimer: undefined };
  } else {
    shared.pool.allowWorkers(maxWorkers);
  }
  const state = shared;
  clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  state.refs++;

  let released = false;
  return {
    pool: state.pool,
    release() {
      if (released) return;
      released = true;
      state.refs--;
      if (state.refs > 0 || shared !== state) return;
      const timer = setTimeout(() => {
        if (shared === state && state.refs === 0) {
          shared = undefined;
          void state.pool.close();
        }
      }, idleTimeoutMs);
      timer.unref();
      state.idleTimer = timer;
    },
  };
}

/** Closes the shared pool now (server shutdown, tests). A later acquire creates a new one. */
export async function shutdownSharedPool(): Promise<void> {
  const state = shared;
  if (state === undefined) return;
  shared = undefined;
  clearTimeout(state.idleTimer);
  await state.pool.close();
}

/** Statistics of the shared pool, or undefined when none exists. */
export function sharedPoolStats(): PoolStats | undefined {
  return shared?.pool.stats();
}
