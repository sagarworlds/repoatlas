import { mkdir, rm } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import PQueue from "p-queue";
import type { ApiDeps } from "../context.ts";
import { INTERRUPTED_MESSAGE, planRecovery, readAttempts, writeAttempts } from "./recovery.ts";
import { runAnalysisJob } from "./run-analysis.ts";
import { encodeError, tmpRoot } from "./storage.ts";

export interface RecoveryReport {
  requeued: string[];
  failed: string[];
}

/** The in-process job queue (ARCHITECTURE: single process, SQLite, no external broker). */
export interface AnalysisJobs {
  /** Queue an analysis row (status `queued`) for execution. */
  enqueue(analysisId: string): void;
  /** Startup: clean DATA_DIR/tmp and handle analyses interrupted by a restart. */
  recover(): Promise<RecoveryReport>;
  /** Resolves when no job is running or waiting (used by tests and shutdown). */
  idle(): Promise<void>;
  /** Stop accepting jobs, abort running ones (they stay recoverable) and wait briefly. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export function createAnalysisJobs(deps: ApiDeps, log: FastifyBaseLogger): AnalysisJobs {
  const queue = new PQueue({ concurrency: deps.config.analysisConcurrency });
  const controllers = new Map<string, AbortController>();
  let shuttingDown = false;

  const env = { deps, log, isShuttingDown: () => shuttingDown };

  function enqueue(analysisId: string): void {
    if (shuttingDown) return; // row stays `queued`; the next boot picks it up
    // `void` = deliberately not awaited (fire and forget), like an unawaited Task in C#.
    void queue.add(async () => {
      if (shuttingDown) return;
      const controller = new AbortController();
      controllers.set(analysisId, controller);
      try {
        await runAnalysisJob(env, analysisId, controller.signal);
      } finally {
        controllers.delete(analysisId);
      }
    });
  }

  async function recover(): Promise<RecoveryReport> {
    const { store, config } = deps;
    // Temp extraction dirs of interrupted jobs are garbage now.
    await rm(tmpRoot(config.dataDir), { recursive: true, force: true });
    await mkdir(tmpRoot(config.dataDir), { recursive: true });

    const attempts = await readAttempts(config.dataDir);
    const plan = planRecovery(store.listUnfinished(), attempts);
    await writeAttempts(config.dataDir, plan.nextAttempts);

    const finishedAt = new Date().toISOString();
    for (const id of plan.fail) {
      store.updateAnalysis(id, {
        status: "failed",
        progress: null,
        error: encodeError("INTERNAL", INTERRUPTED_MESSAGE),
        finishedAt,
      });
    }
    for (const id of plan.requeue) {
      // Back to `queued` so an interruption before the job starts does not spend the retry.
      store.updateAnalysis(id, { status: "queued", progress: null });
      enqueue(id);
    }
    if (plan.requeue.length > 0 || plan.fail.length > 0) {
      log.info(
        { requeued: plan.requeue.length, failed: plan.fail.length },
        "recovered interrupted analyses",
      );
    }
    return { requeued: plan.requeue, failed: plan.fail };
  }

  async function shutdown(timeoutMs = 5000): Promise<void> {
    shuttingDown = true;
    queue.clear(); // drop jobs that have not started; their rows remain `queued`
    for (const controller of controllers.values()) controller.abort();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([queue.onIdle(), timeout]);
    clearTimeout(timer);
  }

  return { enqueue, recover, idle: () => queue.onIdle(), shutdown };
}
