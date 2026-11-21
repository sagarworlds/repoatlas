// React side of the canvas: creates the Cytoscape instance once, keeps it in sync with the
// graph, the selection, the highlight and the theme, and destroys it on unmount.
import { type RefObject, useEffect, useRef, useState } from "react";
import { createMapCanvas, type MapCanvas } from "./cy-adapter.ts";
import { type MapGraph, topDegreeIds } from "./graph-model.ts";
import { readMapTheme, useIsDark, usePrefersReducedMotion } from "./map-theme.ts";

export interface UseMapCanvasInput {
  container: RefObject<HTMLDivElement | null>;
  /** The graph to draw; undefined while there is nothing valid to show. */
  graph: MapGraph | undefined;
  /** Identifies the base query: a new key means a fresh layout instead of a merge. */
  baseKey: string;
  selectedId: string | undefined;
  highlightTop: boolean;
  onSelect: (id: string | undefined) => void;
  onExpand: (id: string) => void;
}

export interface UseMapCanvasResult {
  canvas: MapCanvas | undefined;
  failed: boolean;
  /** Re-creates the canvas after a failure (for example a chunk that did not load). */
  retry: () => void;
}

export function useMapCanvas(input: UseMapCanvasInput): UseMapCanvasResult {
  const { container, graph, baseKey, selectedId, highlightTop } = input;
  const [canvas, setCanvas] = useState<MapCanvas | undefined>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dark = useIsDark();
  const reducedMotion = usePrefersReducedMotion();

  // Refs hold the latest callbacks so the listeners registered once at creation never go stale.
  // (Like a delegate field that always points at the current handler.)
  const handlersRef = useRef({ onSelect: input.onSelect, onExpand: input.onExpand });
  handlersRef.current = { onSelect: input.onSelect, onExpand: input.onExpand };

  const appliedBaseKey = useRef<string | undefined>(undefined);
  /** Last id selected by clicking the canvas: the view is already there, so do not pan. */
  const clickedId = useRef<string | undefined>(undefined);
  const centeredId = useRef<string | undefined>(undefined);
  const lastSelectedId = useRef<string | undefined>(undefined);

  // Effect 1: create once, destroy on cleanup. Under React StrictMode (dev) effects run
  // twice; `cancelled` makes sure the first, abandoned instance is destroyed immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs this effect on retry
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let cancelled = false;
    let created: MapCanvas | undefined;
    let observer: ResizeObserver | undefined;
    setFailed(false);
    // Every instance gets its own host element. Two instances (React StrictMode creates and
    // abandons one in development) must never share a DOM node, or destroying one breaks the other.
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0;";
    element.appendChild(host);
    createMapCanvas(
      host,
      {
        onSelect: (id) => {
          clickedId.current = id;
          handlersRef.current.onSelect(id);
        },
        onExpand: (id) => handlersRef.current.onExpand(id),
      },
      readMapTheme(),
    )
      .then((instance) => {
        if (cancelled) {
          instance.destroy();
          return;
        }
        created = instance;
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => instance.resize());
          observer.observe(element);
        }
        appliedBaseKey.current = undefined;
        centeredId.current = undefined;
        setCanvas(instance);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      observer?.disconnect();
      created?.destroy();
      host.remove();
      setCanvas(undefined);
    };
  }, [container, attempt]);

  // Effect 2: push the graph into the canvas (merge or fresh layout).
  useEffect(() => {
    if (!canvas || !graph) return;
    const fresh = appliedBaseKey.current !== baseKey;
    appliedBaseKey.current = baseKey;
    canvas.setGraph(graph, { fresh, animate: !reducedMotion });
    // A fresh layout moves everything, so the selection may need centering again.
    if (fresh) centeredId.current = undefined;
  }, [canvas, graph, baseKey, reducedMotion]);

  // Effect 3: reflect the selected node (from the canvas, tree, search or detail panel).
  useEffect(() => {
    if (!canvas || !graph) return;
    const selectionChanged = lastSelectedId.current !== selectedId;
    lastSelectedId.current = selectedId;
    const wantsCenter =
      selectedId !== undefined &&
      selectedId !== clickedId.current &&
      selectedId !== centeredId.current;
    const found = canvas.selectNode(selectedId, wantsCenter, !reducedMotion);
    centeredId.current = found ? selectedId : undefined;
    // A changed selection that did not come from a canvas click makes the earlier click
    // irrelevant. (Only when it changed: this effect also re-runs when the graph changes.)
    if (selectionChanged && selectedId !== clickedId.current) clickedId.current = undefined;
  }, [canvas, graph, selectedId, reducedMotion]);

  // Effect 4: "most connected" highlight.
  useEffect(() => {
    if (!canvas || !graph) return;
    canvas.setHighlighted(highlightTop ? topDegreeIds(graph.nodes) : []);
  }, [canvas, graph, highlightTop]);

  // Effect 5: restyle when the theme changes. `dark` is the trigger; the colours are re-read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `dark` only triggers the re-read
  useEffect(() => {
    canvas?.setTheme(readMapTheme());
  }, [canvas, dark]);

  return { canvas, failed, retry: () => setAttempt((n) => n + 1) };
}
