import clsx from "clsx";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useNodeDetail } from "../../api/hooks.ts";
import type {
  AnalysisRecordDto,
  AnalysisStats,
  Confidence,
  GraphNode,
  NodeDetailResponse,
} from "../../api/types.ts";
import { describeError } from "../../lib/error-text.ts";
import { shortSha } from "../../lib/format.ts";
import { AnalysisLanguageChips } from "../layout/analysis-language-chips.tsx";
import {
  applyPatch,
  type ExplorerParams,
  serializeExplorerParams,
  useExplorerParams,
} from "../url-state.ts";
import {
  countLinks,
  formatPercent,
  githubUrlForNode,
  kindLabel,
  lineRange,
  resolutionRate,
} from "./detail-model.ts";
import { useCopy } from "./use-copy.ts";

/** Children listed at most (a file with thousands of symbols stays usable). */
const MAX_CHILDREN = 200;

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 border-t border-line pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{props.title}</h3>
      {props.children}
    </section>
  );
}

const LEGEND: { confidence: Confidence; text: string; dash: string | undefined; width: number }[] =
  [
    { confidence: "exact", text: "compiler-grade or unambiguous", dash: undefined, width: 3 },
    { confidence: "inferred", text: "very likely right", dash: undefined, width: 1.5 },
    { confidence: "name-match", text: "matched by name, may be wrong", dash: "4 3", width: 1.5 },
  ];

