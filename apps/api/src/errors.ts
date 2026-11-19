import { AnalysisError, type AnalysisErrorCode } from "@repoatlas/core";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

/** Every code the HTTP API can return (docs/API.md plus VALIDATION_ERROR and TIMEOUT). */
export type ApiErrorCode =
  | "INVALID_REPO_URL"
  | "REPO_NOT_FOUND"
  | "REPO_TOO_LARGE"
  | "REPO_PRIVATE"
  | "NO_SUPPORTED_LANGUAGES"
  | "RATE_LIMITED"
  | "ANALYSIS_NOT_FOUND"
  | "ANALYSIS_NOT_READY"
  | "NODE_NOT_FOUND"
  | "FILE_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "INTERNAL";

/** The one JSON error shape: { error: { code, message } }. */
export interface ErrorBody {
  error: { code: string; message: string };
}

/** Error that already knows its HTTP status. Thrown by routes, mapped by the error handler. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(code: ApiErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  INVALID_REPO_URL: 400,
  VALIDATION_ERROR: 400,
  REPO_PRIVATE: 403,
  REPO_NOT_FOUND: 404,
  ANALYSIS_NOT_FOUND: 404,
  NODE_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  ANALYSIS_NOT_READY: 409,
  // 422 (not 413): 413 means "request body too large", but here the request is fine and
  // the *repository* is too big to analyze.
  REPO_TOO_LARGE: 422,
  NO_SUPPORTED_LANGUAGES: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  TIMEOUT: 504,
  NOT_FOUND: 404,
};

export function apiError(code: ApiErrorCode, message: string): ApiError {
  return new ApiError(code, STATUS_BY_CODE[code], message);
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Maps a pipeline error code to an API code. CANCELLED means the server is shutting down. */
function fromAnalysisCode(code: AnalysisErrorCode): ApiErrorCode {
  switch (code) {
    case "CANCELLED":
      return "INTERNAL";
    default:
      return code;
  }
}

export interface MappedError {
  statusCode: number;
  code: string;
  message: string;
  /** True when the failure is our fault and should be logged at error level. */
  unexpected: boolean;
}

/**
 * Turns anything thrown into a safe response. Stack traces, causes and unknown messages
 * are never sent to the client (they could contain paths or the GitHub token).
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message, unexpected: false };
  }
  if (err instanceof AnalysisError) {
    const code = fromAnalysisCode(err.code);
    const message = code === "INTERNAL" ? "Internal server error." : err.message;
    return {
      statusCode: STATUS_BY_CODE[code],
      code,
      message,
      unexpected: code === "INTERNAL",
    };
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    // Only the field path and the validator's message are sent, never the submitted value.
    const details = err.validation
      .slice(0, 5)
      .map((issue) => {
        const where = issue.instancePath.replace(/^\//, "").replace(/\//g, ".");
        return where ? `${where}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Invalid request. ${details}`.trim(),
      unexpected: false,
    };
  }
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    // Fastify's own client errors (malformed JSON, unsupported media type, ...).
    return {
      statusCode: status,
      code: status === 429 ? "RATE_LIMITED" : "VALIDATION_ERROR",
      message: status === 429 ? "Too many requests." : "Invalid request.",
      unexpected: false,
    };
  }
  return { statusCode: 500, code: "INTERNAL", message: "Internal server error.", unexpected: true };
}
