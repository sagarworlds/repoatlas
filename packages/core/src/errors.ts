/** Error codes shared with the HTTP API (docs/API.md). */
export type AnalysisErrorCode =
  | "INVALID_REPO_URL"
  | "REPO_NOT_FOUND"
  | "REPO_TOO_LARGE"
  | "REPO_PRIVATE"
  | "NO_SUPPORTED_LANGUAGES"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INTERNAL";

/** Typed pipeline error. The API maps `code` to an HTTP status. */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;

  constructor(code: AnalysisErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnalysisError";
    this.code = code;
  }
}
