import { useState } from "react";
import { Link } from "react-router-dom";
import { useAnalyses } from "../api/hooks.ts";
import type { AnalysisStatus } from "../api/types.ts";
import { relativeTime, shortSha } from "../lib/format.ts";
import { readRecent } from "../lib/recent.ts";
import { StatusBadge } from "./status-badge.tsx";

interface RowProps {
  id: string;
  repo: string;
  gitRef: string;
  sha?: string | null;
  date: string;
  status: AnalysisStatus;
}

function Row({ id, repo, gitRef, sha, date, status }: RowProps) {
  return (
    <li>
      <Link
        to={`/a/${encodeURIComponent(id)}`}
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2 hover:border-accent"
      >
        <span className="min-w-0">
          <span className="block truncate font-mono text-sm font-medium">{repo}</span>
          <span className="block truncate text-xs text-muted">
            {gitRef}
            {sha ? ` @ ${shortSha(sha)}` : ""} {"·"} {relativeTime(date)}
          </span>
        </span>
        <StatusBadge status={status} />
      </Link>
    </li>
  );
}

/** "Your recent" (from this browser) followed by the global list from the API. */
export function RecentAnalyses() {
  // Read once on mount; the list only changes when the user starts an analysis.
  const [mine] = useState(() => readRecent());
  const global = useAnalyses(10);
  const globalRows = (global.data?.analyses ?? []).filter((a) => a.status !== "failed");

  return (
    <div className="space-y-6">
      {mine.length > 0 && (
        <section aria-labelledby="recent-mine">
          <h2 id="recent-mine" className="mb-2 text-sm font-medium text-muted">
            Your recent analyses
          </h2>
          <ul className="space-y-2">
            {mine.map((entry) => (
              <Row
                key={entry.id}
                id={entry.id}
                repo={entry.repo}
                gitRef={entry.ref}
                date={entry.date}
                status={entry.status}
              />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="recent-global">
        <h2 id="recent-global" className="mb-2 text-sm font-medium text-muted">
          Recently analyzed by everyone
        </h2>
        {global.isPending && <p className="text-sm text-muted">Loading&hellip;</p>}
        {global.isError && (
          <p className="text-sm text-muted">Could not load the recent analyses.</p>
        )}
        {global.isSuccess && globalRows.length === 0 && (
          <p className="text-sm text-muted">Nothing has been analyzed yet. Be the first!</p>
        )}
        {globalRows.length > 0 && (
          <ul className="space-y-2">
            {globalRows.map((a) => (
              <Row
                key={a.id}
                id={a.id}
                repo={`${a.owner}/${a.repo}`}
                gitRef={a.ref}
                sha={a.commitSha}
                date={a.createdAt}
                status={a.status}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
