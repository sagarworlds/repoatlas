import { Worker } from "node:worker_threads";
import type { PluginProjectInfo } from "@repoatlas/plugin-api";
import { FromWorkerSchema, type ToWorkerMessage } from "./messages.ts";
import {
  DEFAULT_RESOURCE_LIMITS,
  type ExtractionPool,
  type PoolFile,
  type PoolOptions,
  type PoolOutcome,
} from "./pool-types.ts";

export * from "./pool-types.ts";

interface Job {
  id: number;
  sessionId: number;
  file: PoolFile;
  attempts: number;
  settled: boolean;
  resolve(outcome: PoolOutcome): void;
}

interface Slot {
  id: number;
  worker: Worker;
  ready: boolean;
  dead: boolean;
  /** Set when the pool kills the worker on purpose, so the exit is not blamed on a crash. */
  killedFor: "timeout" | "recycle" | "close" | undefined;
  /** Files sent and not yet answered, oldest first. The worker runs them in this order. */
  inFlight: Job[];
  knownSessions: Set<number>;
  jobsDone: number;
  watchdog: NodeJS.Timeout | undefined;
  startup: NodeJS.Timeout | undefined;
}

interface SessionRecord {
  pluginId: string;
  info: PluginProjectInfo;
}

const MAX_ATTEMPTS = 2;
const MAX_CONSECUTIVE_START_FAILURES = 2;

/**
 * A pool of worker threads that run `plugin.extract`. Plain closures, no class: all state is
 * in the variables below. Safe against: a throwing plugin (per-file failure), a crashing or
 * hanging worker (replaced; the file it was working on fails, the others are retried once),
 * workers that cannot start (the pool reports "unavailable"), and cancellation.
 */
