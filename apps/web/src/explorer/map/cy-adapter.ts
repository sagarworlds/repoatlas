// The ONLY module that talks to Cytoscape. Components depend on the `MapCanvas` interface,
// so tests can replace this file with a fake (vi.mock) and never need a canvas.
// Cytoscape and the fcose layout are loaded with dynamic import(), which makes the bundler
// put them in a separate chunk that the home page never downloads.
import type { Core, ElementDefinition, EventObject, LayoutOptions } from "cytoscape";
import type { MapEdge, MapGraph, MapNode } from "./graph-model.ts";
import { showEdgeLabels } from "./graph-model.ts";
import { fcoseOptions } from "./layout-options.ts";
import { buildStylesheet } from "./map-style.ts";
import type { MapTheme } from "./map-theme.ts";

export interface MapCanvasHandlers {
  /** A node was clicked (id) or the background was clicked (undefined). */
  onSelect: (id: string | undefined) => void;
  /** A node was double-clicked. */
  onExpand: (id: string) => void;
}

export interface SetGraphOptions {
  /** New graph (random start, fit) versus an expansion merged into the current one. */
  fresh: boolean;
  animate: boolean;
}

export interface MapCanvas {
  /** Makes the canvas show exactly `graph`: adds new elements, removes missing ones. */
  setGraph(graph: MapGraph, options: SetGraphOptions): void;
  /** Selects a node (and optionally pans to it) without changing the layout. False if absent. */
  selectNode(id: string | undefined, center: boolean, animate: boolean): boolean;
  /** Marks nodes with the "most connected" style. */
  setHighlighted(ids: readonly string[]): void;
  setTheme(theme: MapTheme): void;
  fit(): void;
  /** Call when the container changed size. Re-fits unless the user has panned or zoomed. */
  resize(): void;
  exportPng(): Blob | undefined;
  destroy(): void;
}

export type CreateMapCanvas = (
  container: HTMLElement,
  handlers: MapCanvasHandlers,
  theme: MapTheme,
) => Promise<MapCanvas>;

function nodeDefinition(n: MapNode): ElementDefinition {
  return {
    group: "nodes",
    data: {
      id: n.id,
      label: n.label,
      kind: n.kind,
      group: n.group,
      size: n.size,
      degree: n.degree,
      // `parent` makes this a compound child. Left out entirely for top-level nodes.
      ...(n.parent !== undefined ? { parent: n.parent } : {}),
    },
  };
}

function edgeDefinition(e: MapEdge): ElementDefinition {
  return {
    group: "edges",
    data: {
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
      confidence: e.confidence,
      width: e.width,
      label: e.label,
    },
  };
}

let fcoseRegistered = false;

