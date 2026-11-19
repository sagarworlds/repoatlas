import type {
  AnalysisStats,
  AnalysisStatus,
  Confidence,
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  Progress,
  RollupRow,
  Unresolved,
} from "@repoatlas/schema";

export interface AnalysisRecord {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  commitSha: string | null;
  analyzerVersion: string;
  status: AnalysisStatus;
  progress: Progress | null;
  stats: AnalysisStats | null;
  error: string | null;
  createdAt: string; // ISO 8601
  finishedAt: string | null;
}

export interface NewAnalysis {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  analyzerVersion: string;
}

export type AnalysisPatch = Partial<
  Pick<AnalysisRecord, "commitSha" | "status" | "progress" | "stats" | "error" | "finishedAt">
>;

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rollups: RollupRow[];
  unresolved: Unresolved[];
}

/** Edge as returned by queries: may carry an aggregated `weight` (dir/file level). */
export interface QueryEdge extends GraphEdge {
  weight?: number;
}

export type GraphLevel = "dir" | "file" | "symbol";

export interface SubgraphQuery {
  level: GraphLevel;
  root: string; // node id, "dir:" for the repo root
  depth: number; // 1..5
  edgeKinds: EdgeKind[];
  includeTests: boolean;
  includeExternal: boolean;
  minConfidence: Confidence;
  maxNodes: number; // API passes 2000
  maxEdges: number; // API passes 6000
}

export interface SubgraphResult {
  /** `meta` carries `childCount`, `loc`, `degree` (docs/API.md). */
  nodes: GraphNode[];
  edges: QueryEdge[];
  truncated: boolean;
}

export interface NodeDetail {
  node: GraphNode;
  /** Breadcrumb nodes from the repo root down to the direct parent. */
  parents: GraphNode[];
  /** Direct `contains` children. */
  children: GraphNode[];
  counts: { callers: number; callees: number; importedBy: number; imports: number };
}

export interface CallflowResult {
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type DepsDirection = "imports" | "importedBy" | "both";

export interface DepsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SearchQuery {
  q: string;
  kinds?: NodeKind[];
  limit: number;
}

/**
 * Persistence interface (ARCHITECTURE §6). SQLite today; Postgres or a graph DB later.
 * Methods are synchronous because better-sqlite3 is; an async backend would change this
 * interface in one place.
 */
export interface GraphStore {
  createAnalysis(input: NewAnalysis): AnalysisRecord;
  updateAnalysis(id: string, patch: AnalysisPatch): void;
  getAnalysis(id: string): AnalysisRecord | undefined;
  /** A finished (`done`) analysis for the cache key, if any. */
  findCached(
    owner: string,
    repo: string,
    commitSha: string,
    analyzerVersion: string,
  ): AnalysisRecord | undefined;
  /** An unfinished analysis (queued..persisting) for the same owner/repo/ref, to dedupe. */
  findInFlight(owner: string, repo: string, ref: string): AnalysisRecord | undefined;
  listAnalyses(limit: number): AnalysisRecord[];
  /** Analyses left in a non-terminal state (for startup recovery). */
  listUnfinished(): AnalysisRecord[];
  /** Insert nodes, edges, rollups, unresolved for `id` in ONE transaction. */
  saveGraph(id: string, data: GraphData): void;
  deleteAnalysis(id: string): void;
  /** The oldest finished (`done` or `failed`) analyses beyond `keep`, for cache eviction. */
  listEvictable(keep: number): AnalysisRecord[];

  getNode(id: string, nodeId: string): GraphNode | undefined;
  /** The `file` node for a repo-relative path, or undefined (source-endpoint lookup). */
  getFileNode(id: string, path: string): GraphNode | undefined;
  getSubgraph(id: string, query: SubgraphQuery): SubgraphResult;
  getNodeDetail(id: string, nodeId: string): NodeDetail | undefined;
  getCallflow(
    id: string,
    nodeId: string,
    depthUp: number,
    depthDown: number,
  ): CallflowResult | undefined;
  getDeps(
    id: string,
    filePath: string,
    direction: DepsDirection,
    depth: number,
  ): DepsResult | undefined;
  search(id: string, query: SearchQuery): GraphNode[];

  close(): void;
}
