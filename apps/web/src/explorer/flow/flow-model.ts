// Pure functions behind the Call flow tab: turn the API response into Cytoscape elements,
// build the text alternative (nested caller/callee lists) and map an edge click to the
// "hl" URL parameter. No React and no Cytoscape here, so all of it is unit-testable.
import type { CallflowResponse, Confidence, GraphEdge, GraphNode } from "../../api/types.ts";
import { encodeHighlight } from "../url-state.ts";

/** The server returns at most this many nodes (CALLFLOW_MAX_NODES in packages/store). */
export const FLOW_NODE_LIMIT = 500;

const MAX_LINE1 = 40;
const MAX_SIGNATURE = 56;

/** Functions and methods are the only nodes a call flow can be focused on. */
export function isCallable(node: Pick<GraphNode, "kind">): boolean {
  return node.kind === "function" || node.kind === "method";
}

/** One line of text: whitespace collapsed, cut to `max` characters with an ellipsis. */
export function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Node label: the name on line 1 and the signature (truncated) on line 2. Signatures
 * usually start with the name, which line 1 already shows, so that prefix is dropped.
 */
export function flowLabel(node: GraphNode): string {
  const name = truncateText(node.name, MAX_LINE1);
  if (!node.signature) return name;
  let signature = node.signature.replace(/\s+/g, " ").trim();
  if (signature.startsWith(node.name)) signature = signature.slice(node.name.length).trim();
  return signature === "" ? name : `${name}\n${truncateText(signature, MAX_SIGNATURE)}`;
}

/** Full, untruncated description of a node (used for tooltips and aria-labels). */
export function describeFlowNode(node: GraphNode): string {
  const parts = [node.qualifiedName ?? node.name];
  if (node.signature) parts.push(node.signature);
  if (node.file) {
    const span = node.span ? `:${node.span.startLine}-${node.span.endLine}` : "";
    parts.push(`${node.file}${span}`);
  }
  return parts.join(" — ");
}

// ---------------------------------------------------------------------------
// Cytoscape elements
// ---------------------------------------------------------------------------

export interface FlowNodeData {
  id: string;
  label: string;
  kind: GraphNode["kind"];
  isFocus: boolean;
}

export interface FlowEdgeData {
  /** Not the API's data: edges have no id, so we use "e<index>" (index into the edge list). */
  id: string;
  source: string;
  target: string;
  confidence: Confidence;
  line: number | undefined;
  callCount: number;
}

export interface FlowElements {
  nodes: { data: FlowNodeData }[];
  edges: { data: FlowEdgeData }[];
}

/** Builds Cytoscape element definitions. Edges pointing at unknown nodes are dropped. */
export function buildFlowElements(data: CallflowResponse): FlowElements {
  const ids = new Set(data.nodes.map((n) => n.id));
  const nodes = data.nodes.map((n) => ({
    data: { id: n.id, label: flowLabel(n), kind: n.kind, isFocus: n.id === data.focus },
  }));
  const edges: FlowElements["edges"] = [];
  data.edges.forEach((e, index) => {
    if (!ids.has(e.src) || !ids.has(e.dst)) return;
    edges.push({
      data: {
        id: `e${index}`,
        source: e.src,
        target: e.dst,
        confidence: e.confidence,
        line: e.line,
        callCount: e.meta?.callCount ?? 1,
      },
    });
  });
  return { nodes, edges };
}

/** Looks an edge up by the id `buildFlowElements` gave it. */
export function edgeById(data: CallflowResponse, edgeId: string): GraphEdge | undefined {
  const match = /^e(\d+)$/.exec(edgeId);
  return match ? data.edges[Number.parseInt(match[1] ?? "", 10)] : undefined;
}

/** Tooltip text of an edge: where the call is and how sure we are. */
export function describeFlowEdge(edge: GraphEdge, caller: GraphNode | undefined): string {
  const lines = edge.meta?.lines;
  const place =
    lines && lines.length > 1
      ? `lines ${lines.slice(0, 8).join(", ")}${lines.length > 8 ? ", …" : ""}`
      : edge.line !== undefined
        ? `line ${edge.line}`
        : "line unknown";
  const file = callerFile(caller);
  const count = edge.meta?.callCount ?? 1;
  const calls = count > 1 ? ` · ${count} calls` : "";
  return `Call at ${file ? `${file}, ` : ""}${place} · ${edge.confidence}${calls}`;
}

/** The file a node lives in: `file` for symbols, the path of a file node otherwise. */
function callerFile(node: GraphNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.file) return node.file;
  return node.id.startsWith("file:") ? node.id.slice("file:".length) : undefined;
}

export interface EdgeSelection {
  /** The caller (edge source): selecting it opens its source in the code panel. */
  callerId: string;
  /** Value for the `hl` URL parameter: "path@line" of the call site. */
  hl: string;
}

/**
 * What clicking an edge should do: select the caller and highlight the call-site line in
 * the caller's file. Undefined when the call site is unknown (no line or no file).
 */
export function edgeToSelection(
  edge: GraphEdge,
  nodesById: ReadonlyMap<string, GraphNode>,
): EdgeSelection | undefined {
  const file = callerFile(nodesById.get(edge.src));
  if (file === undefined || edge.line === undefined || edge.line < 1) return undefined;
  return { callerId: edge.src, hl: encodeHighlight(file, edge.line) };
}

// ---------------------------------------------------------------------------
// Text alternative: nested lists of callers and callees
// ---------------------------------------------------------------------------

export interface CallTreeItem {
  node: GraphNode;
  /** The call edge between this item and its parent in the list. */
  edge: GraphEdge;
  /** True when this node was already listed above, so its subtree is not repeated. */
  repeated: boolean;
  children: CallTreeItem[];
}

/**
 * Nested list for the text view. "callees" follows src -> dst from the focus, "callers"
 * follows dst -> src. Each node is expanded only once (so cycles and diamonds stay finite);
 * later occurrences are marked `repeated`.
 */
export function buildCallTree(
  data: CallflowResponse,
  direction: "callers" | "callees",
): CallTreeItem[] {
  const nodesById = new Map(data.nodes.map((n) => [n.id, n]));
  const next = new Map<string, { edge: GraphEdge; target: string }[]>();
  for (const edge of data.edges) {
    const from = direction === "callees" ? edge.src : edge.dst;
    const to = direction === "callees" ? edge.dst : edge.src;
    next.set(from, [...(next.get(from) ?? []), { edge, target: to }]);
  }
  const expanded = new Set<string>([data.focus]);

  const expand = (id: string): CallTreeItem[] => {
    const items: CallTreeItem[] = [];
    for (const { edge, target } of next.get(id) ?? []) {
      const node = nodesById.get(target);
      if (!node) continue;
      if (expanded.has(target)) {
        items.push({ node, edge, repeated: true, children: [] });
        continue;
      }
      expanded.add(target);
      items.push({ node, edge, repeated: false, children: expand(target) });
    }
    return items;
  };
  return expand(data.focus);
}

/** True when the response has nothing but the focus node. */
export function isFlowEmpty(data: CallflowResponse): boolean {
  return data.edges.length === 0;
}
