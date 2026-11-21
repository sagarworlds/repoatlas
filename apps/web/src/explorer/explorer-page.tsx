import { type ReactNode, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useAnalysis } from "../api/hooks.ts";
import { describeError } from "../lib/error-text.ts";
import { updateRecentStatus } from "../lib/recent.ts";
import { DepsTab } from "./deps/deps-tab.tsx";
import { FlowTab } from "./flow/flow-tab.tsx";
import { ExplorerLayout } from "./layout/explorer-layout.tsx";
import { ResolutionBanner } from "./layout/resolution-banner.tsx";
import { MapTab } from "./map/map-tab.tsx";
import { CodePanel } from "./panels/code-panel.tsx";
import { DetailPanel } from "./panels/detail-panel.tsx";
import { FileTree } from "./panels/file-tree.tsx";
import { ProgressView } from "./progress-view.tsx";
import { SearchBox } from "./search/search-box.tsx";
import { useExplorerParams } from "./url-state.ts";

function Message(props: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-3 px-4 py-16 text-center" role="alert">
      <h1 className="text-2xl font-semibold">{props.title}</h1>
      <p className="text-muted">{props.text}</p>
      {props.children}
    </div>
  );
}

/**
 * Route /a/:analysisId. Loads the analysis (polling while it runs), then shows either the
 * progress view or the explorer layout with its slot components.
 */
export function ExplorerPage() {
  const { analysisId = "" } = useParams();
  const query = useAnalysis(analysisId);
  const { params } = useExplorerParams();
  const analysis = query.data;
  const status = analysis?.status;

  // Keep the status of this browser's "recent" entry current (queued -> done/failed).
  useEffect(() => {
    if (status) updateRecentStatus(analysisId, status);
  }, [analysisId, status]);

  if (query.isPending) {
    return (
      <div className="p-8 text-center text-muted" role="status">
        Loading analysis&hellip;
      </div>
    );
  }

  if (query.isError || !analysis) {
    const error = describeError(query.error);
    const notFound = query.error?.code === "ANALYSIS_NOT_FOUND";
    return (
      <Message
        title={notFound ? "Analysis not found" : error.title}
        text={
          notFound
            ? "This analysis does not exist, or it was removed from the server cache."
            : error.message
        }
      >
        <div className="flex justify-center gap-3">
          {!notFound && (
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="h-9 rounded-md bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-strong"
            >
              Try again
            </button>
          )}
          <Link to="/" className="inline-flex h-9 items-center underline">
            Analyze a repository
          </Link>
        </div>
      </Message>
    );
  }

  if (analysis.status !== "done") return <ProgressView analysis={analysis} />;

  const panelProps = { analysisId, analysis };
  const canvas =
    params.tab === "flow" ? (
      <FlowTab {...panelProps} />
    ) : params.tab === "deps" ? (
      <DepsTab {...panelProps} />
    ) : (
      <MapTab {...panelProps} />
    );

  return (
    <ExplorerLayout
      analysis={analysis}
      search={<SearchBox {...panelProps} />}
      banner={<ResolutionBanner analysis={analysis} />}
      tree={<FileTree {...panelProps} />}
      canvas={canvas}
      detail={<DetailPanel {...panelProps} />}
      code={({ onClose }) => <CodePanel {...panelProps} onClose={onClose} />}
    />
  );
}
