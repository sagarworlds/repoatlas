import { CONFIDENCE_RANK, type EdgeKind, type GraphEdge, type GraphNode } from "@repoatlas/schema";
import {
  type Db,
  EDGE_COLUMNS,
  type EdgeRow,
  getNodeRow,
  type NodeRow,
  nodeColumns,
  placeholders,
  rowToEdge,
  rowToNode,
  stmt,
} from "./rows.ts";
import type { QueryEdge, SubgraphQuery, SubgraphResult } from "./types.ts";

/** Node kinds that may appear in a subgraph at each level. */
const LEVEL_KINDS: Record<SubgraphQuery["level"], readonly string[]> = {
  dir: ["directory"],
  file: ["directory", "file"],
  symbol: ["directory", "file", "class", "interface", "function", "method"],
};

// ---------------------------------------------------------------------------
// loc rollup cache: sum of descendant file `loc` per directory, per analysis.
// Cleared by the store whenever a graph is saved or deleted.
// ---------------------------------------------------------------------------
const locCache = new WeakMap<Db, Map<string, Map<string, number>>>();

export function clearLocCache(db: Db, analysisId: string): void {
  locCache.get(db)?.delete(analysisId);
}

/** Map nodeId -> loc for directories (sum over descendant files) and files (own loc). */
function getLocTotals(db: Db, analysisId: string): Map<string, number> {
  let perDb = locCache.get(db);
  if (!perDb) {
    perDb = new Map();
    locCache.set(db, perDb);
  }
  const cached = perDb.get(analysisId);
  if (cached) return cached;

  const totals = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  const rows = stmt(
    db,
    `SELECT id, kind, parent_id, loc FROM nodes WHERE analysis_id = ? AND kind IN ('directory','file','repo')`,
  ).all(analysisId) as { id: string; kind: string; parent_id: string | null; loc: number | null }[];
  for (const row of rows) parentOf.set(row.id, row.parent_id);
  for (const row of rows) {
    if (row.kind !== "file" || row.loc === null) continue;
    totals.set(row.id, row.loc);
    // Walk up the ancestors, guarding against cycles in malformed data.
    let current = row.parent_id;
    for (let hops = 0; current !== null && hops < 1000; hops++) {
      totals.set(current, (totals.get(current) ?? 0) + row.loc);
      current = parentOf.get(current) ?? null;
    }
  }
  perDb.set(analysisId, totals);
  return totals;
}

// ---------------------------------------------------------------------------

interface Candidate {
  node: GraphNode;
  depth: number; // contains-levels below the root
}

function childrenOf(db: Db, analysisId: string, parentId: string, limit: number): GraphNode[] {
  const rows = stmt(
    db,
    `SELECT ${nodeColumns("n")} FROM nodes n WHERE n.analysis_id = ? AND n.parent_id = ?
     ORDER BY n.name, n.id LIMIT ?`,
  ).all(analysisId, parentId, limit) as NodeRow[];
  return rows.map(rowToNode);
}

/**
 * better-sqlite3 is synchronous, so the work done per request must be bounded. Collection
 * stops once this many candidates were gathered (a multiple of the node cap, so the
 * lowest-degree trimming in `finish` still has something to choose from).
 */
const CANDIDATE_FACTOR = 4;

/**
 * Collects the root and its contained nodes down to `depth` levels, breadth first (so the
 * shallow nodes always make it in). Stops early at the candidate limit and reports
 * `capped: true`.
 */
