// The only module that touches Cytoscape for the call flow. React talks to this thin
// adapter, so tests can replace it with a fake (jsdom has no canvas).
import type cytoscape from "cytoscape";
import type { FlowElements } from "./flow-model.ts";
import { buildFlowStyle, FLOW_LAYOUT, type FlowPalette } from "./flow-style.ts";

export interface FlowHover {
  kind: "node" | "edge";
  id: string;
  /** Pointer position in pixels, relative to the graph container. */
  x: number;
  y: number;
}

export interface FlowGraphHandlers {
  onNodeTap: (id: string) => void;
  onEdgeTap: (id: string) => void;
  onHover: (hover: FlowHover | null) => void;
}

export interface FlowGraphHandle {
  /** Replaces the graph content and re-runs the layout. */
  setElements: (elements: FlowElements) => void;
  setPalette: (palette: FlowPalette) => void;
  fit: () => void;
  destroy: () => void;
}

let dagreRegistered = false;

/**
 * Creates the graph in `container`. Cytoscape and the dagre extension are loaded with a
 * dynamic import(), so they become a separate chunk that is downloaded only when needed
 * (like loading an assembly on demand).
 */
export async function mountFlowGraph(
  container: HTMLElement,
  elements: FlowElements,
  palette: FlowPalette,
  handlers: FlowGraphHandlers,
): Promise<FlowGraphHandle> {
  const [cytoscapeModule, dagreModule] = await Promise.all([
    import("cytoscape"),
    import("cytoscape-dagre"),
  ]);
  const cy = cytoscapeModule.default;
  if (!dagreRegistered) {
    cy.use(dagreModule.default);
    dagreRegistered = true;
  }

  const instance: cytoscape.Core = cy({
    container,
    elements: [...elements.nodes, ...elements.edges],
    style: buildFlowStyle(palette) as unknown as cytoscape.StylesheetJson,
    layout: FLOW_LAYOUT,
    minZoom: 0.1,
    maxZoom: 2.5,
    wheelSensitivity: 0.3,
    boxSelectionEnabled: false,
    autoungrabify: true,
  });

  instance.on("tap", "node", (event) => handlers.onNodeTap(event.target.id()));
  instance.on("tap", "edge", (event) => handlers.onEdgeTap(event.target.id()));
  instance.on("mouseover", "node, edge", (event) => {
    const target = event.target;
    if (target.isEdge()) target.addClass("hover");
    handlers.onHover({
      kind: target.isEdge() ? "edge" : "node",
      id: target.id(),
      x: event.renderedPosition.x,
      y: event.renderedPosition.y,
    });
  });
  instance.on("mousemove", "node, edge", (event) => {
    const target = event.target;
    handlers.onHover({
      kind: target.isEdge() ? "edge" : "node",
      id: target.id(),
      x: event.renderedPosition.x,
      y: event.renderedPosition.y,
    });
  });
  instance.on("mouseout", "node, edge", (event) => {
    event.target.removeClass("hover");
    handlers.onHover(null);
  });

  return {
    setElements(next) {
      instance.batch(() => {
        instance.elements().remove();
        instance.add([...next.nodes, ...next.edges]);
      });
      instance.layout(FLOW_LAYOUT).run();
    },
    setPalette(next) {
      instance.style(buildFlowStyle(next) as unknown as cytoscape.StylesheetJson);
    },
    fit() {
      instance.fit(undefined, 24);
    },
    destroy() {
      instance.destroy();
    },
  };
}
