import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { filterCallflowByConfidence } from "./callflow-filter.ts";
import {
  type ApiError,
  createAnalysis,
  fetchAnalyses,
  fetchAnalysis,
  fetchCallflow,
  fetchDeps,
  fetchGraph,
  fetchNodeDetail,
  fetchSearch,
  fetchSource,
} from "./client.ts";
import type {
  AnalysesListResponse,
  AnalysisRecordDto,
  CallflowResponse,
  Confidence,
  DepsDirection,
  DepsResponse,
  GraphParams,
  GraphResponse,
  NodeDetailResponse,
  NodeKind,
  SearchResponse,
  SourceResponse,
  StartAnalysisRequest,
  StartAnalysisResponse,
} from "./types.ts";

// Everything except the analysis record itself is only available once the analysis is
// `done`, and a finished analysis never changes: so those results never go stale.
const IMMUTABLE = Number.POSITIVE_INFINITY;

/** Stable query keys. Arrays are sorted so equal params always give an equal key. */
export const queryKeys = {
  analysis: (id: string) => ["analysis", id] as const,
  analyses: (limit: number) => ["analyses", limit] as const,
  graph: (id: string, p: GraphParams) =>
    ["graph", id, { ...p, edgeKinds: [...p.edgeKinds].sort() }] as const,
  node: (id: string, nodeId: string | undefined) => ["node", id, nodeId] as const,
  callflow: (id: string, nodeId: string | undefined, up: number, down: number) =>
    ["callflow", id, nodeId, up, down] as const,
  deps: (id: string, file: string | undefined, direction: DepsDirection, depth: number) =>
    ["deps", id, file, direction, depth] as const,
  search: (id: string, q: string, kinds: readonly NodeKind[] | undefined, limit: number) =>
    ["search", id, q, kinds ? [...kinds].sort() : null, limit] as const,
  source: (id: string, file: string | undefined, start?: number, end?: number) =>
    ["source", id, file, start ?? null, end ?? null] as const,
};

/** True while an analysis is still being worked on. */
export function isInProgress(status: AnalysisRecordDto["status"] | undefined): boolean {
  return status !== "done" && status !== "failed";
}

/** Polls every second until the analysis is done or failed. */
export function useAnalysis(id: string): UseQueryResult<AnalysisRecordDto, ApiError> {
  return useQuery<AnalysisRecordDto, ApiError>({
    queryKey: queryKeys.analysis(id),
    queryFn: ({ signal }) => fetchAnalysis(id, signal),
    // These options receive the query, so polling stops by itself once the status is final.
    refetchInterval: (query) => (isInProgress(query.state.data?.status) ? 1000 : false),
    staleTime: (query) => (isInProgress(query.state.data?.status) ? 0 : IMMUTABLE),
  });
}

export function useAnalyses(limit = 20): UseQueryResult<AnalysesListResponse, ApiError> {
  return useQuery<AnalysesListResponse, ApiError>({
    queryKey: queryKeys.analyses(limit),
    queryFn: ({ signal }) => fetchAnalyses(limit, signal),
    staleTime: 10_000,
  });
}

export function useCreateAnalysis() {
  const queryClient = useQueryClient();
  return useMutation<StartAnalysisResponse, ApiError, StartAnalysisRequest>({
    mutationFn: (request) => createAnalysis(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["analyses"] });
    },
  });
}

/** Keeps showing the previous graph while new params load (no flicker). */
export function useGraph(
  id: string,
  params: GraphParams,
  enabled = true,
): UseQueryResult<GraphResponse, ApiError> {
  return useQuery<GraphResponse, ApiError>({
    queryKey: queryKeys.graph(id, params),
    queryFn: ({ signal }) => fetchGraph(id, params, signal),
    staleTime: IMMUTABLE,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useNodeDetail(
  id: string,
  nodeId: string | undefined,
): UseQueryResult<NodeDetailResponse, ApiError> {
  return useQuery<NodeDetailResponse, ApiError>({
    queryKey: queryKeys.node(id, nodeId),
    queryFn: ({ signal }) => fetchNodeDetail(id, nodeId ?? "", signal),
    staleTime: IMMUTABLE,
    enabled: nodeId !== undefined && nodeId !== "",
  });
}

/**
 * Callers and callees of a function. `minConfidence` is applied on the client (the endpoint
 * has no such parameter), so it is not part of the network request, only of the result.
 */
export function useCallflow(
  id: string,
  nodeId: string | undefined,
  depthUp: number,
  depthDown: number,
  minConfidence: Confidence = "name-match",
): UseQueryResult<CallflowResponse, ApiError> {
  return useQuery<CallflowResponse, ApiError>({
    queryKey: queryKeys.callflow(id, nodeId, depthUp, depthDown),
    queryFn: ({ signal }) => fetchCallflow(id, nodeId ?? "", depthUp, depthDown, signal),
    // `select` transforms the cached data per observer, so changing the confidence never
    // refetches. (Like a LINQ Select over the cached result.)
    select: (data) => filterCallflowByConfidence(data, minConfidence),
    staleTime: IMMUTABLE,
    placeholderData: keepPreviousData,
    enabled: nodeId !== undefined && nodeId !== "",
  });
}

export function useDeps(
  id: string,
  file: string | undefined,
  direction: DepsDirection,
  depth: number,
): UseQueryResult<DepsResponse, ApiError> {
  return useQuery<DepsResponse, ApiError>({
    queryKey: queryKeys.deps(id, file, direction, depth),
    queryFn: ({ signal }) => fetchDeps(id, file ?? "", direction, depth, signal),
    staleTime: IMMUTABLE,
    placeholderData: keepPreviousData,
    enabled: file !== undefined && file !== "",
  });
}

/** The caller should debounce `q`; an empty query disables the request. */
export function useSearch(
  id: string,
  q: string,
  kinds?: readonly NodeKind[],
  limit = 20,
): UseQueryResult<SearchResponse, ApiError> {
  const trimmed = q.trim();
  return useQuery<SearchResponse, ApiError>({
    queryKey: queryKeys.search(id, trimmed, kinds, limit),
    queryFn: ({ signal }) => fetchSearch(id, trimmed, kinds, limit, signal),
    staleTime: IMMUTABLE,
    placeholderData: keepPreviousData,
    enabled: trimmed !== "",
  });
}

export function useSource(
  id: string,
  file: string | undefined,
  start?: number,
  end?: number,
): UseQueryResult<SourceResponse, ApiError> {
  return useQuery<SourceResponse, ApiError>({
    queryKey: queryKeys.source(id, file, start, end),
    queryFn: ({ signal }) => fetchSource(id, file ?? "", start, end, signal),
    staleTime: IMMUTABLE,
    enabled: file !== undefined && file !== "",
  });
}
