// Pure column model of the Dependencies tab: from the flat {nodes, edges} the API returns
// to "imported by" / "imports" trees plus grouped external packages. No React here.
import { parseId } from "@repoatlas/schema";
import type { DepsResponse, GraphEdge, GraphNode } from "../../api/types.ts";

/** One file in a column. Deeper hops are nested under the file that led to them. */
export interface DepItem {
  node: GraphNode;
  /** Repo-relative path (forward slashes). */
  path: string;
  /** 1 = direct neighbour of the centre file. */
  hop: number;
  /** The import edge that connects this file to its parent (or to the centre at hop 1). */
  edge: GraphEdge;
  /** True when the file is in both columns: the centre takes part in a circular import. */
  circular: boolean;
  children: DepItem[];
}

export interface ExternalItem {
  node: GraphNode;
  /** The package or module name. */
  name: string;
  /** Files (paths) of the analysis that import it, within the shown depth. */
  usedBy: string[];
  /** The first edge to it, for alias / imported names. Prefers an edge from the centre file. */
  edge: GraphEdge;
}

export interface ExternalGroup {
  /** e.g. "npm", "pypi"; "unresolved modules" for module nodes without an ecosystem. */
  label: string;
  items: ExternalItem[];
}

export interface DepsModel {
  center: GraphNode;
  importedBy: DepItem[];
  imports: DepItem[];
  externals: ExternalGroup[];
}

/** Path of a file node (its `file`, or the path in its id). */
export function filePathOf(node: GraphNode): string {
  if (node.file) return node.file;
  const parsed = parseId(node.id);
  return parsed?.kind === "file" ? parsed.path : node.name;
}

/** The file a node id belongs to: the file itself, or the file containing a symbol. */
export function fileOfNodeId(nodeId: string | undefined): string | undefined {
  if (nodeId === undefined) return undefined;
  const parsed = parseId(nodeId);
  if (parsed?.kind === "file" || parsed?.kind === "symbol") return parsed.path;
  return undefined;
}

const byPath = (a: DepItem, b: DepItem) => a.path.localeCompare(b.path);

/**
 * Walks import edges outwards from the centre, breadth first. Every file is placed once, at
 * its shortest distance, so circular imports and diamonds never repeat a file in a column.
 * `forward` = follow src -> dst (what the file imports); otherwise dst -> src (importers).
 */
function walkFiles(
  centerId: string,
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, GraphNode>,
  forward: boolean,
  maxDepth: number,
): DepItem[] {
  const next = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    const from = forward ? edge.src : edge.dst;
    next.set(from, [...(next.get(from) ?? []), edge]);
  }

  const placed = new Set<string>([centerId]);
  const roots: DepItem[] = [];
  let frontier: { id: string; children: DepItem[] }[] = [{ id: centerId, children: roots }];

  for (let hop = 1; hop <= maxDepth; hop++) {
    const following: { id: string; children: DepItem[] }[] = [];
    for (const { id, children } of frontier) {
      for (const edge of next.get(id) ?? []) {
        const targetId = forward ? edge.dst : edge.src;
        const node = nodesById.get(targetId);
        // Externals and modules are leaves, handled separately. Seen files are not repeated.
        if (node?.kind !== "file" || placed.has(targetId)) continue;
        placed.add(targetId);
        const item: DepItem = {
          node,
          path: filePathOf(node),
          hop,
          edge,
          circular: false,
          children: [],
        };
        children.push(item);
        following.push({ id: targetId, children: item.children });
      }
      children.sort(byPath);
    }
    frontier = following;
  }
  return roots;
}

function flatten(items: readonly DepItem[]): DepItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children)]);
}

function markCircular(items: DepItem[], otherSide: ReadonlySet<string>): void {
  for (const item of flatten(items)) item.circular = otherSide.has(item.node.id);
}

/** External packages and unresolved modules reachable through imports, grouped by ecosystem. */
function collectExternals(
  center: GraphNode,
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, GraphNode>,
  shownFiles: ReadonlySet<string>,
): ExternalGroup[] {
  const found = new Map<string, ExternalItem>();
  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    const target = nodesById.get(edge.dst);
    const source = nodesById.get(edge.src);
    if (!target || !source) continue;
    if (target.kind !== "external" && target.kind !== "module") continue;
    if (!shownFiles.has(source.id)) continue;
    const usedBy = filePathOf(source);
    const existing = found.get(target.id);
    if (!existing) {
      found.set(target.id, { node: target, name: target.name, usedBy: [usedBy], edge });
      continue;
    }
    if (!existing.usedBy.includes(usedBy)) existing.usedBy.push(usedBy);
    if (source.id === center.id) existing.edge = edge;
  }

  const groups = new Map<string, ExternalItem[]>();
  for (const item of found.values()) {
    item.usedBy.sort();
    const label = ecosystemOf(item.node);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, items]) => ({
      label,
      items: items.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

export const UNRESOLVED_LABEL = "unresolved modules";

function ecosystemOf(node: GraphNode): string {
  if (node.meta?.ecosystem) return node.meta.ecosystem;
  const parsed = parseId(node.id);
  if (parsed?.kind === "external") return parsed.ecosystem;
  return UNRESOLVED_LABEL;
}

/**
 * Builds the three columns. `depth` is the number of hops requested from the API (1-3);
 * the walk is also capped by it so a larger response never shows more than asked.
 * Returns undefined when the centre file is not part of the response.
 */
export function buildDepsModel(
  data: DepsResponse,
  centerPath: string,
  depth: number,
): DepsModel | undefined {
  const center = data.nodes.find((n) => n.kind === "file" && filePathOf(n) === centerPath);
  if (!center) return undefined;
  const nodesById = new Map(data.nodes.map((n) => [n.id, n]));

  const imports = walkFiles(center.id, data.edges, nodesById, true, depth);
  const importedBy = walkFiles(center.id, data.edges, nodesById, false, depth);

  const importIds = new Set(flatten(imports).map((i) => i.node.id));
  const importerIds = new Set(flatten(importedBy).map((i) => i.node.id));
  markCircular(imports, importerIds);
  markCircular(importedBy, importIds);

  // Externals count when imported by the centre or by any file shown in the right column.
  const rightFiles = new Set<string>([center.id, ...importIds]);
  const externals = collectExternals(center, data.edges, nodesById, rightFiles);
  return { center, importedBy, imports, externals };
}

/** Counts files in a column, nested ones included. */
export function countItems(items: readonly DepItem[]): number {
  return flatten(items).length;
}

/** Compact text for what an import edge carries: alias, imported names, dynamic. */
export function edgeMetaText(edge: GraphEdge): string[] {
  const parts: string[] = [];
  const names = edge.meta?.importedNames;
  if (names && names.length > 0) {
    const shown = names.slice(0, 5).join(", ");
    parts.push(`imports ${shown}${names.length > 5 ? `, +${names.length - 5} more` : ""}`);
  }
  if (edge.meta?.alias) parts.push(`as ${edge.meta.alias}`);
  if (edge.meta?.isDynamic) parts.push("dynamic");
  if (edge.line !== undefined) parts.push(`line ${edge.line}`);
  return parts;
}
