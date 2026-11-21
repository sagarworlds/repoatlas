import { CONFIDENCE_RANK } from "@repoatlas/schema";
import type { CallflowResponse, Confidence } from "./types.ts";

/**
 * The callflow endpoint has no confidence filter, so the UI applies it here: keep edges at
 * or above `min`, then keep only nodes still reachable from the focus (callees by following
 * src -> dst, callers by following dst -> src). Pure function.
 */
export function filterCallflowByConfidence(
  data: CallflowResponse,
  min: Confidence,
): CallflowResponse {
  if (min === "name-match") return data;
  const edges = data.edges.filter((e) => CONFIDENCE_RANK[e.confidence] >= CONFIDENCE_RANK[min]);

  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const e of edges) {
    down.set(e.src, [...(down.get(e.src) ?? []), e.dst]);
    up.set(e.dst, [...(up.get(e.dst) ?? []), e.src]);
  }
  const keep = new Set<string>([data.focus]);
  for (const adjacency of [down, up]) {
    const queue = [data.focus];
    const seen = new Set(queue);
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        keep.add(next);
        queue.push(next);
      }
    }
  }
  return {
    focus: data.focus,
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
  };
}
