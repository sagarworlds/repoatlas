import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import type { AnalysisRecordDto } from "../api/types.ts";

/** Shows the current router location so tests can assert navigation. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

/** Renders `ui` at `path` (a route pattern) inside a router and a fresh query client. */
export function renderApp(ui: ReactElement, options: { route?: string; path?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? "/"]}>
        <Routes>
          <Route path={options.path ?? "*"} element={ui} />
          <Route path="*" element={<div data-testid="other-route" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

export function makeAnalysis(overrides: Partial<AnalysisRecordDto> = {}): AnalysisRecordDto {
  return {
    id: "an_1",
    owner: "acme",
    repo: "widgets",
    ref: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    status: "done",
    progress: null,
    stats: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:10.000Z",
    ...overrides,
  };
}

export interface FakeResponse {
  status: number;
  body: unknown;
}

/**
 * Replaces global fetch. `handler` receives the URL and init and returns a status + JSON
 * body. Returns the mock so tests can inspect calls. (Like a hand-written HttpMessageHandler.)
 */
export function mockFetch(handler: (url: string, init?: RequestInit) => FakeResponse) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
