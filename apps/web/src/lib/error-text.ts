import { ApiError } from "../api/client.ts";

export interface ErrorText {
  title: string;
  message: string;
}

const TITLES: Record<string, string> = {
  INVALID_REPO_URL: "That does not look like a GitHub repository",
  REPO_NOT_FOUND: "Repository not found",
  REPO_PRIVATE: "This repository is private",
  REPO_TOO_LARGE: "This repository is too large",
  NO_SUPPORTED_LANGUAGES: "No supported languages found",
  RATE_LIMITED: "Too many requests",
  TIMEOUT: "GitHub took too long to answer",
  NETWORK_ERROR: "Cannot reach the server",
  ANALYSIS_NOT_FOUND: "Analysis not found",
  VALIDATION_ERROR: "The request was not valid",
};

/** Turns any thrown value into a title and a message that is safe to show. */
export function describeError(err: unknown): ErrorText {
  if (err instanceof ApiError) {
    // The server's message is authoritative (and already written for end users).
    return { title: TITLES[err.code] ?? "Something went wrong", message: err.message };
  }
  return { title: "Something went wrong", message: "An unexpected error occurred." };
}
