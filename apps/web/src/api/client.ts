import {
  AnalysisStatsSchema,
  AnalysisStatusSchema,
  type NodeKind,
  ProgressSchema,
} from "@repoatlas/schema";
import type {
  AnalysesListResponse,
  AnalysisFailure,
  AnalysisRecordDto,
  CallflowResponse,
  DepsDirection,
  DepsResponse,
  GraphParams,
  GraphResponse,
  NodeDetailResponse,
  SearchResponse,
  SourceResponse,
  StartAnalysisRequest,
  StartAnalysisResponse,
} from "./types.ts";

export const API_BASE = "/api";

/**
 * Error thrown by every API call. `code` is the server's error code (INVALID_REPO_URL, ...)
 * or one of our own: NETWORK_ERROR (could not reach the server) and BAD_RESPONSE (the reply
 * was not the expected JSON). Like a custom exception class with extra properties in C#.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

type QueryValue = string | number | boolean | undefined | null;

/** Builds "?a=1&b=2", skipping undefined/null values. Returns "" when nothing is left. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

// ---------------------------------------------------------------------------
// Runtime validation helpers (a proxy error page, for example, is not our JSON).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badResponse(what: string): ApiError {
  return new ApiError("BAD_RESPONSE", `Unexpected response from the server (${what}).`, 502);
}

/** Reads the `{ error: { code, message } }` shape; returns undefined for anything else. */
export function parseErrorBody(data: unknown): { code: string; message: string } | undefined {
  if (!isRecord(data) || !isRecord(data.error)) return undefined;
  const { code, message } = data.error;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return { code, message };
}

function parseFailure(value: unknown): AnalysisFailure | null {
  return parseErrorBodyInner(value) ?? null;
}