function collectNodes(
  db: Db,
  analysisId: string,
  root: GraphNode,
  q: SubgraphQuery,
): { candidates: Candidate[]; capped: boolean } {
  const allowed = new Set(LEVEL_KINDS[q.level]);
  const limit = Math.max(1, q.maxNodes) * CANDIDATE_FACTOR;
  const out: Candidate[] = [];
  let capped = false;
  if (allowed.has(root.kind)) out.push({ node: root, depth: 0 });
  let frontier: GraphNode[] = [root];
  for (let depth = 1; depth <= q.depth && frontier.length > 0 && !capped; depth++) {
    const next: GraphNode[] = [];
    for (const parent of frontier) {
      if (out.length >= limit) {
        capped = true;
        break;
      }
      for (const child of childrenOf(db, analysisId, parent.id, limit)) {
        if (!allowed.has(child.kind)) continue;
        // Test nodes (and directories made only of test files) are dropped together with
        // everything below them.
        if (!q.includeTests && child.meta?.isTest === true) continue;
        out.push({ node: child, depth });
        next.push(child);
      }
    }
    frontier = next;
  }
  return { candidates: out, capped };
}

function realEdgesFrom(
  db: Db,
  analysisId: string,
  src: string,
  kinds: readonly EdgeKind[],
): GraphEdge[] {
  if (kinds.length === 0) return [];
  const rows = stmt(
    db,
    `SELECT ${EDGE_COLUMNS} FROM edges WHERE analysis_id = ? AND src = ?
       AND kind IN (${placeholders(kinds.length)})`,
  ).all(analysisId, src, ...kinds) as EdgeRow[];
  return rows.map(rowToEdge);
}

/**
 * Level-of-detail subgraph (docs/API.md "graph").
 *
 * Edge sources by level:
 * - dir / file: pre-aggregated `rollups` rows of that level whose endpoints were both
 *   returned. They carry `weight`, and `confidence: "inferred"` because an aggregate of
 *   many edges is never an exact fact (unless `minConfidence` is "exact": then every counted
 *   edge was exact). Rollups are stored per variant (tests included or not x minimum
 *   confidence), so `includeTests` and `minConfidence` are honoured at these levels too.
 * - symbol: real edges (kinds from `edgeKinds`, never `contains` since `parentId` already
 *   expresses it) with confidence >= `minConfidence`.
 * With `includeExternal`, real `imports` edges from returned files to `ext:` nodes are added
 * at file and symbol level.
 *
 * `degree` = number of returned-candidate edges touching the node (before truncation).
 */
export function getSubgraph(db: Db, analysisId: string, q: SubgraphQuery): SubgraphResult {
  // "repo:" is not part of any map level; start from the root directory instead.
  const rootId = q.root === "repo:" ? "dir:" : q.root;
  const root = getNodeRow(db, analysisId, rootId);
  if (!root) return { nodes: [], edges: [], truncated: false };

  const { candidates, capped } = collectNodes(db, analysisId, root, q);
  const ids = new Set(candidates.map((c) => c.node.id));
  const kinds = q.edgeKinds.filter((k) => k !== "contains");

  const edges: QueryEdge[] = [];
  if (q.level === "dir" || q.level === "file") {
    const rollupKinds = kinds.filter((k) => k === "imports" || k === "calls");
    if (rollupKinds.length > 0) {
      for (const id of ids) {
        const rows = stmt(
          db,
          `SELECT src, dst, kind, weight FROM rollups WHERE analysis_id = ? AND level = ? AND src = ?
             AND include_tests = ? AND min_confidence = ?
             AND kind IN (${placeholders(rollupKinds.length)})`,
        ).all(analysisId, q.level, id, q.includeTests ? 1 : 0, q.minConfidence, ...rollupKinds) as {
          src: string;
          dst: string;
          kind: string;
          weight: number;
        }[];
        for (const r of rows) {
          if (!ids.has(r.dst) || r.src === r.dst) continue;
          edges.push({
            src: r.src,
            dst: r.dst,
            kind: r.kind as EdgeKind,
            confidence: q.minConfidence === "exact" ? "exact" : "inferred",
            weight: r.weight,
          });
        }
      }
    }
  } else {
    const minRank = CONFIDENCE_RANK[q.minConfidence];
    for (const id of ids) {
      for (const e of realEdgesFrom(db, analysisId, id, kinds)) {
        if (ids.has(e.dst) && CONFIDENCE_RANK[e.confidence] >= minRank) edges.push(e);
      }
    }
  }

  // External packages: only at file/symbol level, reached by imports edges from returned files.
  const externalNodes: GraphNode[] = [];
  if (q.includeExternal && q.level !== "dir" && kinds.includes("imports")) {
    const minRank = CONFIDENCE_RANK[q.minConfidence];
    const seenExternal = new Map<string, GraphNode | undefined>();
    for (const c of candidates) {
      if (c.node.kind !== "file") continue;
      for (const e of realEdgesFrom(db, analysisId, c.node.id, ["imports"])) {
        if (!e.dst.startsWith("ext:") || CONFIDENCE_RANK[e.confidence] < minRank) continue;
        if (!seenExternal.has(e.dst)) {
          const ext = getNodeRow(db, analysisId, e.dst);
          seenExternal.set(e.dst, ext);
          if (ext) externalNodes.push(ext);
        }
        if (seenExternal.get(e.dst)) edges.push(e);
      }
    }
  }

  const result = finish(db, analysisId, q, root.id, candidates, externalNodes, edges);
  return capped ? { ...result, truncated: true } : result;
}