export const createMapCanvas: CreateMapCanvas = async (container, handlers, theme) => {
  const [cytoscapeModule, fcoseModule] = await Promise.all([
    import("cytoscape"),
    import("cytoscape-fcose"),
  ]);
  const cytoscape = cytoscapeModule.default;
  if (!fcoseRegistered) {
    // Registering twice would log a warning; once per page load is enough.
    cytoscape.use(fcoseModule.default);
    fcoseRegistered = true;
  }

  const cy: Core = cytoscape({
    container,
    elements: [],
    style: buildStylesheet(theme),
    minZoom: 0.05,
    maxZoom: 3,
    boxSelectionEnabled: false,
    selectionType: "single",
  });

  let currentTheme = theme;
  // True until the user pans or zooms by hand; while true, a resize re-fits the whole graph.
  let autoFit = true;
  const stopAutoFit = () => {
    autoFit = false;
  };
  container.addEventListener("wheel", stopAutoFit, { passive: true });
  let layout: ReturnType<Core["layout"]> | undefined;

  const clearHover = () => {
    cy.batch(() => {
      cy.elements().removeClass("faded").removeClass("hl");
    });
  };

  // One set of listeners for the whole life of this instance (destroy() removes them).
  cy.on("tap", (event: EventObject) => {
    if (event.target === cy) handlers.onSelect(undefined);
  });
  cy.on("tap", "node", (event: EventObject) => handlers.onSelect(String(event.target.id())));
  cy.on("dbltap", "node", (event: EventObject) => handlers.onExpand(String(event.target.id())));
  cy.on("mouseover", "node", (event: EventObject) => {
    const node = event.target;
    const neighbourhood = node.closedNeighborhood().union(node.descendants());
    const keep = neighbourhood.union(neighbourhood.ancestors());
    cy.batch(() => {
      cy.elements().addClass("faded");
      keep.removeClass("faded").addClass("hl");
    });
  });
  cy.on("mouseout", "node", clearHover);
  cy.on("dragpan", stopAutoFit);

  return {
    setGraph(graph, options) {
      if (options.fresh) autoFit = true;
      const wanted = new Set<string>();
      for (const n of graph.nodes) wanted.add(n.id);
      for (const e of graph.edges) wanted.add(e.id);

      let changed = false;
      const toAdd: ElementDefinition[] = [];
      cy.batch(() => {
        const stale = cy.elements().filter((el) => !wanted.has(el.id()));
        if (stale.nonempty()) {
          stale.remove();
          changed = true;
        }
        // Nodes first (the graph model orders them parent-first), then edges.
        for (const n of graph.nodes) {
          const existing = cy.getElementById(n.id);
          if (existing.nonempty())
            existing.data({ label: n.label, size: n.size, degree: n.degree });
          else toAdd.push(nodeDefinition(n));
        }
        for (const e of graph.edges) {
          const existing = cy.getElementById(e.id);
          if (existing.nonempty()) existing.data({ width: e.width, label: e.label });
          else toAdd.push(edgeDefinition(e));
        }
        if (toAdd.length > 0) {
          cy.add(toAdd);
          changed = true;
        }
        cy.edges().toggleClass("labeled", showEdgeLabels(graph.edges.length));
      });

      if (!changed || graph.nodes.length === 0) return;
      // Only restart the layout for a real change: a repeated call with the same graph
      // must not interrupt a layout that is still running.
      layout?.stop();
      const first = cy.nodes().length === toAdd.filter((d) => d.group === "nodes").length;
      layout = cy.layout(
        fcoseOptions({
          nodeCount: graph.nodes.length,
          fresh: options.fresh || first,
          animate: options.animate,
        }) as LayoutOptions,
      );
      // After an expansion the graph is larger: show all of it again unless the user moved the view.
      layout.one("layoutstop", () => {
        if (autoFit) cy.fit(undefined, 30);
      });
      layout.run();
    },

    selectNode(id, center, animate) {
      cy.elements(":selected").unselect();
      if (id === undefined) return true;
      const ele = cy.getElementById(id);
      if (ele.empty()) return false;
      ele.select();
      if (center) {
        if (animate) cy.animate({ center: { eles: ele } }, { duration: 250 });
        else cy.center(ele);
      }
      return true;
    },

    setHighlighted(ids) {
      const wanted = new Set(ids);
      cy.batch(() => {
        cy.nodes().forEach((node) => {
          node.toggleClass("top", wanted.has(node.id()));
        });
      });
    },

    setTheme(next) {
      currentTheme = next;
      cy.style(buildStylesheet(next));
    },

    fit() {
      autoFit = true;
      cy.fit(undefined, 30);
    },

    resize() {
      cy.resize();
      if (autoFit && cy.nodes().nonempty()) cy.fit(undefined, 30);
    },

    exportPng() {
      const blob = cy.png({ output: "blob", full: true, scale: 2, bg: currentTheme.surface });
      return blob instanceof Blob ? blob : undefined;
    },

    destroy() {
      layout?.stop();
      container.removeEventListener("wheel", stopAutoFit);
      cy.removeAllListeners();
      cy.destroy();
    },
  };
};
