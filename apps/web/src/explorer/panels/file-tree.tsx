import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGraph } from "../../api/hooks.ts";
import type { AnalysisRecordDto, GraphNode, GraphParams } from "../../api/types.ts";
import { describeError } from "../../lib/error-text.ts";
import { useExplorerParams } from "../url-state.ts";
import {
  ancestorDirIds,
  buildTree,
  defaultExpanded,
  flattenTree,
  type NavKey,
  navigate,
  type TreeRow,
  treeIdForNode,
} from "./tree-model.ts";
import { TreeRowView } from "./tree-row.tsx";

/** Rows rendered at most; beyond this the user is asked to filter. */
export const MAX_ROWS = 3000;

const NAV_KEYS: readonly string[] = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
];

// The tree needs no edges, only directories and files. Tests are included so they can be
// marked (they are not hidden here).
function treeParams(root: string, depth: number): GraphParams {
  return {
    level: "file",
    root,
    depth,
    edgeKinds: [],
    includeTests: true,
    includeExternal: false,
    minConfidence: "name-match",
  };
}

/**
 * Used only when the first response was truncated: loads the children of one open directory
 * and hands the nodes to the tree. Renders nothing. (A component per directory is the way to
 * call a hook "in a loop" in React.)
 */
function DirectoryLoader(props: {
  analysisId: string;
  dirId: string;
  onNodes: (nodes: GraphNode[]) => void;
}) {
  const query = useGraph(props.analysisId, treeParams(props.dirId, 1));
  const { onNodes } = props;
  const nodes = query.data?.nodes;
  useEffect(() => {
    if (nodes) onNodes(nodes);
  }, [nodes, onNodes]);
  return null;
}

function TreeSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading files"
      data-testid="file-tree"
      className="space-y-1.5 p-3"
    >
      {[70, 55, 80, 45, 65, 50].map((width) => (
        <div
          key={width}
          className="h-4 animate-pulse rounded bg-surface-2"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}

export function FileTree(props: { analysisId: string; analysis: AnalysisRecordDto }) {
  const { analysisId } = props;
  const { params, setParams } = useExplorerParams();
  const query = useGraph(analysisId, treeParams("dir:", 5));

  // Nodes loaded lazily per directory (only needed for truncated trees).
  const [extra, setExtra] = useState<ReadonlyMap<string, GraphNode>>(new Map());
  // null = the user has not opened or closed anything yet, so the default applies.
  const [expandedState, setExpandedState] = useState<ReadonlySet<string> | null>(null);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState("");
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const scrolledFor = useRef<string | undefined>(undefined);
  const syncedFor = useRef<string | undefined>(undefined);

  const truncated = query.data?.truncated === true;
  const baseNodes = query.data?.nodes;
  const model = useMemo(() => {
    if (!baseNodes) return undefined;
    return buildTree(extra.size === 0 ? baseNodes : [...baseNodes, ...extra.values()]);
  }, [baseNodes, extra]);

  const expanded = useMemo(
    () => expandedState ?? (model ? defaultExpanded(model) : new Set<string>()),
    [expandedState, model],
  );
  const allRows = useMemo(
    () => (model ? flattenTree(model.roots, expanded, filter) : []),
    [model, expanded, filter],
  );
  const rows = allRows.length > MAX_ROWS ? allRows.slice(0, MAX_ROWS) : allRows;

  const selectedId = treeIdForNode(params.node);

  const addExtraNodes = useCallback((nodes: GraphNode[]) => {
    setExtra((previous) => {
      if (nodes.every((n) => previous.has(n.id))) return previous; // nothing new: no re-render
      const next = new Map(previous);
      for (const node of nodes) next.set(node.id, node);
      return next;
    });
  }, []);

  // An external selection (search, canvas, URL) opens the folders above it and moves the
  // roving focus to it, without stealing keyboard focus.
  useEffect(() => {
    if (selectedId === undefined || !model || syncedFor.current === selectedId) return;
    syncedFor.current = selectedId; // once per selection, so later arrow-key focus is kept
    const missing = ancestorDirIds(selectedId).filter((id) => !expanded.has(id));
    if (missing.length > 0) setExpandedState(new Set([...expanded, ...missing]));
    setFocusedId(selectedId);
  }, [selectedId, model, expanded]);

  // Scroll the selected row into view once, when it first exists in the DOM.
  useEffect(() => {
    if (selectedId === undefined || scrolledFor.current === selectedId) return;
    const element = rowElements.current.get(selectedId);
    if (!element) return;
    scrolledFor.current = selectedId;
    // jsdom has no scrollIntoView, hence the optional call.
    element.scrollIntoView?.({ block: "nearest" });
  });

  const registerRef = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) rowElements.current.set(id, element);
    else rowElements.current.delete(id);
  }, []);

  function toggle(id: string, open: boolean) {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    setExpandedState(next);
  }

  function activate(row: TreeRow) {
    if (row.item.isDir) toggle(row.item.id, !row.expanded);
    setFocusedId(row.item.id);
    // Selecting from the tree starts a fresh look: drop any call-site highlight.
    setParams({ node: row.item.id, hl: undefined }, { push: true });
  }

  function focusRow(id: string) {
    setFocusedId(id);
    rowElements.current.get(id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!NAV_KEYS.includes(event.key)) return;
    // Do not hijack keys typed in the filter box.
    if (event.target instanceof HTMLInputElement) return;
    const result = navigate(rows, focusedId, event.key as NavKey);
    event.preventDefault();
    if (result?.type === "focus") focusRow(result.id);
    else if (result?.type === "expand") toggle(result.id, true);
    else if (result?.type === "collapse") toggle(result.id, false);
  }

  if (query.isPending) return <TreeSkeleton />;

  if (query.isError || !model) {
    const error = describeError(query.error);
    return (
      <div role="alert" className="space-y-2 p-3 text-sm">
        <p className="font-semibold text-danger">{error.title}</p>
        <p className="text-muted">{error.message}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="h-8 rounded-md border border-line-strong px-3 hover:bg-surface-2"
        >
          Try again
        </button>
      </div>
    );
  }

  const tabbableId = rows.some((r) => r.item.id === focusedId) ? focusedId : rows[0]?.item.id;
  const openDirs = [...expanded].filter((id) => model.byId.has(id));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-tree">
      <div className="border-b border-line p-2">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files"
          aria-label="Filter files"
          className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-sm placeholder:text-muted"
        />
      </div>
      {truncated && (
        <p role="note" className="border-b border-line bg-warn-soft px-3 py-1.5 text-xs text-warn">
          Large repository: some folders are loaded when you open them.
        </p>
      )}
      <div
        role="tree"
        aria-label="Repository files"
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {rows.map((row) => (
          <TreeRowView
            key={row.item.id}
            row={row}
            selected={row.item.id === selectedId}
            tabbable={row.item.id === tabbableId}
            onActivate={activate}
            onFocusRow={setFocusedId}
            registerRef={registerRef}
          />
        ))}
        {rows.length === 0 && (
          <p className="p-3 text-sm text-muted">
            {filter.trim() !== "" ? "No files match the filter." : "No files to show."}
          </p>
        )}
        {allRows.length > MAX_ROWS && (
          <p role="note" className="p-3 text-xs text-muted">
            Showing the first {MAX_ROWS} of {allRows.length} rows. Use the filter to narrow down.
          </p>
        )}
      </div>
      {truncated &&
        filter.trim() === "" &&
        openDirs.map((id) => (
          <DirectoryLoader key={id} analysisId={analysisId} dirId={id} onNodes={addExtraNodes} />
        ))}
    </div>
  );
}
