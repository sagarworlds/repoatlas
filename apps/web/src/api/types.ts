// Response shapes of the HTTP API, exactly as docs/API.md and apps/api/src/routes describe them.
// The domain types (nodes, edges, stats) come from the schema package: it is the contract.
import type {
  AnalysisStats,
  AnalysisStatus,
  Confidence,
  EdgeKind,
  GraphEdge,
  GraphNode,
  LanguageId,
  NodeKind,
  Progress,
} from "@repoatlas/schema";

export type {
  AnalysisStats,
  AnalysisStatus,
  Confidence,
  EdgeKind,
  GraphEdge,
  GraphNode,
  LanguageId,
  NodeKind,
  Progress,
};

/** The single error body: { error: { code, message } }. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Failure reason of an analysis (`error` of a failed analysis record). */
export interface AnalysisFailure {
  code: string;
  message: string;
}

/** GET /api/analyses/:id (and each item of GET /api/analyses). */
export interface AnalysisRecordDto {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  /** Null only before the ref has been resolved (never for records the API creates). */
  commitSha: string | null;
  status: AnalysisStatus;
  progress: Progress | null;
  /** Present when status is `done`. */
  stats: AnalysisStats | null;
  /** Present when status is `failed`. */
  error: AnalysisFailure | null;
  createdAt: string;
  finishedAt: string | null;
}

/** POST /api/analyses body. */
export interface StartAnalysisRequest {
  repoUrl: string;
  ref?: string;
}

/** POST /api/analyses response (202 new/in flight, 200 cached). */
export interface StartAnalysisResponse {
  id: string;
  status: AnalysisStatus;
  owner: string;
  repo: string;
  ref: string;
  commitSha: string | null;
  cached: boolean;
}

/** GET /api/analyses?limit=n */
export interface AnalysesListResponse {
  analyses: AnalysisRecordDto[];
}

export type GraphLevel = "dir" | "file" | "symbol";
export type DepsDirection = "imports" | "importedBy" | "both";

/** Query of GET /api/analyses/:id/graph (names as used in the UI; the client maps them). */
export interface GraphParams {
  level: GraphLevel;
  /** Node id, "dir:" for the repository root. */
  root: string;
  depth: number;
  edgeKinds: EdgeKind[];
  includeTests: boolean;
  includeExternal: boolean;
  minConfidence: Confidence;
}

/** Edge of a dir/file level graph: aggregated, with a `weight`. */
export interface MapEdge extends GraphEdge {
  weight?: number;
}

/** GET /api/analyses/:id/graph */
export interface GraphResponse {
  nodes: GraphNode[];
  edges: MapEdge[];
  truncated: boolean;
}

/** GET /api/analyses/:id/node */
export interface NodeDetailResponse {
  node: GraphNode;
  /** Breadcrumb nodes from the repo root down to the direct parent. */
  parents: GraphNode[];
  children: GraphNode[];
  counts: { callers: number; callees: number; importedBy: number; imports: number };
}

/** GET /api/analyses/:id/callflow */
export interface CallflowResponse {
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** GET /api/analyses/:id/deps */
export interface DepsResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** GET /api/analyses/:id/search */
export interface SearchResponse {
  results: GraphNode[];
}

/** GET /api/analyses/:id/source */
export interface SourceResponse {
  file: string;
  language: LanguageId | null;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}
