import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.ts";
import type { DepsResponse, GraphEdge, GraphNode } from "../../api/types.ts";
import { makeAnalysis, renderApp } from "../../test/utils.tsx";
import { DepsTab } from "./deps-tab.tsx";

const mocks = vi.hoisted(() => ({ useDeps: vi.fn() }));
vi.mock("../../api/hooks.ts", () => ({ useDeps: mocks.useDeps }));

const file = (path: string): GraphNode => ({
  id: `file:${path}`,
  kind: "file",
  name: path.split("/").pop() ?? path,
  file: path,
});
const imp = (src: GraphNode, dst: GraphNode, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  src: src.id,
  dst: dst.id,
  kind: "imports",
  confidence: "exact",
  ...extra,
});
const a = file("src/a.ts");
const b = file("src/b.ts");
const c = file("src/c.ts");
const react: GraphNode = { id: "ext:npm:react", kind: "external", name: "react" };

const data: DepsResponse = {
  nodes: [a, b, c, react],
  edges: [
    imp(b, a),
    imp(a, c, { confidence: "name-match", meta: { importedNames: ["helper"] } }),
    imp(a, react, { meta: { alias: "R" } }),
  ],
};

function query(partial: Record<string, unknown>) {
  return { isPending: false, isError: false, isFetching: false, refetch: vi.fn(), ...partial };
}
const render = (search = "") =>
  renderApp(<DepsTab analysisId="an_1" analysis={makeAnalysis()} />, {
    route: `/a/an_1?tab=deps${search}`,
    path: "/a/:analysisId",
  });

beforeEach(() => {
  mocks.useDeps.mockReset();
  mocks.useDeps.mockReturnValue(query({ isPending: true, data: undefined }));
});

describe("DepsTab", () => {
  it("prompts for a file when neither file nor node is set", () => {
    render();
    expect(screen.getByTestId("deps-prompt")).toBeInTheDocument();
    expect(mocks.useDeps).toHaveBeenCalledWith("an_1", undefined, "both", 1);
  });

  it("derives the file from a selected symbol", () => {
    render(`&node=${encodeURIComponent("sym:src/a.ts#run")}`);
    expect(mocks.useDeps).toHaveBeenCalledWith("an_1", "src/a.ts", "both", 1);
    expect(screen.getByTestId("deps-loading")).toBeInTheDocument();
  });

  it("shows an error with retry, and a not-ready message", async () => {
    const refetch = vi.fn();
    mocks.useDeps.mockReturnValue(
      query({ isError: true, error: new ApiError("INTERNAL", "boom", 500), refetch }),
    );
    render("&file=src/a.ts");
    expect(screen.getByTestId("deps-error")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("explains that the analysis is not ready", () => {
    mocks.useDeps.mockReturnValue(
      query({ isError: true, error: new ApiError("ANALYSIS_NOT_READY", "no", 409) }),
    );
    render("&file=src/a.ts");
    expect(screen.getByText("The analysis is not ready yet")).toBeInTheDocument();
  });

  it("shows an empty message for a file without import links", () => {
    mocks.useDeps.mockReturnValue(query({ data: { nodes: [a], edges: [] } }));
    render("&file=src/a.ts");
    expect(screen.getByTestId("deps-empty")).toBeInTheDocument();
  });

  it("renders three columns, edge meta as text and the externals group", () => {
    mocks.useDeps.mockReturnValue(query({ data }));
    render("&file=src/a.ts");
    const importedBy = screen.getByRole("region", { name: "Files that import this file" });
    expect(within(importedBy).getByText("b.ts")).toBeInTheDocument();
    const imports = screen.getByRole("region", { name: "Files that this file imports" });
    expect(within(imports).getByText("c.ts")).toBeInTheDocument();
    expect(within(imports).getByText("name-match")).toBeInTheDocument();
    expect(within(imports).getByText(/imports helper/)).toBeInTheDocument();
    const externals = screen.getByTestId("deps-externals");
    expect(within(externals).getByText("npm")).toBeInTheDocument();
    expect(within(externals).getByText("react")).toBeInTheDocument();
    expect(within(externals).getByText(/as R/)).toBeInTheDocument();
    expect(screen.getByTestId("deps-center")).toHaveTextContent("a.ts");
  });

  it("makes a clicked file the new centre and pushes history", async () => {
    mocks.useDeps.mockReturnValue(query({ data }));
    render("&file=src/a.ts");
    await userEvent.click(screen.getByRole("button", { name: "Show dependencies of src/b.ts" }));
    const loc = screen.getByTestId("location").textContent ?? "";
    expect(loc).toContain("file=src%2Fb.ts");
  });

  it("changes depth through the control", async () => {
    mocks.useDeps.mockReturnValue(query({ data }));
    render("&file=src/a.ts");
    await userEvent.selectOptions(screen.getByLabelText("Depth"), "2");
    expect(screen.getByTestId("location").textContent).toContain("depth=2");
  });

  it("shows a circular import once per column and flags it", () => {
    const circular: DepsResponse = { nodes: [a, b], edges: [imp(a, b), imp(b, a)] };
    mocks.useDeps.mockReturnValue(query({ data: circular, isFetching: false }));
    render("&file=src/a.ts&depth=2");
    expect(screen.getAllByRole("button", { name: "Show dependencies of src/b.ts" })).toHaveLength(
      2,
    );
    expect(screen.getAllByText(/circular/)).toHaveLength(2);
  });
});
