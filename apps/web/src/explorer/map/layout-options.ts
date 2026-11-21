// fcose layout options as a pure function of the situation (easy to test, no Cytoscape needed).
import type { FcoseLayoutOptions } from "cytoscape-fcose";

export interface LayoutSituation {
  nodeCount: number;
  /** True for a first/new graph (random start, fit to screen); false when merging an expansion. */
  fresh: boolean;
  /** False when the user prefers reduced motion: the layout jumps to its result. */
  animate: boolean;
}

/** Above this many nodes fcose runs in its faster, rougher "draft" quality. */
export const DRAFT_QUALITY_THRESHOLD = 800;

export function fcoseOptions(s: LayoutSituation): FcoseLayoutOptions {
  const big = s.nodeCount > DRAFT_QUALITY_THRESHOLD;
  return {
    name: "fcose",
    quality: big ? "draft" : "default",
    // Keep existing positions as the starting point when only new nodes were added.
    randomize: s.fresh,
    fit: s.fresh,
    // A fresh graph appears at once (nothing to preserve); only expansions glide into place.
    animate: s.animate && !s.fresh && !big,
    animationDuration: 400,
    padding: 30,
    // The three options below are expensive on big graphs, so they are dropped there.
    nodeDimensionsIncludeLabels: !big,
    uniformNodeDimensions: false,
    packComponents: !big,
    nodeRepulsion: () => 6500,
    idealEdgeLength: () => 90,
    edgeElasticity: () => 0.45,
    nestingFactor: 0.12,
    gravity: 0.25,
    gravityRange: 3.8,
    numIter: big ? 600 : 2500,
    tile: !big,
    tilingPaddingVertical: 28,
    tilingPaddingHorizontal: 28,
  };
}
