// Pure functions that turn API graph payloads into the element model the map draws.
// No Cytoscape, no React: easy to unit test (like a plain static C# helper class).
import type { Confidence, EdgeKind, GraphResponse, NodeKind } from "../../api/types.ts";

/** Hard cap: the canvas never gets more nodes than this (docs/UI.md "Performance"). */
export const MAX_RENDER_NODES = 2000;
/** Edge labels (weights) are switched off above this many edges. */
export const EDGE_LABEL_LIMIT = 500;
export const TOP_DEGREE_COUNT = 10;

/** One node as the canvas needs it. `parent` is set only when the parent is in the same set. */
export interface MapNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Compound parent id, or undefined for a top-level node (also for orphans). */
  parent: string | undefined;
  /** Top-level directory name; drives the colour. "" for files in the repo root. */
  group: string;
  /** Path relative to the repo root, "" for the root itself or when unknown. */
  path: string;
  degree: number;
  size: number;
  /** Number of direct children in the full graph (from the API), 0 when unknown. */
  childCount: number;
  isTest: boolean;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  confidence: Confidence;
  weight: number;
  width: number;
  /** Text shown when edge labels are enabled; empty for weight 1. */
  label: string;
}

export interface MapGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface BuiltGraph {
  graph: MapGraph;
  /** True when the API truncated the result or the 2,000 node cap removed nodes. */
  truncated: boolean;
  /** Nodes dropped by our own cap (0 unless the merged result exceeded the cap). */
  droppedByCap: number;
}

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

const MIN_SIZE = 12;
const MAX_SIZE = 72;

/** Node diameter in px: grows with log2(degree), clamped. Methods start smaller, folders larger (their labels need room). */
export function nodeSize(degree: number, kind: NodeKind): number {
  const base = kind === "method" ? 12 : kind === "directory" ? 26 : 18;
  const d = Number.isFinite(degree) && degree > 0 ? degree : 0;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, base + 6 * Math.log2(1 + d)));
}

/** Edge width in px: 1 at weight 1, growing with ln(weight), at most 8. */
export function edgeWidth(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 1) return 1;
  return Math.min(8, 1 + 1.1 * Math.log(weight));
}

// ---------------------------------------------------------------------------
// Ids and paths
// ---------------------------------------------------------------------------

/** Repo-relative path encoded in a dir:/file:/sym: id; "" when the id has none. */
export function pathOfId(id: string): string {
  if (id.startsWith("dir:") || id.startsWith("file:")) return id.slice(id.indexOf(":") + 1);
  if (id.startsWith("sym:")) {
    const rest = id.slice(4);
    const hash = rest.indexOf("#");
    return hash >= 0 ? rest.slice(0, hash) : rest;
  }
  return "";
}

/**
 * The top-level directory a node belongs to (colour key). A directory's own first path
 * segment counts; a file in the repo root has no group (""). External packages get their own key.
 */
export function topLevelGroup(id: string, kind: NodeKind): string {
  if (kind === "external") return "\u0000external";
  const path = pathOfId(id);
  if (path === "") return "";
  const segments = path.split("/");
  if (kind === "directory") return segments[0] ?? "";
  return segments.length > 1 ? (segments[0] ?? "") : "";
}