function parseErrorBodyInner(value: unknown): AnalysisFailure | undefined {
  if (!isRecord(value)) return undefined;
  const { code, message } = value;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return { code, message };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Validates one analysis record. Throws BAD_RESPONSE when the essentials are wrong. */
export function parseAnalysisRecord(data: unknown): AnalysisRecordDto {
  if (!isRecord(data)) throw badResponse("analysis");
  const status = AnalysisStatusSchema.safeParse(data.status);
  if (
    typeof data.id !== "string" ||
    typeof data.owner !== "string" ||
    typeof data.repo !== "string" ||
    typeof data.ref !== "string" ||
    typeof data.createdAt !== "string" ||
    !status.success
  ) {
    throw badResponse("analysis");
  }
  const progress = ProgressSchema.safeParse(data.progress);
  // Stats are informational (language chips, banner): drop them if they do not validate.
  const stats = AnalysisStatsSchema.safeParse(data.stats);
  return {
    id: data.id,
    owner: data.owner,
    repo: data.repo,
    ref: data.ref,
    commitSha: stringOrNull(data.commitSha),
    status: status.data,
    progress: progress.success ? progress.data : null,
    stats: stats.success ? stats.data : null,
    error: parseFailure(data.error),
    createdAt: data.createdAt,
    finishedAt: stringOrNull(data.finishedAt),
  };
}

function parseAnalysisList(data: unknown): AnalysesListResponse {
  if (!isRecord(data) || !Array.isArray(data.analyses)) throw badResponse("analyses list");
  const analyses: AnalysisRecordDto[] = [];
  for (const item of data.analyses) {
    try {
      analyses.push(parseAnalysisRecord(item));
    } catch {
      // skip one malformed row instead of failing the whole list
    }
  }
  return { analyses };
}

export function parseStartResponse(data: unknown): StartAnalysisResponse {
  if (!isRecord(data)) throw badResponse("start");
  const status = AnalysisStatusSchema.safeParse(data.status);
  if (
    typeof data.id !== "string" ||
    typeof data.owner !== "string" ||
    typeof data.repo !== "string" ||
    typeof data.ref !== "string" ||
    typeof data.cached !== "boolean" ||
    !status.success
  ) {
    throw badResponse("start");
  }
  return {
    id: data.id,
    owner: data.owner,
    repo: data.repo,
    ref: data.ref,
    status: status.data,
    commitSha: stringOrNull(data.commitSha),
    cached: data.cached,
  };
}

/** Checks the outer shape only (the server already validated the payload with zod). */
function requireArrays<T>(data: unknown, keys: string[], what: string): T {
  if (!isRecord(data)) throw badResponse(what);
  for (const key of keys) {
    if (!Array.isArray(data[key])) throw badResponse(what);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

interface RequestOptions<T> {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal | undefined;
  parse: (data: unknown) => T;
}

export async function apiRequest<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const url = `${API_BASE}${path}${options.query ? buildQuery(options.query) : ""}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    // Let aborts through unchanged so TanStack Query can recognise cancellation.
    if (options.signal?.aborted) throw err;
    throw new ApiError("NETWORK_ERROR", "Could not reach the server. Check your connection.", 0);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }

  if (!response.ok) {
    const parsed = parseErrorBody(data);
    if (parsed) throw new ApiError(parsed.code, parsed.message, response.status);
    throw new ApiError(
      "BAD_RESPONSE",
      `The server answered with HTTP ${response.status}.`,
      response.status,
    );
  }
  return options.parse(data);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export function createAnalysis(
  request: StartAnalysisRequest,
  signal?: AbortSignal,
): Promise<StartAnalysisResponse> {
  const body: StartAnalysisRequest = { repoUrl: request.repoUrl };
  if (request.ref) body.ref = request.ref;
  return apiRequest("/analyses", { method: "POST", body, parse: parseStartResponse, signal });
}

export function fetchAnalysis(id: string, signal?: AbortSignal): Promise<AnalysisRecordDto> {
  return apiRequest(`/analyses/${enc(id)}`, { parse: parseAnalysisRecord, signal });
}

export function fetchAnalyses(limit: number, signal?: AbortSignal): Promise<AnalysesListResponse> {
  return apiRequest("/analyses", { query: { limit }, parse: parseAnalysisList, signal });
}

export function fetchGraph(
  id: string,
  params: GraphParams,
  signal?: AbortSignal,
): Promise<GraphResponse> {
  return apiRequest(`/analyses/${enc(id)}/graph`, {
    query: {
      level: params.level,
      root: params.root,
      depth: params.depth,
      edgeKinds: params.edgeKinds.join(","),
      includeTests: params.includeTests,
      includeExternal: params.includeExternal,
      minConfidence: params.minConfidence,
    },
    parse: (data) => requireArrays<GraphResponse>(data, ["nodes", "edges"], "graph"),
    signal,
  });
}

export function fetchNodeDetail(
  id: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<NodeDetailResponse> {
  return apiRequest(`/analyses/${enc(id)}/node`, {
    query: { nodeId },
    parse: (data) => {
      const detail = requireArrays<NodeDetailResponse>(data, ["parents", "children"], "node");
      if (!isRecord(detail.node)) throw badResponse("node");
      return detail;
    },
    signal,
  });
}

export function fetchCallflow(
  id: string,
  nodeId: string,
  depthUp: number,
  depthDown: number,
  signal?: AbortSignal,
): Promise<CallflowResponse> {
  return apiRequest(`/analyses/${enc(id)}/callflow`, {
    query: { nodeId, depthUp, depthDown },
    parse: (data) => requireArrays<CallflowResponse>(data, ["nodes", "edges"], "callflow"),
    signal,
  });
}

export function fetchDeps(
  id: string,
  file: string,
  direction: DepsDirection,
  depth: number,
  signal?: AbortSignal,
): Promise<DepsResponse> {
  return apiRequest(`/analyses/${enc(id)}/deps`, {
    query: { file, direction, depth },
    parse: (data) => requireArrays<DepsResponse>(data, ["nodes", "edges"], "deps"),
    signal,
  });
}

export function fetchSearch(
  id: string,
  q: string,
  kinds: readonly NodeKind[] | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return apiRequest(`/analyses/${enc(id)}/search`, {
    query: { q, kinds: kinds && kinds.length > 0 ? kinds.join(",") : undefined, limit },
    parse: (data) => requireArrays<SearchResponse>(data, ["results"], "search"),
    signal,
  });
}

export function fetchSource(
  id: string,
  file: string,
  start: number | undefined,
  end: number | undefined,
  signal?: AbortSignal,
): Promise<SourceResponse> {
  return apiRequest(`/analyses/${enc(id)}/source`, {
    query: { file, start, end },
    parse: (data) => {
      if (!isRecord(data) || typeof data.content !== "string") throw badResponse("source");
      if (typeof data.startLine !== "number") throw badResponse("source");
      return data as unknown as SourceResponse;
    },
    signal,
  });
}
