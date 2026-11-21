import type { ReactNode } from "react";
import type { AnalysisRecordDto } from "../../api/types.ts";
import { shortSha } from "../../lib/format.ts";
import { ExplorerTabs } from "./explorer-tabs.tsx";

const BUTTON = "h-8 rounded-md border border-line-strong px-2 text-sm hover:bg-surface-2";

/** https://github.com/{owner}/{repo}/commit/{sha} (segments encoded). */
export function buildCommitUrl(owner: string, repo: string, sha: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${encodeURIComponent(sha)}`;
}

export interface ExplorerHeaderProps {
  analysis: AnalysisRecordDto;
  search: ReactNode;
  narrow: boolean;
  treeOpen: boolean;
  /** Desktop: collapse/expand the tree. Narrow: open the tree drawer. */
  onToggleTree: () => void;
  /** Narrow only. */
  onOpenDetail: () => void;
  /** Narrow only; undefined when no node is selected (button hidden). */
  onOpenCode: (() => void) | undefined;
}

/** Top bar: tree/detail buttons, repo @ ref (sha), tabs and search. */
export function ExplorerHeader(props: ExplorerHeaderProps) {
  const { analysis, narrow } = props;
  const sha = analysis.commitSha;
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2">
      <button
        type="button"
        onClick={props.onToggleTree}
        // On desktop the button is a toggle; on narrow screens it opens a dialog.
        {...(narrow ? { "aria-haspopup": "dialog" as const } : { "aria-pressed": props.treeOpen })}
        title={narrow ? "Open file tree" : props.treeOpen ? "Hide file tree" : "Show file tree"}
        className={BUTTON}
      >
        <span aria-hidden="true">{"☰"}</span> Files
      </button>

      <div className="min-w-0 text-sm">
        <span className="font-semibold">
          {analysis.owner}/{analysis.repo}
        </span>
        <span className="text-muted">
          {" "}
          @ {analysis.ref}
          {sha && (
            <>
              {" "}
              (
              <a
                href={buildCommitUrl(analysis.owner, analysis.repo, sha)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open commit ${sha} on GitHub`}
                className="font-mono underline"
              >
                {shortSha(sha)}
              </a>
              )
            </>
          )}
        </span>
      </div>

      <ExplorerTabs />

      {narrow && (
        <>
          <button
            type="button"
            onClick={props.onOpenDetail}
            aria-haspopup="dialog"
            className={BUTTON}
          >
            Details
          </button>
          {props.onOpenCode && (
            <button
              type="button"
              onClick={props.onOpenCode}
              aria-haspopup="dialog"
              className={BUTTON}
            >
              View code
            </button>
          )}
        </>
      )}

      <div className="ml-auto min-w-[12rem] flex-1 sm:max-w-sm">{props.search}</div>
    </header>
  );
}
