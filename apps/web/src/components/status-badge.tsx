import clsx from "clsx";
import type { AnalysisStatus } from "../api/types.ts";

const LABELS: Record<AnalysisStatus, string> = {
  queued: "Queued",
  fetching: "Fetching",
  parsing: "Parsing",
  resolving: "Resolving",
  persisting: "Saving",
  done: "Ready",
  failed: "Failed",
};

/** Status as a text label with a symbol, so the colour is never the only signal. */
export function StatusBadge({ status }: { status: AnalysisStatus }) {
  const symbol = status === "done" ? "✓" : status === "failed" ? "✕" : "…";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        status === "done" && "bg-accent-soft text-accent-strong",
        status === "failed" && "bg-danger-soft text-danger",
        status !== "done" && status !== "failed" && "bg-warn-soft text-warn",
      )}
    >
      <span aria-hidden="true">{symbol}</span>
      {LABELS[status]}
    </span>
  );
}