export function createExtractionPool(options: PoolOptions): ExtractionPool {
  let maxWorkers = options.maxWorkers;
  const watchdogMs = options.watchdogMs ?? 60_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
  const maxInFlight = options.maxInFlightPerWorker ?? 2;
  const recycleAfter = options.recycleAfterJobs ?? 10_000;
  const limits = options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;

  const slots = new Map<number, Slot>();
  const queue: Job[] = [];
  const sessions = new Map<number, SessionRecord>();
  const counters = { spawned: 0, replaced: 0, completed: 0 };
  let nextSlotId = 1;
  let nextJobId = 1;
  let nextSessionId = 1;
  let consecutiveStartFailures = 0;
  let broken = false;
  let closed = false;

  function settle(job: Job, outcome: PoolOutcome): void {
    if (job.settled) return;
    job.settled = true;
    job.resolve(outcome);
  }

  function failEverything(reason: "unavailable" | "aborted", message: string): void {
    for (const job of queue.splice(0)) settle(job, { ok: false, reason, message });
    for (const slot of slots.values()) {
      for (const job of slot.inFlight) settle(job, { ok: false, reason, message });
    }
  }

  function clearTimers(slot: Slot): void {
    clearTimeout(slot.watchdog);
    clearTimeout(slot.startup);
    slot.watchdog = undefined;
    slot.startup = undefined;
  }

  /** (Re)starts the clock for the file the worker is working on right now (the oldest one). */
  function armWatchdog(slot: Slot): void {
    clearTimeout(slot.watchdog);
    slot.watchdog = undefined;
    if (slot.inFlight.length === 0 || slot.dead) return;
    const timer = setTimeout(() => {
      slot.killedFor = "timeout";
      void slot.worker.terminate();
    }, watchdogMs);
    timer.unref();
    slot.watchdog = timer;
  }

  function post(slot: Slot, message: ToWorkerMessage): void {
    slot.worker.postMessage(message);
  }

  function spawn(): void {
    const worker = new Worker(options.entry.url, {
      execArgv: options.entry.execArgv,
      resourceLimits: limits,
      // Workers must not keep the process alive; the pool is closed or idles out.
    });
    worker.unref();
    const slot: Slot = {
      id: nextSlotId++,
      worker,
      ready: false,
      dead: false,
      killedFor: undefined,
      inFlight: [],
      knownSessions: new Set(),
      jobsDone: 0,
      watchdog: undefined,
      startup: undefined,
    };
    counters.spawned++;
    slots.set(slot.id, slot);
    const startup = setTimeout(() => {
      slot.killedFor = "timeout";
      void worker.terminate();
    }, startupTimeoutMs);
    startup.unref();
    slot.startup = startup;

    worker.on("message", (raw: unknown) => onMessage(slot, raw));
    worker.on("error", () => onDeath(slot));
    worker.on("exit", () => onDeath(slot));
  }

  function onMessage(slot: Slot, raw: unknown): void {
    const parsed = FromWorkerSchema.safeParse(raw);
    if (!parsed.success) return; // garbage from a worker is ignored
    const message = parsed.data;
    if (message.type === "ready") {
      if (slot.ready) return;
      slot.ready = true;
      consecutiveStartFailures = 0;
      clearTimeout(slot.startup);
      slot.startup = undefined;
      pump();
      return;
    }
    const index = slot.inFlight.findIndex((j) => j.id === message.jobId);
    if (index < 0) return;
    const job = slot.inFlight[index] as Job;
    slot.inFlight.splice(index, 1);
    slot.jobsDone++;
    if (message.type === "result") {
      counters.completed++;
      settle(job, { ok: true, extraction: message.extraction });
    } else {
      settle(job, { ok: false, reason: "extract-error", message: message.message });
    }
    armWatchdog(slot);
    if (slot.jobsDone >= recycleAfter && slot.inFlight.length === 0) {
      slot.killedFor = "recycle";
      void slot.worker.terminate();
      return;
    }
    pump();
  }

  /** Called for both the "error" and the "exit" event; runs once per worker. */
  function onDeath(slot: Slot): void {
    if (slot.dead) return;
    slot.dead = true;
    clearTimers(slot);
    slots.delete(slot.id);
    if (closed) return;
    if (slot.killedFor === "recycle") {
      counters.replaced++;
      pump();
      return;
    }
    if (!slot.ready) {
      consecutiveStartFailures++;
      if (consecutiveStartFailures >= MAX_CONSECUTIVE_START_FAILURES) {
        broken = true;
        failEverything("unavailable", "extraction workers could not be started");
        return;
      }
    }
    counters.replaced++;
    // The oldest file was the one being processed: it takes the blame. The others were only
    // waiting in the worker's inbox, so they go back to the front of the queue (once).
    const [culprit, ...others] = slot.inFlight;
    if (culprit) {
      const reason = slot.killedFor === "timeout" ? "timeout" : "extract-error";
      settle(culprit, { ok: false, reason, message: `worker ${reason}` });
    }
    const retry: Job[] = [];
    for (const job of others) {
      if (job.settled) continue;
      job.attempts++;
      if (job.attempts >= MAX_ATTEMPTS) {
        settle(job, { ok: false, reason: "extract-error", message: "worker crashed twice" });
      } else {
        retry.push(job);
      }
    }
    queue.unshift(...retry);
    pump();
  }

  function pickSlot(): Slot | undefined {
    let best: Slot | undefined;
    for (const slot of slots.values()) {
      if (!slot.ready || slot.dead || slot.inFlight.length >= maxInFlight) continue;
      if (slot.jobsDone + slot.inFlight.length >= recycleAfter) continue;
      if (!best || slot.inFlight.length < best.inFlight.length) best = slot;
    }
    return best;
  }

  function dispatch(slot: Slot, job: Job): void {
    const record = sessions.get(job.sessionId);
    if (!record) {
      settle(job, { ok: false, reason: "aborted" });
      return;
    }
    try {
      if (!slot.knownSessions.has(job.sessionId)) {
        post(slot, {
          type: "session",
          sessionId: job.sessionId,
          pluginId: record.pluginId,
          info: record.info,
        });
        slot.knownSessions.add(job.sessionId);
      }
      post(slot, { type: "extract", jobId: job.id, sessionId: job.sessionId, ...job.file });
    } catch (err) {
      settle(job, { ok: false, reason: "extract-error", message: String(err) });
      return;
    }
    slot.inFlight.push(job);
    if (slot.inFlight.length === 1) armWatchdog(slot);
  }

  function pump(): void {
    if (closed) return;
    if (broken) {
      failEverything("unavailable", "extraction workers could not be started");
      return;
    }
    for (;;) {
      const job = queue[0];
      if (!job) break;
      if (job.settled) {
        queue.shift();
        continue;
      }
      const slot = pickSlot();
      if (!slot) break;
      queue.shift();
      dispatch(slot, job);
    }
    // Start more workers when work is waiting, up to the cap (in parallel, not one by one).
    let inFlight = 0;
    for (const slot of slots.values()) inFlight += slot.inFlight.length;
    const wanted = Math.min(maxWorkers, Math.ceil((queue.length + inFlight) / maxInFlight));
    while (queue.length > 0 && slots.size < wanted) {
      try {
        spawn();
      } catch {
        // The Worker constructor itself failed (bad limits, no such file): give up on threads.
        broken = true;
        failEverything("unavailable", "extraction workers could not be started");
        return;
      }
    }
  }

  return {
    openSession(pluginId, info, signal) {
      if (closed || broken) throw new Error("extraction pool is not available");
      // Fail early (and on the caller's side) when the info cannot be cloned to a thread.
      structuredClone(info);
      const sessionId = nextSessionId++;
      sessions.set(sessionId, { pluginId, info });
      let sessionClosed = false;

      const close = (): void => {
        if (sessionClosed) return;
        sessionClosed = true;
        signal?.removeEventListener("abort", close);
        sessions.delete(sessionId);
        for (let i = queue.length - 1; i >= 0; i--) {
          const job = queue[i] as Job;
          if (job.sessionId === sessionId) {
            queue.splice(i, 1);
            settle(job, { ok: false, reason: "aborted" });
          }
        }
        for (const slot of slots.values()) {
          // A file that is running cannot be cancelled; its late answer is dropped.
          for (const job of slot.inFlight) {
            if (job.sessionId === sessionId) settle(job, { ok: false, reason: "aborted" });
          }
          if (slot.knownSessions.delete(sessionId) && !slot.dead) {
            try {
              post(slot, { type: "end-session", sessionId });
            } catch {
              // the worker is going away anyway
            }
          }
        }
      };
      signal?.addEventListener("abort", close, { once: true });

      return {
        extract(file) {
          if (broken) return Promise.resolve({ ok: false, reason: "unavailable" });
          if (sessionClosed || closed || signal?.aborted) {
            return Promise.resolve({ ok: false, reason: "aborted" });
          }
          return new Promise<PoolOutcome>((resolve) => {
            queue.push({
              id: nextJobId++,
              sessionId,
              file,
              attempts: 0,
              settled: false,
              resolve,
            });
            pump();
          });
        },
        close,
      };
    },

    allowWorkers(count) {
      maxWorkers = Math.max(maxWorkers, count);
    },

    stats: () => ({ ...counters, alive: slots.size }),

    async close() {
      if (closed) return;
      closed = true;
      failEverything("aborted", "pool closed");
      const ending = [...slots.values()];
      for (const slot of ending) {
        slot.killedFor = "close";
        clearTimers(slot);
      }
      await Promise.all(ending.map((slot) => slot.worker.terminate()));
      slots.clear();
      sessions.clear();
    },
  };
}
