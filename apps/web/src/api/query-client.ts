import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client.ts";

/** Client errors (4xx) will not get better by retrying; network/5xx errors get two retries. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, refetchOnWindowFocus: false },
    },
  });
}
