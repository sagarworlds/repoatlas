import type { ReactNode } from "react";
import { useDeps } from "../../api/hooks.ts";
import type { AnalysisRecordDto, DepsDirection } from "../../api/types.ts";
import { describeError } from "../../lib/error-text.ts";
import { useExplorerParams } from "../url-state.ts";
import { DepsColumn, splitPath } from "./deps-column.tsx";
import { DepsExternals } from "./deps-externals.tsx";
import { buildDepsModel, countItems, type DepItem, fileOfNodeId } from "./deps-model.ts";

/** Same cap as the API (CALLFLOW_MAX_NODES): a response this big has been cut off. */
const DEPS_NODE_LIMIT = 500;

const DIRECTION_LABELS: Record<DepsDirection, string> = {
  both: "Both directions",
  importedBy: "Imported by only",
  imports: "Imports only",
};

function Message(props: {
  title: string;
  children?: ReactNode;
  role?: "status" | "alert";
  testId: string;
}) {
  return (
    <div
      role={props.role}
      data-testid={props.testId}
      className="mx-auto max-w-lg space-y-3 px-6 py-12 text-center"
    >
      <h2 className="text-lg font-semibold">{props.title}</h2>
      <div className="space-y-2 text-sm text-muted">{props.children}</div>
    </div>
  );
}

/** Dependencies tab: who imports a file, and what it imports (3 columns, no graph library). */
export function DepsTab(props: { analysisId: string; analysis: AnalysisRecordDto }) {
  const { params, setParams } = useExplorerParams();
  // The `file` parameter wins; otherwise use the file that contains the selected symbol.
  const centerPath = params.file ?? fileOfNodeId(params.node);
  const deps = useDeps(props.analysisId, centerPath, params.dir, params.depth);

  if (centerPath === undefined) {
    return (
      <Message title="Pick a file to see its dependencies" testId="deps-prompt">
        <p>
          Select a file in the file tree or on the map, or choose a function with the search box to
          see the imports of the file it lives in.
        </p>
      </Message>
    );
  }
  if (deps.isError) {
    const notReady = deps.error.code === "ANALYSIS_NOT_READY";
    const text = describeError(deps.error);
    return (
      <Message
        role="alert"
        testId="deps-error"
        title={notReady ? "The analysis is not ready yet" : text.title}
      >
        <p>
          {notReady ? "Import data is available once the analysis has finished." : text.message}
        </p>
        <button
          type="button"
          onClick={() => void deps.refetch()}
          className="h-9 rounded-md bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-strong"
        >
          Try again
        </button>
      </Message>
    );
  }
  const model = deps.data ? buildDepsModel(deps.data, centerPath, params.depth) : undefined;
  // `model` is also undefined while the previous file's data is still shown as placeholder.
  if (deps.isPending || !model) {
    return (
      <Message title="Loading dependencies…" role="status" testId="deps-loading">
        <p>Fetching imports.</p>
      </Message>
    );
  }

  const selectFile = (item: DepItem) =>
    // Pushing a history entry makes Back return to the previous centre file.
    setParams({ file: item.path, node: item.node.id, hl: undefined }, { push: true });

  const { dir, base } = splitPath(centerPath);
  const noLinks =
    model.importedBy.length === 0 && model.imports.length === 0 && model.externals.length === 0;
  const truncated = (deps.data?.nodes.length ?? 0) >= DEPS_NODE_LIMIT;

  return (
    <div className="h-full overflow-auto" data-testid="deps-tab" aria-busy={deps.isFetching}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-3 py-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">Depth</span>
          <select
            className="h-8 rounded-md border border-line-strong bg-surface px-2"
            value={params.depth}
            onChange={(e) => setParams({ depth: Number.parseInt(e.target.value, 10) })}
          >
            {[1, 2, 3].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">Direction</span>
          <select
            className="h-8 rounded-md border border-line-strong bg-surface px-2"
            value={params.dir}
            onChange={(e) => {
              const picked = (Object.keys(DIRECTION_LABELS) as DepsDirection[]).find(
                (d) => d === e.target.value,
              );
              if (picked) setParams({ dir: picked });
            }}
          >
            {(Object.keys(DIRECTION_LABELS) as DepsDirection[]).map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted">
          Select a file to make it the centre. Dashed outlines are name matches.
        </span>
      </div>
      {truncated && (
        <p
          role="status"
          data-testid="deps-truncated"
          className="bg-warn-soft px-3 py-2 text-sm text-warn"
        >
          The result was limited to {DEPS_NODE_LIMIT} files, so some links are missing. Lower the
          depth.
        </p>
      )}
      {noLinks && (
        <p data-testid="deps-empty" className="px-3 pt-3 text-sm text-muted">
          This file has no import links within {params.depth} hop(s).
        </p>
      )}
      <div className="grid gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_minmax(0,1fr)] md:items-stretch">
        <DepsColumn
          title={`Imported by (${countItems(model.importedBy)})`}
          description="Files that import this file"
          side="left"
          items={model.importedBy}
          emptyText={
            params.dir === "imports"
              ? "Hidden by the direction filter."
              : "No file imports this one."
          }
          onSelect={selectFile}
        />
        <div className="relative flex items-center px-3 py-3 md:px-6">
          <span
            aria-hidden="true"
            className="absolute left-0 hidden w-6 border-t-2 border-muted md:block"
          />
          <span
            aria-hidden="true"
            className="absolute right-0 hidden w-6 border-t-2 border-muted md:block"
          />
          <div
            data-testid="deps-center"
            className="w-full min-w-0 rounded-md border-2 border-accent bg-accent-soft p-3"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">This file</p>
            <p className="break-all text-sm" title={centerPath}>
              <span className="text-muted">{dir}</span>
              <span className="font-semibold">{base}</span>
            </p>
            {model.center.language && <p className="text-xs text-muted">{model.center.language}</p>}
          </div>
        </div>
        <DepsColumn
          title={`Imports (${countItems(model.imports)})`}
          description="Files that this file imports"
          side="right"
          items={model.imports}
          emptyText={
            params.dir === "importedBy"
              ? "Hidden by the direction filter."
              : "No imports of other files in this repository."
          }
          onSelect={selectFile}
          footer={<DepsExternals groups={model.externals} />}
        />
      </div>
    </div>
  );
}
