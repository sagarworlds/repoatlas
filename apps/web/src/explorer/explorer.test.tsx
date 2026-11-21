import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAnalysis, mockFetch, renderApp } from "../test/utils.tsx";
import { ExplorerPage } from "./explorer-page.tsx";
import { elapsedMs, stepState } from "./progress-view.tsx";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const render = (route = "/a/an_1") =>
  renderApp(<ExplorerPage />, { route, path: "/a/:analysisId" });

describe("stepState", () => {
  it("marks earlier phases done and the current one current", () => {
    expect(stepState("fetching", "parsing")).toBe("done");
    expect(stepState("parsing", "parsing")).toBe("current");
    expect(stepState("resolving", "parsing")).toBe("pending");
    expect(stepState("persisting", "done")).toBe("done");
    expect(stepState("fetching", "queued")).toBe("pending");
  });
});

describe("elapsedMs", () => {
  it("uses finishedAt when present", () => {
    const a = makeAnalysis({
      createdAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:05Z",
    });
    expect(elapsedMs(a, Date.parse("2026-02-01T00:00:00Z"))).toBe(5000);
  });
});

describe("ExplorerPage", () => {
  it("shows the progress view with phases and a progress bar while parsing", async () => {
    mockFetch(() => ({
      status: 200,
      body: makeAnalysis({
        status: "parsing",
        finishedAt: null,
        progress: { phase: "parsing", filesDone: 30, filesTotal: 120 },
      }),
    }));
    render();
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "30");
    expect(bar).toHaveAttribute("aria-valuemax", "120");
    expect(screen.getByText("Parsing").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Fetching").closest("li")).not.toHaveAttribute("aria-current");
    expect(screen.getByText("30 / 120 files")).toBeInTheDocument();
  });

  it("updates the stored recent status when the analysis finishes", async () => {
    window.localStorage.setItem(
      "repoatlas.recent",
      JSON.stringify([
        {
          id: "an_1",
          repo: "acme/widgets",
          ref: "main",
          date: "2026-01-01T00:00:00Z",
          status: "queued",
        },
      ]),
    );
    mockFetch(() => ({ status: 200, body: makeAnalysis() }));
    render();
    await screen.findByTestId("explorer-layout");
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem("repoatlas.recent") ?? "[]")[0].status).toBe(
        "done",
      ),
    );
  });

  it("shows the failure message and retries with the same repo and ref", async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === "POST"
        ? {
            status: 202,
            body: {
              id: "an_2",
              status: "queued",
              owner: "acme",
              repo: "widgets",
              ref: "dev",
              commitSha: "b".repeat(40),
              cached: false,
            },
          }
        : {
            status: 200,
            body: makeAnalysis({
              status: "failed",
              ref: "dev",
              error: { code: "REPO_TOO_LARGE", message: "The repository is larger than 200 MB." },
            }),
          },
    );
    render();
    expect(await screen.findByText("The repository is larger than 200 MB.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/a/an_2"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      repoUrl: "https://github.com/acme/widgets",
      ref: "dev",
    });
  });

  it("shows a not found state", async () => {
    mockFetch(() => ({
      status: 404,
      body: { error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found." } },
    }));
    render("/a/nope");
    expect(await screen.findByText("Analysis not found")).toBeInTheDocument();
  });

  it("renders the layout with every slot once the analysis is done", async () => {
    mockFetch(() => ({ status: 200, body: makeAnalysis() }));
    render();
    expect(await screen.findByTestId("explorer-layout")).toBeInTheDocument();
    for (const id of ["file-tree", "map-tab", "detail-panel", "code-panel", "search-box"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getAllByText("acme/widgets").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0123456/).length).toBeGreaterThan(0);
  });

  it("binds the tabs to the tab URL parameter", async () => {
    mockFetch(() => ({ status: 200, body: makeAnalysis() }));
    render();
    await screen.findByTestId("explorer-layout");
    await userEvent.click(screen.getByRole("tab", { name: "Call flow" }));
    expect(screen.getByRole("tab", { name: "Call flow" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("location")).toHaveTextContent("?tab=flow");
    await userEvent.click(screen.getByRole("tab", { name: "Dependencies" }));
    expect(screen.getByRole("tab", { name: "Dependencies" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(screen.getByRole("tab", { name: "Map" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/a/an_1");
    expect(screen.getByTestId("location")).not.toHaveTextContent("tab=");
  });

  it("collapses the code panel and persists the layout", async () => {
    mockFetch(() => ({ status: 200, body: makeAnalysis() }));
    render();
    await screen.findByTestId("explorer-layout");
    expect(screen.getByRole("separator", { name: "Resize code panel" })).toBeInTheDocument();
    await act(async () => {
      screen.getByRole("separator").focus();
    });
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "284");
    expect(JSON.parse(window.localStorage.getItem("repoatlas.layout") ?? "{}").codeHeight).toBe(
      284,
    );
  });
});
