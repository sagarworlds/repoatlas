import type { GraphEdge, GraphNode } from "@repoatlas/schema";
import {
  type Db,
  EDGE_COLUMNS,
  type EdgeRow,
  getNodeRow,
  getNodesByIds,
  type NodeRow,
  nodeColumns,
  rowToEdge,
  rowToNode,
  stmt,
} from "./rows.ts";
import type { CallflowResult, DepsDirection, DepsResult, NodeDetail } from "./types.ts";

/** Safety cap on nodes returned by a callflow query. */
export const CALLFLOW_MAX_NODES = 500;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function countEdges(db: Db, sql: string, ...params: string[]): number {
  const row = stmt(db, sql).get(...params) as { c: number };
  return row.c;
}

/**
 * Node detail. Counts are real edges (not rollups).
 *
 * - Ordinary nodes: counts of edges touching the node itself.
 * - File nodes: `imports` / `importedBy` count the file's own import edges, while
 *   `callers` / `callees` aggregate all symbols declared in the file (nodes whose
 *   `file` equals the file path), ignoring calls that stay inside the file.
 */
export function getNodeDetail(db: Db, analysisId: string, nodeId: string): NodeDetail | undefined {
  const node = getNodeRow(db, analysisId, nodeId);
  if (!node) return undefined;

  // Breadcrumb: follow parentId upwards, guarding against cycles in bad data.
  const parents: GraphNode[] = [];
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = getNodeRow(db, analysisId, parentId);
    if (!parent) break;
    parents.push(parent);
    parentId = parent.parentId;
  }
  parents.reverse(); // root first

  const childRows = stmt(
    db,
    `SELECT ${nodeColumns("n")} FROM nodes n WHERE n.analysis_id = ? AND n.parent_id = ?
     ORDER BY n.start_line IS NULL, n.start_line, n.name, n.id`,
  ).all(analysisId, nodeId) as NodeRow[];
  const children = childRows.map(rowToNode);

  const direct = (column: "src" | "dst", kind: string): number =>
    countEdges(
      db,
      `SELECT count(*) AS c FROM edges WHERE analysis_id = ? AND ${column} = ? AND kind = ?`,
      analysisId,
      nodeId,
      kind,
    );

  let callers = direct("dst", "calls");
  let callees = direct("src", "calls");
  if (node.kind === "file" && node.file !== undefined) {
    const inFile = `SELECT id FROM nodes WHERE analysis_id = ? AND file = ? AND kind <> 'file'`;
    callers += countEdges(
      db,
      `SELECT count(*) AS c FROM edges WHERE analysis_id = ? AND kind = 'calls'
         AND dst IN (${inFile}) AND src NOT IN (${inFile})`,
      analysisId,
      analysisId,
      node.file,
      analysisId,
      node.file,
    );
    callees += countEdges(
      db,
      `SELECT count(*) AS c FROM edges WHERE analysis_id = ? AND kind = 'calls'
         AND src IN (${inFile}) AND dst NOT IN (${inFile})`,
      analysisId,
      analysisId,
      node.file,
      analysisId,
      node.file,
    );
  }

  return {
    node,
    parents,
    children,
    counts: {
      callers,
      callees,
      importedBy: direct("dst", "imports"),
      imports: direct("src", "imports"),
    },
  };
}

function edgesFrom(db: Db, analysisId: string, kind: string, column: "src" | "dst", id: string) {
  return (
    stmt(
      db,
      `SELECT ${EDGE_COLUMNS} FROM edges WHERE analysis_id = ? AND ${column} = ? AND kind = ?
       ORDER BY line IS NULL, line, src, dst`,
    ).all(analysisId, id, kind) as EdgeRow[]
  ).map(rowToEdge);
}

/**
 * Breadth-first walk along `kind` edges in one direction. `visited` is private to this
 * direction (cycle safety); a node reached by the other direction must still be expanded
 * here, so it is not shared. `all` collects every node of the result, and the node budget
 * counts a node once. Stops adding new nodes when `budget.remaining` reaches zero.
 */