function numberMeta(meta: Record<string, unknown> | undefined, key: string): number {
  const value = meta?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Merge (used when a directory is expanded)
// ---------------------------------------------------------------------------

export function edgeKey(e: { kind: string; src: string; dst: string }): string {
  return `${e.kind}|${e.src}|${e.dst}`;
}

/**
 * Union of two graph responses without duplicates. Nodes keep the first version seen
 * (the base), edges are matched by kind+src+dst and keep the larger weight.
 */
export function mergeGraphResponses(base: GraphResponse, extra: GraphResponse): GraphResponse {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const node of extra.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);

  const edges = new Map(base.edges.map((e) => [edgeKey(e), e]));
  for (const edge of extra.edges) {
    const key = edgeKey(edge);
    const existing = edges.get(key);
    if (!existing || (edge.weight ?? 1) > (existing.weight ?? 1)) edges.set(key, edge);
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: base.truncated || extra.truncated,
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Walks up the parent chain; true when it loops back (malformed data must not hang us). */
function hasParentCycle(id: string, parentOf: ReadonlyMap<string, string | undefined>): boolean {
  let current = parentOf.get(id);
  for (let hops = 0; current !== undefined && hops <= parentOf.size; hops++) {
    if (current === id) return true;
    current = parentOf.get(current);
  }
  return current !== undefined;
}

function depthOf(id: string, parentOf: ReadonlyMap<string, string | undefined>): number {
  let depth = 0;
  let current = parentOf.get(id);
  while (current !== undefined && depth <= parentOf.size) {
    depth++;
    current = parentOf.get(current);
  }
  return depth;
}

/**
 * Converts a graph response into the canvas model:
 * - drops duplicate nodes/edges, `contains` edges, self loops and edges with a missing end;
 * - keeps `parent` only when the parent is present (an "orphan parent" becomes top level);
 * - applies the render cap, keeping shallow, well-connected nodes (parents always survive
 *   before their children because they are shallower);
 * - orders nodes parent-first so a compound parent is always added before its children.
 */
export function buildMapGraph(
  response: GraphResponse,
  maxNodes: number = MAX_RENDER_NODES,
): BuiltGraph {
  const unique = new Map(
    response.nodes.map((n) => [n.id, n] as const).reverse(), // reverse: first duplicate wins
  );

  // Effective parents.
  const parentOf = new Map<string, string | undefined>();
  for (const node of unique.values()) {
    const p = node.parentId;
    parentOf.set(node.id, p !== undefined && p !== node.id && unique.has(p) ? p : undefined);
  }
  for (const id of [...parentOf.keys()]) {
    if (hasParentCycle(id, parentOf)) parentOf.set(id, undefined);
  }

  // Edges between existing nodes only.
  const edgeMap = new Map<string, GraphResponse["edges"][number]>();
  for (const e of response.edges) {
    if (e.kind === "contains" || e.src === e.dst) continue;
    if (!unique.has(e.src) || !unique.has(e.dst)) continue;
    const key = edgeKey(e);
    const existing = edgeMap.get(key);
    if (!existing || (e.weight ?? 1) > (existing.weight ?? 1)) edgeMap.set(key, e);
  }

  // Degree: the API value (counted before its own truncation) or what we can see, whichever is larger.
  const seenDegree = new Map<string, number>();
  for (const e of edgeMap.values()) {
    seenDegree.set(e.src, (seenDegree.get(e.src) ?? 0) + 1);
    seenDegree.set(e.dst, (seenDegree.get(e.dst) ?? 0) + 1);
  }
  const degreeOf = (id: string): number => {
    const node = unique.get(id);
    const meta = node?.meta as Record<string, unknown> | undefined;
    return Math.max(numberMeta(meta, "degree"), seenDegree.get(id) ?? 0);
  };

  // Order: shallow first, then most connected, then by id (deterministic).
  const ordered = [...unique.values()]
    .map((n) => ({ node: n, depth: depthOf(n.id, parentOf), degree: degreeOf(n.id) }))
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        b.degree - a.degree ||
        (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
    );
  const kept = ordered.slice(0, Math.max(0, maxNodes));
  const keptIds = new Set(kept.map((k) => k.node.id));
  const droppedByCap = ordered.length - kept.length;

  const nodes: MapNode[] = kept.map(({ node, degree }) => {
    const parent = parentOf.get(node.id);
    const meta = node.meta as Record<string, unknown> | undefined;
    return {
      id: node.id,
      label: node.name !== "" ? node.name : "(root)",
      kind: node.kind,
      parent: parent !== undefined && keptIds.has(parent) ? parent : undefined,
      group: topLevelGroup(node.id, node.kind),
      path: node.file ?? pathOfId(node.id),
      degree,
      size: nodeSize(degree, node.kind),
      childCount: numberMeta(meta, "childCount"),
      isTest: node.meta?.isTest === true,
    };
  });

  const edges: MapEdge[] = [];
  for (const e of edgeMap.values()) {
    if (!keptIds.has(e.src) || !keptIds.has(e.dst)) continue;
    const weight = e.weight ?? e.meta?.callCount ?? 1;
    edges.push({
      id: edgeKey(e),
      source: e.src,
      target: e.dst,
      kind: e.kind,
      confidence: e.confidence,
      weight,
      width: edgeWidth(weight),
      label: weight > 1 ? String(weight) : "",
    });
  }

  return {
    graph: { nodes, edges },
    truncated: response.truncated || droppedByCap > 0,
    droppedByCap,
  };
}

/** Ids of the `count` most connected nodes (degree > 0), most connected first. */
export function topDegreeIds(
  nodes: readonly MapNode[],
  count: number = TOP_DEGREE_COUNT,
): string[] {
  return nodes
    .filter((n) => n.degree > 0)
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, count)
    .map((n) => n.id);
}

export function showEdgeLabels(edgeCount: number): boolean {
  return edgeCount <= EDGE_LABEL_LIMIT;
}

/**
 * Can this node be expanded (children fetched and merged) or used as a new root?
 * Directories always; files only at symbol level, where they contain symbols.
 */
export function isExpandable(
  node: Pick<MapNode, "kind">,
  level: "dir" | "file" | "symbol",
): boolean {
  if (node.kind === "directory") return true;
  return node.kind === "file" && level === "symbol";
}

export function hasChildrenInGraph(graph: MapGraph, id: string): boolean {
  return graph.nodes.some((n) => n.parent === id);
}
