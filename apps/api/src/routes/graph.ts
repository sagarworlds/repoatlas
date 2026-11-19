import { CONFIDENCES, EDGE_KINDS, NODE_KINDS } from "@repoatlas/schema";
import { z } from "zod";
import type { RouteContext, ZodApp } from "../context.ts";
import { apiError } from "../errors.ts";
import {
  AnalysisIdParams,
  clampedInt,
  csvOf,
  hasNoControlChars,
  idParam,
  queryFlag,
  requireDoneAnalysis,
} from "./helpers.ts";

/** Hard response caps (docs/API.md). */
export const MAX_GRAPH_NODES = 2000;
export const MAX_GRAPH_EDGES = 6000;

const GraphQuery = z.object({
  level: z.enum(["dir", "file", "symbol"]).default("dir"),
  root: idParam.default("dir:"),
  depth: z.coerce.number().int().min(1).max(5).default(2),
  edgeKinds: csvOf(EDGE_KINDS)
    .optional()
    .transform((v) => v ?? (["imports", "calls"] as const).slice()),
  includeTests: queryFlag,
  includeExternal: queryFlag,
  minConfidence: z.enum(CONFIDENCES).default("name-match"),
});

const NodeQuery = z.object({ nodeId: idParam });

const CallflowQuery = z.object({
  nodeId: idParam,
  depthUp: clampedInt(0, 4, 1),
  depthDown: clampedInt(0, 4, 2),
});

const DepsQuery = z.object({
  file: idParam,
  direction: z.enum(["imports", "importedBy", "both"]).default("both"),
  depth: clampedInt(1, 3, 1),
});

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200).refine(hasNoControlChars, {
    message: "Control characters are not allowed.",
  }),
  kinds: csvOf(NODE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function registerGraphRoutes(app: ZodApp, ctx: RouteContext): void {
  const { store } = ctx;

  app.get(
    "/api/analyses/:id/graph",
    { schema: { params: AnalysisIdParams, querystring: GraphQuery } },
    async (request) => {
      const analysis = requireDoneAnalysis(store, request.params.id);
      return store.getSubgraph(analysis.id, {
        ...request.query,
        maxNodes: MAX_GRAPH_NODES,
        maxEdges: MAX_GRAPH_EDGES,
      });
    },
  );

  app.get(
    "/api/analyses/:id/node",
    { schema: { params: AnalysisIdParams, querystring: NodeQuery } },
    async (request) => {
      const analysis = requireDoneAnalysis(store, request.params.id);
      const detail = store.getNodeDetail(analysis.id, request.query.nodeId);
      if (!detail) throw apiError("NODE_NOT_FOUND", "Node not found.");
      return detail;
    },
  );

  app.get(
    "/api/analyses/:id/callflow",
    { schema: { params: AnalysisIdParams, querystring: CallflowQuery } },
    async (request) => {
      const analysis = requireDoneAnalysis(store, request.params.id);
      const { nodeId, depthUp, depthDown } = request.query;
      const flow = store.getCallflow(analysis.id, nodeId, depthUp, depthDown);
      if (!flow) throw apiError("NODE_NOT_FOUND", "Node not found.");
      return flow;
    },
  );

  app.get(
    "/api/analyses/:id/deps",
    { schema: { params: AnalysisIdParams, querystring: DepsQuery } },
    async (request) => {
      const analysis = requireDoneAnalysis(store, request.params.id);
      const { file, direction, depth } = request.query;
      const deps = store.getDeps(analysis.id, file, direction, depth);
      if (!deps) throw apiError("FILE_NOT_FOUND", "File not found in this analysis.");
      return deps;
    },
  );

  app.get(
    "/api/analyses/:id/search",
    { schema: { params: AnalysisIdParams, querystring: SearchQuery } },
    async (request) => {
      const analysis = requireDoneAnalysis(store, request.params.id);
      const { q, kinds, limit } = request.query;
      const results = store.search(analysis.id, kinds ? { q, kinds, limit } : { q, limit });
      return { results };
    },
  );
}
