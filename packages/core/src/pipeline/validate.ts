import type { GraphEdge } from "@repoatlas/schema";

/**
 * Edge validation (SECURITY / GRAPH_SCHEMA invariants):
 *  - both endpoints must be known node ids,
 *  - `contains` edges are exact and never self-loops (other kinds may be self-loops,
 *    e.g. recursion),
 *  - plugins never emit `contains` edges: the tree is core's job.
 * Returns the edges that passed and how many were dropped.
 */
export function validateEdges(
  edges: readonly GraphEdge[],
  nodeIds: ReadonlySet<string>,
  fromPlugin: boolean,
): { kept: GraphEdge[]; dropped: number } {
  const kept: GraphEdge[] = [];
  let dropped = 0;
  for (const edge of edges) {
    const valid =
      nodeIds.has(edge.src) &&
      nodeIds.has(edge.dst) &&
      !(
        edge.kind === "contains" &&
        (fromPlugin || edge.src === edge.dst || edge.confidence !== "exact")
      );
    if (valid) kept.push(edge);
    else dropped++;
  }
  return { kept, dropped };
}