/** Same dash styles as the graph edges: dashed = name match, solid = inferred, thick = exact. */
export function ConfidenceLegend() {
  return (
    <ul className="space-y-1 text-xs" aria-label="Edge confidence legend">
      {LEGEND.map((entry) => (
        <li key={entry.confidence} className="flex items-center gap-2">
          <svg width="30" height="8" aria-hidden="true" className="shrink-0 text-fg">
            <line
              x1="1"
              y1="4"
              x2="29"
              y2="4"
              stroke="currentColor"
              strokeWidth={entry.width}
              strokeDasharray={entry.dash}
            />
          </svg>
          <span>
            <span className="font-medium">{entry.confidence}</span>{" "}
            <span className="text-muted">{entry.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function RepoOverview(props: { analysis: AnalysisRecordDto }) {
  const { analysis } = props;
  const stats: AnalysisStats | null = analysis.stats;
  const rate = stats ? resolutionRate(stats) : undefined;

  return (
    <div className="space-y-4 p-3 text-sm" data-testid="detail-panel">
      <div className="rounded-lg border border-dashed border-line p-3">
        <p className="font-semibold">Nothing selected</p>
        <p className="mt-1 text-muted">
          Pick a file in the tree, a node on the map or a search result to see its details.
        </p>
      </div>
      <Section title="Repository">
        <p className="break-words font-medium">
          {analysis.owner}/{analysis.repo}
        </p>
        <p className="text-muted">
          {analysis.ref}
          {analysis.commitSha ? ` @ ${shortSha(analysis.commitSha)}` : ""}
        </p>
      </Section>
      {stats && (
        <>
          <Section title="Languages">
            <AnalysisLanguageChips stats={stats} />
          </Section>
          <Section title="Contents">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              {Object.entries(stats.nodesByKind).map(([kind, count]) => (
                <div key={kind} className="contents">
                  <dt className="text-muted">{kind}</dt>
                  <dd className="text-right tabular-nums">{count}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section title="Call and import resolution">
            <p>
              {rate === undefined
                ? "No references found."
                : `${formatPercent(rate)} resolved (${stats.references.resolved} of ${stats.references.total})`}
            </p>
            {stats.parseErrorFiles > 0 && (
              <p className="text-warn">
                {stats.parseErrorFiles} {stats.parseErrorFiles === 1 ? "file has" : "files have"}{" "}
                parse errors.
              </p>
            )}
          </Section>
        </>
      )}
      <Section title="Edge confidence">
        <ConfidenceLegend />
      </Section>
    </div>
  );
}

function NodeLinkButton(props: { node: GraphNode; onSelect: (node: GraphNode) => void }) {
  const { node } = props;
  const lines = lineRange(node);
  return (
    <button
      type="button"
      onClick={() => props.onSelect(node)}
      className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-2"
    >
      <span className="w-16 shrink-0 text-[11px] uppercase text-muted">{node.kind}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{node.name}</span>
      {lines !== undefined && <span className="shrink-0 text-xs text-muted">L{lines}</span>}
    </button>
  );
}

function NodeDetailView(props: {
  detail: NodeDetailResponse;
  analysis: AnalysisRecordDto;
  params: ExplorerParams;
  onSelect: (node: GraphNode) => void;
}) {
  const { detail, analysis, params } = props;
  const { node } = detail;
  const { message, copy } = useCopy();
  const github = githubUrlForNode(analysis, node);
  const lines = lineRange(node);
  const qualified = node.qualifiedName ?? node.name;
  const children = detail.children.slice(0, MAX_CHILDREN);

  return (
    <div className="space-y-4 p-3 text-sm" data-testid="detail-panel">
      {detail.parents.length > 0 && (
        <nav aria-label="Location of the selected node">
          <ol className="flex flex-wrap items-center gap-x-1 text-xs text-muted">
            {detail.parents.map((parent) => (
              <li key={parent.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => props.onSelect(parent)}
                  className="rounded px-1 underline-offset-2 hover:text-fg hover:underline"
                >
                  {parent.name || (parent.kind === "repo" ? analysis.repo : "/")}
                </button>
                <span aria-hidden="true">/</span>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent-strong">
          {kindLabel(node.kind)}
        </p>
        <h2 className="break-words font-mono text-base font-semibold">{node.name}</h2>
        {node.qualifiedName !== undefined && node.qualifiedName !== node.name && (
          <p className="break-all font-mono text-xs text-muted">{node.qualifiedName}</p>
        )}
      </header>

      {node.signature !== undefined && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 font-mono text-xs">
          {node.signature}
        </pre>
      )}

      <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1">
        {node.file !== undefined && (
          <>
            <dt className="text-muted">File</dt>
            <dd className="break-all font-mono text-xs">
              {node.file}
              {lines !== undefined && <span className="text-muted">:{lines}</span>}
            </dd>
          </>
        )}
        {node.language !== undefined && (
          <>
            <dt className="text-muted">Language</dt>
            <dd>{node.language}</dd>
          </>
        )}
        {node.meta?.isTest === true && (
          <>
            <dt className="text-muted">Role</dt>
            <dd>Test code</dd>
          </>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copy(qualified)}
          className="h-8 rounded-md border border-line-strong px-3 hover:bg-surface-2"
        >
          Copy name
        </button>
        {github !== undefined && (
          <a
            href={github}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 hover:bg-surface-2"
          >
            Open on GitHub
          </a>
        )}
        <span role="status" aria-live="polite" className="self-center text-xs text-muted">
          {message}
        </span>
      </div>

      <Section title="Relations">
        <ul className="grid grid-cols-2 gap-1.5">
          {countLinks(node, detail.counts).map((link) => (
            <li key={link.key}>
              {link.patch !== undefined ? (
                <Link
                  to={{ search: `?${serializeExplorerParams(applyPatch(params, link.patch))}` }}
                  className="flex items-center justify-between rounded-md border border-line px-2 py-1.5 hover:bg-surface-2"
                >
                  <span>{link.label}</span>
                  <span className="font-semibold tabular-nums">{link.count}</span>
                </Link>
              ) : (
                <div
                  className={clsx(
                    "flex items-center justify-between rounded-md border border-line px-2 py-1.5",
                    "text-muted",
                  )}
                >
                  <span>{link.label}</span>
                  <span className="tabular-nums">{link.count}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {children.length > 0 && (
        <Section title={node.kind === "file" ? "Symbols in this file" : "Contains"}>
          <ul>
            {children.map((child) => (
              <li key={child.id}>
                <NodeLinkButton node={child} onSelect={props.onSelect} />
              </li>
            ))}
          </ul>
          {detail.children.length > MAX_CHILDREN && (
            <p className="text-xs text-muted">
              Showing {MAX_CHILDREN} of {detail.children.length}.
            </p>
          )}
        </Section>
      )}

      <Section title="Edge confidence">
        <ConfidenceLegend />
      </Section>
    </div>
  );
}

/** Details of the node in the `node` URL parameter, or a repository overview. */
export function DetailPanel(props: { analysisId: string; analysis: AnalysisRecordDto }) {
  const { params, setParams } = useExplorerParams();
  const query = useNodeDetail(props.analysisId, params.node);

  function select(node: GraphNode) {
    setParams({ node: node.id, hl: undefined }, { push: true });
  }

  if (params.node === undefined) return <RepoOverview analysis={props.analysis} />;

  if (query.isPending) {
    return (
      <div role="status" className="p-3 text-sm text-muted" data-testid="detail-panel">
        Loading details&hellip;
      </div>
    );
  }

  if (query.isError || !query.data) {
    const notFound = query.error?.code === "NODE_NOT_FOUND";
    const error = describeError(query.error);
    return (
      <div role="alert" className="space-y-2 p-3 text-sm" data-testid="detail-panel">
        <p className="font-semibold text-danger">{notFound ? "Node not found" : error.title}</p>
        <p className="text-muted">
          {notFound ? "The selected node does not exist in this analysis." : error.message}
        </p>
        <div className="flex gap-2">
          {!notFound && (
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="h-8 rounded-md border border-line-strong px-3 hover:bg-surface-2"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => setParams({ node: undefined })}
            className="h-8 rounded-md border border-line-strong px-3 hover:bg-surface-2"
          >
            Clear selection
          </button>
        </div>
      </div>
    );
  }

  return (
    <NodeDetailView
      detail={query.data}
      analysis={props.analysis}
      params={params}
      onSelect={select}
    />
  );
}