function finish(
  db: Db,
  analysisId: string,
  q: SubgraphQuery,
  rootId: string,
  candidates: Candidate[],
  externalNodes: GraphNode[],
  edges: QueryEdge[],
): SubgraphResult {
  // Degree per node from the candidate edges.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    if (e.dst !== e.src) degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  // Truncation: remove the lowest-degree *leaf* nodes first so that the contains tree
  // stays connected (a kept node never loses its parent). Root is never removed.
  type Entry = { node: GraphNode; depth: number };
  const entries: Entry[] = [
    ...candidates,
    ...externalNodes.map((node) => ({ node, depth: Number.MAX_SAFE_INTEGER })),
  ];
  let truncated = false;
  const removed = new Set<string>();
  if (entries.length > q.maxNodes) {
    truncated = true;
    const childCount = new Map<string, number>();
    for (const { node } of entries) {
      if (node.parentId !== undefined) {
        childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1);
      }
    }
    const order = [...entries].sort(
      (a, b) =>
        (degree.get(a.node.id) ?? 0) - (degree.get(b.node.id) ?? 0) ||
        b.depth - a.depth ||
        (a.node.id < b.node.id ? -1 : 1),
    );
    let remaining = entries.length;
    let progressed = true;
    while (remaining > q.maxNodes && progressed) {
      progressed = false;
      for (const { node } of order) {
        if (remaining <= q.maxNodes) break;
        if (node.id === rootId || removed.has(node.id)) continue;
        if ((childCount.get(node.id) ?? 0) > 0) continue; // not a leaf (yet)
        removed.add(node.id);
        remaining--;
        progressed = true;
        if (node.parentId !== undefined) {
          childCount.set(node.parentId, (childCount.get(node.parentId) ?? 1) - 1);
        }
      }
    }
  }

  let kept = edges.filter((e) => !removed.has(e.src) && !removed.has(e.dst));
  if (kept.length > q.maxEdges) {
    truncated = true;
    kept = kept
      .sort(
        (a, b) =>
          (b.weight ?? 1) - (a.weight ?? 1) ||
          CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
      )
      .slice(0, q.maxEdges);
  }

  const locTotals = getLocTotals(db, analysisId);
  const childCountStmt = stmt(
    db,
    "SELECT count(*) AS c FROM nodes WHERE analysis_id = ? AND parent_id = ?",
  );
  const nodes: GraphNode[] = [];
  for (const { node } of entries) {
    if (removed.has(node.id)) continue;
    const childCount = (childCountStmt.get(analysisId, node.id) as { c: number }).c;
    const meta: Record<string, unknown> = {
      ...node.meta,
      childCount,
      degree: degree.get(node.id) ?? 0,
    };
    const loc =
      node.kind === "directory" || node.kind === "file" ? locTotals.get(node.id) : node.meta?.loc;
    if (loc !== undefined) meta.loc = loc;
    nodes.push({ ...node, meta });
  }
  return { nodes, edges: kept, truncated };
}