function walk(
  db: Db,
  analysisId: string,
  kind: string,
  start: string,
  depth: number,
  direction: "up" | "down",
  visited: Set<string>,
  all: Set<string>,
  edges: Map<string, GraphEdge>,
  budget: { remaining: number },
  canExpand: (id: string) => boolean,
): void {
  // "up" follows edges whose dst is the current node (callers); "down" whose src is.
  const column = direction === "up" ? "dst" : "src";
  let frontier = [start];
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of edgesFrom(db, analysisId, kind, column, current)) {
        const other = direction === "up" ? edge.src : edge.dst;
        if (!visited.has(other)) {
          if (!all.has(other)) {
            if (budget.remaining <= 0) continue;
            budget.remaining--;
            all.add(other);
          }
          visited.add(other);
          if (canExpand(other)) next.push(other);
        }
        edges.set(`${edge.src}\u0000${edge.dst}`, edge);
      }
    }
    frontier = next;
  }
}

/**
 * Callers (up) and callees (down) of a node along `calls` edges. Depths are clamped to
 * 0..4. Returns undefined when the node does not exist.
 */
export function getCallflow(
  db: Db,
  analysisId: string,
  nodeId: string,
  depthUp: number,
  depthDown: number,
): CallflowResult | undefined {
  const focus = getNodeRow(db, analysisId, nodeId);
  if (!focus) return undefined;
  const up = clampInt(depthUp, 0, 4);
  const down = clampInt(depthDown, 0, 4);

  const all = new Set<string>([nodeId]);
  const edges = new Map<string, GraphEdge>();
  const budget = { remaining: CALLFLOW_MAX_NODES - 1 };
  const always = () => true;
  const upSeen = new Set<string>([nodeId]);
  const downSeen = new Set<string>([nodeId]);
  walk(db, analysisId, "calls", nodeId, up, "up", upSeen, all, edges, budget, always);
  walk(db, analysisId, "calls", nodeId, down, "down", downSeen, all, edges, budget, always);

  const nodes = getNodesByIds(db, analysisId, [...all]);
  // Keep the focus node first, the rest in a stable order.
  nodes.sort((a, b) => (a.id === nodeId ? -1 : b.id === nodeId ? 1 : a.id.localeCompare(b.id)));
  const keptEdges = [...edges.values()].filter((e) => all.has(e.src) && all.has(e.dst));
  return { focus: nodeId, nodes, edges: keptEdges };
}

/**
 * Import neighbourhood of a file. `imports` follows file -> file/external/module edges
 * outwards (continuing only through file nodes); `importedBy` follows them backwards.
 * Depth is clamped to 1..3. Undefined when the path is not a file node.
 */
export function getDeps(
  db: Db,
  analysisId: string,
  filePath: string,
  direction: DepsDirection,
  depth: number,
): DepsResult | undefined {
  const rootRow = stmt(
    db,
    `SELECT ${nodeColumns("n")} FROM nodes n WHERE n.analysis_id = ? AND n.kind = 'file' AND n.file = ?`,
  ).get(analysisId, filePath) as NodeRow | undefined;
  if (!rootRow) return undefined;
  const root = rowToNode(rootRow);
  const levels = clampInt(depth, 1, 3);

  const all = new Set<string>([root.id]);
  const edges = new Map<string, GraphEdge>();
  const budget = { remaining: CALLFLOW_MAX_NODES - 1 };
  const isFile = (id: string) => id.startsWith("file:");
  if (direction === "imports" || direction === "both") {
    const seen = new Set<string>([root.id]);
    walk(db, analysisId, "imports", root.id, levels, "down", seen, all, edges, budget, isFile);
  }
  if (direction === "importedBy" || direction === "both") {
    const seen = new Set<string>([root.id]);
    walk(db, analysisId, "imports", root.id, levels, "up", seen, all, edges, budget, isFile);
  }
  const nodes = getNodesByIds(db, analysisId, [...all]);
  nodes.sort((a, b) => (a.id === root.id ? -1 : b.id === root.id ? 1 : a.id.localeCompare(b.id)));
  const kept = [...edges.values()].filter((e) => all.has(e.src) && all.has(e.dst));
  return { nodes, edges: kept };
}
