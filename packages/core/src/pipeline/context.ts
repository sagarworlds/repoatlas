import { performance } from "node:perf_hooks";
import { abortToError } from "../security/abort.ts";
import type { ProgressCallback, ProgressEvent } from "../types.ts";

/** Per-run services: cancellation/timeout, progress reporting and phase timings. */
export interface PipelineContext {
  /** Aborts on the caller's signal OR when the analysis timeout elapses. */
  readonly signal: AbortSignal;
  /** Throws AnalysisError (CANCELLED / TIMEOUT) when the run must stop. */
  check(): void;
  progress(phase: ProgressEvent["phase"], filesDone: number, filesTotal: number): void;
  /** Milliseconds per phase, filled by `time`. */
  readonly timings: Record<string, number>;
  time<T>(phase: string, fn: () => Promise<T> | T): Promise<T>;
}

export function createPipelineContext(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress: ProgressCallback | undefined,
): PipelineContext {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  // AbortSignal.any fires when either input fires and keeps that input's reason,
  // so a timeout stays a "TimeoutError" and maps to TIMEOUT in abortToError.
  const combined = AbortSignal.any(signals);
  const timings: Record<string, number> = {};

  return {
    signal: combined,
    check() {
      if (combined.aborted) throw abortToError(combined);
    },
    progress(phase, filesDone, filesTotal) {
      if (!onProgress) return;
      try {
        onProgress({ phase, filesDone, filesTotal });
      } catch {
        // A faulty progress listener must never break the analysis.
      }
    },
    timings,
    async time(phase, fn) {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        timings[phase] = Math.round((performance.now() - start) * 100) / 100;
      }
    },
  };
}
