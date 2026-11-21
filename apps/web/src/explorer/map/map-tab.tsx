import { useCallback, useMemo, useRef, useState } from "react";
import type { AnalysisRecordDto, GraphParams } from "../../api/types.ts";
import { describeError } from "../../lib/error-text.ts";
import { useExplorerParams } from "../url-state.ts";
import { downloadBlob, pngFilename } from "./download.ts";
import { isExpandable } from "./graph-model.ts";
import { EmptyOverlay, ErrorOverlay, LoadingOverlay, TruncationNotice } from "./map-overlays.tsx";
import { MapStatusBar } from "./map-status-bar.tsx";
import { MapToolbar, type MapToolbarValues } from "./map-toolbar.tsx";
import { NodeList } from "./node-list.tsx";
import { useMapCanvas } from "./use-map-canvas.ts";
import { useMapGraph } from "./use-map-graph.ts";

/**
 * The Map tab: toolbar, breadcrumb, Cytoscape canvas and an accessible node list.
 * All state that should survive a reload or be shareable lives in the URL (useExplorerParams);
 * only purely visual toggles (list open, highlight) are local component state.
 */
export function MapTab(props: { analysisId: string; analysis: AnalysisRecordDto }) {
  const { analysisId, analysis } = props;
  const { params, setParams } = useExplorerParams();
  const [highlightTop, setHighlightTop] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // useMemo keeps the object identity stable, so the query only re-runs when a value changes.
  const graphParams = useMemo<GraphParams>(
    () => ({
      level: params.level,
      root: params.root,
      depth: params.depth,
      edgeKinds: params.kinds,
      includeTests: params.tests,
      includeExternal: params.ext,
      minConfidence: params.conf,
    }),
    [params.level, params.root, params.depth, params.kinds, params.tests, params.ext, params.conf],
  );
  const { query, baseKey, built, expand, expanding, expandError, clearExpandError } = useMapGraph(
    analysisId,
    graphParams,
  );

  // While TanStack shows the previous result for new params, do not draw it again.
  const graph = query.isPlaceholderData ? undefined : built?.graph;
  const nodes = graph?.nodes;

  const selectNode = useCallback(
    (id: string | undefined) => {
      if (id === params.node) return;
      setParams({ node: id }, { push: true });
    },
    [params.node, setParams],
  );

  const expandNode = useCallback(
    (id: string) => {
      const node = nodes?.find((n) => n.id === id);
      if (node && isExpandable(node, params.level)) void expand(id);
    },
    [nodes, params.level, expand],
  );

  const focusNode = useCallback(
    (id: string) => setParams({ root: id }, { push: true }),
    [setParams],
  );

  const { canvas, failed, retry } = useMapCanvas({
    container: containerRef,
    graph,
    baseKey,
    selectedId: params.node,
    highlightTop,
    onSelect: selectNode,
    onExpand: expandNode,
  });

  function exportPng() {
    const blob = canvas?.exportPng();
    if (blob) downloadBlob(blob, pngFilename(analysis.repo, params.root));
  }

  const toolbarValues: MapToolbarValues = {
    level: params.level,
    kinds: params.kinds,
    conf: params.conf,
    tests: params.tests,
    ext: params.ext,
    depth: params.depth,
  };

  const loading = query.isPending || query.isPlaceholderData;
  const empty = !loading && !query.isError && graph !== undefined && graph.nodes.length === 0;
  const selected = nodes?.find((n) => n.id === params.node);
  const summary = `Dependency map with ${graph?.nodes.length ?? 0} nodes and ${
    graph?.edges.length ?? 0
  } edges. Use the list of nodes button to browse it with the keyboard.`;

  let overlay = null;
  if (query.isError) {
    const error = describeError(query.error);
    overlay = (
      <ErrorOverlay
        title={error.title}
        message={error.message}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (failed) {
    overlay = (
      <ErrorOverlay
        title="The map could not be drawn"
        message="The graph library failed to load. Check your connection and try again."
        onRetry={retry}
      />
    );
  } else if (loading) {
    overlay = <LoadingOverlay />;
  } else if (empty) {
    overlay = <EmptyOverlay />;
  }

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden" data-testid="map-tab">
      <MapToolbar
        values={toolbarValues}
        onChange={(patch) => setParams(patch)}
        highlightTop={highlightTop}
        onToggleHighlightTop={() => setHighlightTop((v) => !v)}
        onFit={() => canvas?.fit()}
        onExportPng={exportPng}
        listOpen={listOpen}
        onToggleList={() => setListOpen((v) => !v)}
        canvasReady={canvas !== undefined && graph !== undefined && graph.nodes.length > 0}
      />
      <MapStatusBar
        rootId={params.root}
        repoLabel={`${analysis.owner}/${analysis.repo}`}
        level={params.level}
        nodeCount={graph?.nodes.length ?? 0}
        edgeCount={graph?.edges.length ?? 0}
        selected={selected}
        expanding={expanding}
        onNavigate={focusNode}
        onExpand={expandNode}
        onFocus={focusNode}
      />
      {built?.truncated && !loading && (
        <TruncationNotice shown={graph?.nodes.length ?? 0} droppedByCap={built.droppedByCap} />
      )}
      {expandError !== undefined && (
        <div
          role="alert"
          className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-1.5 text-xs"
        >
          <span>{expandError}</span>
          <button type="button" className="underline" onClick={clearExpandError}>
            Dismiss
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* The canvas element exists in every state so Cytoscape can be created once. */}
        <div ref={containerRef} role="img" aria-label={summary} className="absolute inset-0" />
        {overlay}
      </div>
      {listOpen && nodes && (
        <NodeList
          nodes={nodes}
          level={params.level}
          selectedId={params.node}
          onSelect={selectNode}
          onExpand={expandNode}
          onFocus={focusNode}
        />
      )}
    </div>
  );
}
