import { useState } from "react";
import type { AnalysisRecordDto, AnalysisStats } from "../../api/types.ts";

/** Below this share of resolved references, call links are called "approximate". */
export const LOW_RESOLUTION_THRESHOLD = 0.5;

export function dismissKey(analysisId: string): string {
  return `repoatlas.banner.dismissed.${analysisId}`;
}

// sessionStorage can throw like localStorage, so access is guarded.
function wasDismissed(analysisId: string): boolean {
  try {
    return window.sessionStorage.getItem(dismissKey(analysisId)) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(analysisId: string): void {
  try {
    window.sessionStorage.setItem(dismissKey(analysisId), "1");
  } catch {
    // ignore: the banner just comes back on the next visit
  }
}

/**
 * Notices worth showing for these stats, as plain strings. Pure, so it is easy to test.
 * docs/UI.md asks for a per-language rate, but the stats only hold an overall rate
 * (`references`), so the rate is overall and the languages present are listed.
 */
export function buildNotices(stats: AnalysisStats | null): string[] {
  if (!stats) return [];
  const notices: string[] = [];

  const { total, resolved } = stats.references;
  if (total > 0 && resolved / total < LOW_RESOLUTION_THRESHOLD) {
    const languages = Object.keys(stats.languages).sort();
    const suffix = languages.length > 0 ? ` Languages: ${languages.join(", ")}.` : "";
    const percent = Math.round((resolved / total) * 100);
    notices.push(
      `Call links are approximate (dashed lines are name matches). Only ${percent}% of references were resolved.${suffix}`,
    );
  }

  if (stats.truncated) {
    const skipped = stats.skippedFiles.reduce((sum, s) => sum + s.count, 0);
    notices.push(
      skipped > 0
        ? `The repository was too large to analyze fully, so this map is partial (${skipped} files skipped).`
        : "The repository was too large to analyze fully, so this map is partial.",
    );
  }

  if (stats.pluginErrors.length > 0) {
    const plugins = [...new Set(stats.pluginErrors.map((e) => e.plugin))].sort();
    notices.push(
      `${stats.pluginErrors.length} language plugin error(s) occurred (${plugins.join(", ")}); some files may be missing.`,
    );
  }
  return notices;
}

/** Dismissible warning strip above the explorer. Dismissal is remembered per analysis. */
export function ResolutionBanner({ analysis }: { analysis: AnalysisRecordDto }) {
  const [dismissed, setDismissed] = useState(() => wasDismissed(analysis.id));
  const notices = buildNotices(analysis.stats);
  if (dismissed || notices.length === 0) return null;

  return (
    <section
      aria-label="Analysis notices"
      className="flex shrink-0 items-start gap-3 border-b border-line bg-warn-soft px-3 py-2 text-sm text-warn"
    >
      <span aria-hidden="true">{"⚠"}</span>
      <ul className="min-w-0 flex-1 space-y-1">
        {notices.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          rememberDismissed(analysis.id);
          setDismissed(true);
        }}
        className="h-7 shrink-0 rounded-md border border-current px-2 text-xs font-medium"
      >
        Dismiss
      </button>
    </section>
  );
}
