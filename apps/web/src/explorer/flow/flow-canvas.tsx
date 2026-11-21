import { useEffect, useMemo, useRef, useState } from "react";
import type { CallflowResponse } from "../../api/types.ts";
import { type FlowGraphHandle, type FlowHover, mountFlowGraph } from "./cy-flow-adapter.ts";
import {
  buildFlowElements,
  describeFlowEdge,
  describeFlowNode,
  edgeById,
  isCallable,
} from "./flow-model.ts";
import { readFlowPalette } from "./flow-style.ts";

interface FlowCanvasProps {
  data: CallflowResponse;
  /** Clicking a node (other than the focus) re-focuses the flow on it. */
  onNodeClick: (nodeId: string) => void;
  /** Clicking an edge opens the call site. `edgeId` is resolved with edgeById(). */
  onEdgeClick: (edgeId: string) => void;
}

/**
 * The Cytoscape canvas. React owns the lifecycle: useEffect with an empty dependency array
 * runs once after the first render (like a constructor + Loaded event), and the function it
 * returns is the cleanup that runs on unmount (like Dispose).
 */
export function FlowCanvas({ data, onNodeClick, onEdgeClick }: FlowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<FlowGraphHandle | null>(null);
  const [hover, setHover] = useState<FlowHover | null>(null);
  const [loadError, setLoadError] = useState(false);

  const elements = useMemo(() => buildFlowElements(data), [data]);
  const nodesById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);

  // The mount effect runs once, so it reads the latest values through refs
  // instead of closing over stale props.
  const latest = useRef({ elements, onNodeClick, onEdgeClick });
  latest.current = { elements, onNodeClick, onEdgeClick };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const initial = latest.current.elements;
    mountFlowGraph(container, initial, readFlowPalette(), {
      onNodeTap: (id) => latest.current.onNodeClick(id),
      onEdgeTap: (id) => latest.current.onEdgeClick(id),
      onHover: setHover,
    })
      .then((handle) => {
        if (cancelled) {
          handle.destroy();
          return;
        }
        handleRef.current = handle;
        // The data may have changed while Cytoscape was loading.
        if (latest.current.elements !== initial) handle.setElements(latest.current.elements);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, []);

  // Re-layout when the data changes.
  useEffect(() => {
    handleRef.current?.setElements(elements);
    setHover(null);
  }, [elements]);

  // Cytoscape cannot see CSS variables: re-read the palette when the theme class changes.
  useEffect(() => {
    const observer = new MutationObserver(() => handleRef.current?.setPalette(readFlowPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const tip = hover ? tooltipText(hover, data, nodesById) : undefined;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-surface">
      <div
        ref={containerRef}
        data-testid="flow-canvas"
        className="absolute inset-0"
        // Inline on purpose: Cytoscape injects an unlayered `position: relative` rule for its
        // container, which beats Tailwind's layered `absolute` class and collapses the height.
        style={{ position: "absolute", inset: 0 }}
        role="img"
        aria-label={`Call graph of ${nodesById.get(data.focus)?.name ?? "the selected function"}: ${data.nodes.length} functions, ${data.edges.length} calls. The same information is available as a list below.`}
      />
      {loadError && (
        <p
          role="alert"
          className="absolute inset-x-4 top-4 rounded-md bg-danger-soft p-3 text-sm text-danger"
        >
          The graph library could not be loaded. Use the list below instead.
        </p>
      )}
      <button
        type="button"
        onClick={() => handleRef.current?.fit()}
        className="absolute right-3 top-3 h-8 rounded-md border border-line-strong bg-surface px-3 text-xs font-medium hover:bg-surface-2"
      >
        Fit view
      </button>
      {hover && tip && (
        // pointer-events-none: the tooltip must never steal the hover from the graph.
        <div
          role="tooltip"
          data-testid="flow-tooltip"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
          className="pointer-events-none absolute z-10 max-w-sm break-words rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-md"
        >
          {tip}
        </div>
      )}
    </div>
  );
}

function tooltipText(
  hover: FlowHover,
  data: CallflowResponse,
  nodesById: ReadonlyMap<string, CallflowResponse["nodes"][number]>,
): string | undefined {
  if (hover.kind === "node") {
    const node = nodesById.get(hover.id);
    if (!node) return undefined;
    return isCallable(node) ? describeFlowNode(node) : `${node.kind}: ${describeFlowNode(node)}`;
  }
  const edge = edgeById(data, hover.id);
  return edge ? describeFlowEdge(edge, nodesById.get(edge.src)) : undefined;
}
