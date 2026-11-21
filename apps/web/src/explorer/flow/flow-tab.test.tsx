import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.ts";
import type { CallflowResponse, GraphEdge, GraphNode } from "../../api/types.ts";
import { makeAnalysis, renderApp } from "../../test/utils.tsx";
import { FlowTab } from "./flow-tab.tsx";

// Hooks are replaced by plain stubs so no network is involved. `vi.hoisted` makes the stubs
// available inside the (hoisted) vi.mock factory.
const mocks = vi.hoisted(() => ({
  useCallflow: vi.fn(),
  useNodeDetail: vi.fn(),
  canvasProps: { current: undefined as undefined | Record<string, (id: string) => void> },
}));
vi.mock("../../api/hooks.ts", () => ({
  useCallflow: mocks.useCallflow,
  useNodeDetail: mocks.useNodeDetail,
}));
// Cytoscape needs a canvas, which jsdom lacks: replace the canvas with a stub that
// exposes its callbacks as buttons.
vi.mock("./flow-canvas.tsx", () => ({
  FlowCanvas: (props: { onNodeClick: (id: string) => void; onEdgeClick: (id: string) => void }) => {
    mocks.canvasProps.current = props;
    return <div data-testid="flow-canvas" />;
  },
}));

const fn = (name: string, file: string): GraphNode => ({
  id: `sym:${file}#${name}`,
  kind: "function",
  name,
  file,
});
const main = fn("main", "src/main.ts");
const helper = fn("helper", "src/util.ts");
const caller = fn("start", "src/start.ts");
const call = (src: GraphNode, dst: GraphNode, line: number): GraphEdge => ({
  src: src.id,
  dst: dst.id,
  kind: "calls",
  confidence: "exact",
  line,
});

const data: CallflowResponse = {
  focus: main.id,
  nodes: [main, helper, caller],
  edges: [call(caller, main, 3), call(main, helper, 9)],
};

function query(partial: Record<string, unknown>) {
  return { isPending: false, isError: false, isFetching: false, refetch: vi.fn(), ...partial };
}

const render = (search = "") =>
  renderApp(<FlowTab analysisId="an_1" analysis={makeAnalysis()} />, {
    route: `/a/an_1?tab=flow${search}`,
    path: "/a/:analysisId",
  });

const location = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  mocks.useCallflow.mockReset();
  mocks.useNodeDetail.mockReset();
  mocks.useNodeDetail.mockReturnValue(query({ data: undefined }));
  mocks.useCallflow.mockReturnValue(query({ isPending: true, data: undefined }));
});

describe("FlowTab", () => {
  it("prompts to pick a function when no node is selected", () => {
    render();
    expect(screen.getByTestId("flow-prompt")).toHaveTextContent(/search box/i);
  });

  it("shows a loading state", () => {
    render(`&node=${encodeURIComponent(main.id)}`);
    expect(screen.getByTestId("flow-loading")).toBeInTheDocument();
  });

  it("shows an error with a retry button", async () => {
    const refetch = vi.fn();
    mocks.useCallflow.mockReturnValue(
      query({ isError: true, error: new ApiError("INTERNAL", "boom", 500), refetch }),
    );
    render(`&node=${encodeURIComponent(main.id)}`);
    expect(screen.getByTestId("flow-error")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("explains that the analysis is not ready", () => {
    mocks.useCallflow.mockReturnValue(
      query({ isError: true, error: new ApiError("ANALYSIS_NOT_READY", "not ready", 409) }),
    );
    render(`&node=${encodeURIComponent(main.id)}`);
    expect(screen.getByText("The analysis is not ready yet")).toBeInTheDocument();
  });

  it("explains that a non-callable node cannot be a focus and offers its functions", async () => {
    const cls: GraphNode = { id: "sym:src/c.ts#Cls", kind: "class", name: "Cls", file: "src/c.ts" };
    mocks.useCallflow.mockReturnValue(
      query({ data: { focus: cls.id, nodes: [cls], edges: [] } satisfies CallflowResponse }),
    );
    mocks.useNodeDetail.mockReturnValue(query({ data: { children: [helper] } }));
    render(`&node=${encodeURIComponent(cls.id)}`);
    expect(screen.getByTestId("flow-not-callable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "helper" }));
    expect(location()).toContain(`node=${encodeURIComponent(helper.id)}`);
  });

  it("shows an empty state when the function has no callers or callees", () => {
    mocks.useCallflow.mockReturnValue(
      query({ data: { focus: main.id, nodes: [main], edges: [] } satisfies CallflowResponse }),
    );
    render(`&node=${encodeURIComponent(main.id)}`);
    expect(screen.getByTestId("flow-empty")).toHaveTextContent("main");
    expect(screen.queryByTestId("flow-canvas")).not.toBeInTheDocument();
  });

  it("renders the canvas, controls and text alternative for a happy result", () => {
    mocks.useCallflow.mockReturnValue(query({ data }));
    render(`&node=${encodeURIComponent(main.id)}`);
    expect(screen.getByTestId("flow-canvas")).toBeInTheDocument();
    expect(screen.getByLabelText("Callers depth")).toBeInTheDocument();
    expect(screen.getByLabelText("Callees depth")).toBeInTheDocument();
    expect(screen.getByText("List view of callers and callees")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-truncated")).not.toBeInTheDocument();
  });

  it("re-focuses on a node click and pushes history", async () => {
    mocks.useCallflow.mockReturnValue(query({ data }));
    render(`&node=${encodeURIComponent(main.id)}`);
    mocks.canvasProps.current?.onNodeClick?.(helper.id);
    // Wait for the router update.
    await screen.findByTestId("location");
    expect(await screen.findByText(new RegExp(encodeURIComponent(helper.id)))).toBeInTheDocument();
  });

  it("clicking an edge selects the caller and sets hl to the call-site line", async () => {
    mocks.useCallflow.mockReturnValue(query({ data }));
    render(`&node=${encodeURIComponent(main.id)}`);
    mocks.canvasProps.current?.onEdgeClick?.("e1"); // main -> helper at line 9
    expect(await screen.findByText(/hl=src%2Fmain\.ts%409/)).toBeInTheDocument();
    expect(location()).toContain(`node=${encodeURIComponent(main.id)}`);
  });

  it("warns when the result hit the node limit", () => {
    const many = Array.from({ length: 500 }, (_, i) => fn(`f${i}`, "src/m.ts"));
    const big: CallflowResponse = {
      focus: many[0]?.id ?? "",
      nodes: many,
      edges: [call(many[0] as GraphNode, many[1] as GraphNode, 1)],
    };
    mocks.useCallflow.mockReturnValue(query({ data: big }));
    render(`&node=${encodeURIComponent(big.focus)}`);
    expect(screen.getByTestId("flow-truncated")).toBeInTheDocument();
  });
});
