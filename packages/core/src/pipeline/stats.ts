import {
  type AnalysisStats,
  type Confidence,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  SCHEMA_VERSION,
} from "@repoatlas/schema";
import { ANALYZER_VERSION } from "./version.ts";

export interface StatsInput {
  commitSha: string;
  languages: AnalysisStats["languages"];
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  references: AnalysisStats["references"];
  skippedFiles: AnalysisStats["skippedFiles"];
  parseErrorFiles: number;
  droppedInvalidEdges: number;
  pluginErrors: AnalysisStats["pluginErrors"];
  truncated: boolean;
  timingsMs: Record<string, number>;
  /** Extraction cache hits/misses; undefined when no cache was used. */
  cache?: { hits: number; misses: number } | undefined;
}

export function buildStats(input: StatsInput): AnalysisStats {
  const nodesByKind: Partial<Record<NodeKind, number>> = {};
  for (const node of input.nodes) nodesByKind[node.kind] = (nodesByKind[node.kind] ?? 0) + 1;

  const edgesByKind: Partial<Record<EdgeKind, number>> = {};
  const edgesByConfidence: Record<Confidence, number> = { exact: 0, inferred: 0, "name-match": 0 };
  for (const edge of input.edges) {
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
    edgesByConfidence[edge.confidence]++;
  }

  const stats: AnalysisStats = {
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    commitSha: input.commitSha,
    languages: input.languages,
    nodesByKind,
    edgesByKind,
    edgesByConfidence,
    references: input.references,
    skippedFiles: input.skippedFiles,
    parseErrorFiles: input.parseErrorFiles,
    droppedInvalidEdges: input.droppedInvalidEdges,
    pluginErrors: input.pluginErrors,
    timingsMs: input.timingsMs,
  };
  if (input.truncated) stats.truncated = true;
  if (input.cache) stats.cache = input.cache;
  return stats;
}
