import { AnalysisError } from "../errors.ts";

/**
 * Convert an aborted signal into the matching AnalysisError.
 * `AbortSignal.timeout()` aborts with a DOMException named "TimeoutError" -> TIMEOUT;
 * anything else -> CANCELLED. If the abort reason is already an AnalysisError it is reused.
 */
export function abortToError(signal: AbortSignal): AnalysisError {
  const reason: unknown = signal.reason;
  if (reason instanceof AnalysisError) return reason;
  if (reason instanceof Error && reason.name === "TimeoutError") {
    return new AnalysisError("TIMEOUT", "Analysis timed out", { cause: reason });
  }
  return new AnalysisError("CANCELLED", "Analysis was cancelled", { cause: reason });
}

/** Like `signal.throwIfAborted()` but throws an AnalysisError (C# analogy: ThrowIfCancellationRequested). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortToError(signal);
}
