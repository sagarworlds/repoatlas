import clsx from "clsx";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCreateAnalysis } from "../api/hooks.ts";
import type { AnalysisRecordDto, AnalysisStatus } from "../api/types.ts";
import { describeError } from "../lib/error-text.ts";
import { formatElapsed } from "../lib/format.ts";
import { addRecent } from "../lib/recent.ts";

/** The working phases in order (docs/UI.md). `queued` comes before them, `done` after. */
export const PHASES = ["fetching", "parsing", "resolving", "persisting"] as const;

const PHASE_LABELS: Record<(typeof PHASES)[number], string> = {
  fetching: "Fetching",
  parsing: "Parsing",
  resolving: "Resolving",
  persisting: "Saving",
};

type StepState = "done" | "current" | "pending";

/** State of one phase step for the analysis' current status. Pure, exported for tests. */
export function stepState(phase: (typeof PHASES)[number], status: AnalysisStatus): StepState {
  if (status === "done") return "done";
  const current = PHASES.indexOf(status as (typeof PHASES)[number]);
  if (current === -1) return "pending"; // queued or failed
  const index = PHASES.indexOf(phase);
  return index < current ? "done" : index === current ? "current" : "pending";
}

/** Milliseconds since `createdAt` (or until `finishedAt` when the analysis ended). */
export function elapsedMs(analysis: AnalysisRecordDto, now: number): number {
  const start = Date.parse(analysis.createdAt);
  if (Number.isNaN(start)) return 0;
  const end = analysis.finishedAt ? Date.parse(analysis.finishedAt) : now;
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

/** Re-renders every second while `active`, returning the current time in ms. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    // The returned function is the cleanup, like IDisposable.Dispose.
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Shown by the explorer page until the analysis is done. The page polls (useAnalysis) and
 * passes the latest record in; this component only displays it and handles "Retry".
 */
export function ProgressView({ analysis }: { analysis: AnalysisRecordDto }) {
  const navigate = useNavigate();
  const retry = useCreateAnalysis();
  const failed = analysis.status === "failed";
  const now = useNow(!failed);
  const progress = analysis.progress;
  const total = progress?.filesTotal ?? 0;
  const done = progress?.filesDone ?? 0;
  const showCount = analysis.status === "parsing" && total > 0;

  function onRetry() {
    retry.mutate(
      { repoUrl: `https://github.com/${analysis.owner}/${analysis.repo}`, ref: analysis.ref },
      {
        onSuccess: (result) => {
          addRecent({
            id: result.id,
            repo: `${result.owner}/${result.repo}`,
            ref: result.ref,
            date: new Date().toISOString(),
            status: result.status,
          });
          navigate(`/a/${encodeURIComponent(result.id)}`);
        },
      },
    );
  }

  const retryError = retry.isError ? describeError(retry.error) : undefined;

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-12" data-testid="progress-view">
      <div>
        <h1 className="text-xl font-semibold">
          {failed ? "Analysis failed" : "Analyzing"}{" "}
          <span className="font-mono text-lg">
            {analysis.owner}/{analysis.repo}
          </span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          {analysis.ref}
          {" · "}
          {failed ? "stopped after" : "elapsed"} {formatElapsed(elapsedMs(analysis, now))}
        </p>
      </div>

      {failed ? (
        <div role="alert" className="space-y-3 rounded-md border border-danger bg-danger-soft p-4">
          <p className="font-semibold text-danger">
            {analysis.error?.message ?? "The analysis did not finish."}
          </p>
          {analysis.error && (
            <p className="text-xs text-muted">
              Error code: <span className="font-mono">{analysis.error.code}</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRetry}
              disabled={retry.isPending}
              className="h-9 rounded-md bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-strong disabled:opacity-60"
            >
              {retry.isPending ? "Retrying…" : "Retry"}
            </button>
            <Link to="/" className="inline-flex h-9 items-center px-2 text-sm underline">
              Back to home
            </Link>
          </div>
          {retryError && (
            <p className="text-sm text-danger">
              {retryError.title}: {retryError.message}
            </p>
          )}
        </div>
      ) : (
        <>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Analysis phases">
            {PHASES.map((phase) => {
              const state = stepState(phase, analysis.status);
              return (
                <li
                  key={phase}
                  aria-current={state === "current" ? "step" : undefined}
                  className={clsx(
                    "rounded-md border px-3 py-2 text-sm",
                    state === "current" && "border-accent bg-accent-soft font-semibold",
                    state === "done" && "border-line text-fg",
                    state === "pending" && "border-line text-muted",
                  )}
                >
                  <span aria-hidden="true" className="mr-1">
                    {state === "done" ? "✓" : state === "current" ? "▶" : "○"}
                  </span>
                  {PHASE_LABELS[phase]}
                  <span className="sr-only">
                    {state === "done" ? " (done)" : state === "current" ? " (in progress)" : ""}
                  </span>
                </li>
              );
            })}
          </ol>

          <div>
            <div
              role="progressbar"
              aria-label="Files processed"
              aria-valuemin={0}
              aria-valuemax={showCount ? total : undefined}
              aria-valuenow={showCount ? done : undefined}
              aria-valuetext={showCount ? `${done} of ${total} files` : "Working"}
              className="h-2.5 overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className={clsx(
                  "h-full rounded-full bg-accent transition-[width]",
                  !showCount && "w-1/3 animate-pulse",
                )}
                style={showCount ? { width: `${Math.min(100, (done / total) * 100)}%` } : undefined}
              />
            </div>
            <p className="mt-2 text-sm text-muted">
              {analysis.status === "queued" && "Waiting for a free worker…"}
              {showCount && `${done} / ${total} files`}
              {analysis.status !== "queued" && !showCount && "Working…"}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
