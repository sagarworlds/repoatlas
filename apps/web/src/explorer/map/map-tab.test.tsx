import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphResponse } from "../../api/types.ts";
import { makeAnalysis, mockFetch, renderApp } from "../../test/utils.tsx";
import type { MapCanvas, MapCanvasHandlers } from "./cy-adapter.ts";
import { MapTab } from "./map-tab.tsx";
import { MapToolbar, type MapToolbarProps } from "./map-toolbar.tsx";

// The fake replaces the real adapter, so no canvas and no Cytoscape are needed in jsdom.
const fake = vi.hoisted(() => ({
  canvases: [] as unknown[],
  handlers: undefined as unknown,
  fail: false,
}));

vi.mock("./cy-adapter.ts", () => ({
  createMapCanvas: vi.fn(async (_el: HTMLElement, handlers: unknown) => {
    if (fake.fail) throw new Error("chunk failed");
    fake.handlers = handlers;
    const canvas = {
      setGraph: vi.fn(),
      selectNode: vi.fn(() => true),
      setHighlighted: vi.fn(),
      setTheme: vi.fn(),
      fit: vi.fn(),
      resize: vi.fn(),
      exportPng: vi.fn(() => new Blob(["png"], { type: "image/png" })),
      destroy: vi.fn(),
    };
    fake.canvases.push(canvas);
    return canvas;
  }),
}));

function canvases(): { [K in keyof MapCanvas]: ReturnType<typeof vi.fn> }[] {
  return fake.canvases as { [K in keyof MapCanvas]: ReturnType<typeof vi.fn> }[];
}
function handlers(): MapCanvasHandlers {
  return fake.handlers as MapCanvasHandlers;
}

const GRAPH: GraphResponse = {
  nodes: [
    { id: "dir:src", kind: "directory", name: "src", parentId: "dir:" },
    { id: "dir:docs", kind: "directory", name: "docs", parentId: "dir:" },
    { id: "dir:", kind: "directory", name: "" },
  ],
  edges: [{ src: "dir:src", dst: "dir:docs", kind: "imports", confidence: "exact", weight: 2 }],
  truncated: false,
};

beforeEach(() => {
  fake.canvases = [];
  fake.handlers = undefined;
  fake.fail = false;
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

function renderMap(route = "/a/an_1") {
  return renderApp(<MapTab analysisId="an_1" analysis={makeAnalysis()} />, {
    route,
    path: "/a/:analysisId",
  });
}

function graphRequests(fetchMock: ReturnType<typeof mockFetch>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/graph"));
}

describe("MapTab", () => {
  it("shows loading, then draws the graph and the counts", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap();
    expect(screen.getByText(/loading map/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/3 nodes/)).toBeInTheDocument());
    expect(screen.getByText(/1 edges/)).toBeInTheDocument();
    await waitFor(() => expect(canvases()[0]?.setGraph).toHaveBeenCalled());
    const call = canvases()[0]?.setGraph.mock.calls[0] as unknown[];
    expect((call[0] as { nodes: unknown[] }).nodes).toHaveLength(3);
    expect(call[1]).toMatchObject({ fresh: true });
    expect(screen.getByRole("img", { name: /3 nodes and 1 edges/ })).toBeInTheDocument();
  });

  it("requests level=dir, root=dir: and depth=2 by default", async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap();
    await waitFor(() => expect(graphRequests(fetchMock)).toHaveLength(1));
    const url = graphRequests(fetchMock)[0] ?? "";
    expect(url).toContain("level=dir");
    expect(url).toContain("depth=2");
    expect(decodeURIComponent(url)).toContain("root=dir:");
  });

  it("shows the empty state", async () => {
    mockFetch(() => ({ status: 200, body: { nodes: [], edges: [], truncated: false } }));
    renderMap();
    expect(await screen.findByText(/no files of a supported language/i)).toBeInTheDocument();
  });

  it("shows an error with a working retry", async () => {
    let failing = true;
    mockFetch(() =>
      failing
        ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
        : { status: 200, body: GRAPH },
    );
    renderMap();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: /try again/i })).toBeInTheDocument();
    failing = false;
    await userEvent.click(within(alert).getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText(/3 nodes/)).toBeInTheDocument());
  });

  it("shows a notice when the canvas library fails to load", async () => {
    fake.fail = true;
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap();
    expect(await screen.findByText(/could not be drawn/i)).toBeInTheDocument();
  });

  it("shows the truncated notice", async () => {
    mockFetch(() => ({ status: 200, body: { ...GRAPH, truncated: true } }));
    renderMap();
    expect(await screen.findByTestId("map-truncated")).toHaveTextContent(/truncated/i);
  });

  it("selecting on the canvas writes ?node and pushes history; background clears it", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap();
    await waitFor(() => expect(canvases()[0]).toBeDefined());
    handlers().onSelect("dir:src");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("node=dir%3Asrc"));
    handlers().onSelect(undefined);
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("node="));
  });

  it("reflects a selection from the URL in the canvas and centers it", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap("/a/an_1?node=dir%3Adocs");
    await waitFor(() => expect(canvases()[0]?.selectNode).toHaveBeenCalled());
    const calls = canvases()[0]?.selectNode.mock.calls as unknown[][];
    expect(calls.some((c) => c[0] === "dir:docs" && c[1] === true)).toBe(true);
  });

  it("does not re-center a node that was selected by clicking the canvas", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap();
    await waitFor(() => expect(canvases()[0]).toBeDefined());
    handlers().onSelect("dir:src");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("node="));
    const calls = canvases()[0]?.selectNode.mock.calls as unknown[][];
    expect(calls.filter((c) => c[0] === "dir:src").every((c) => c[1] === false)).toBe(true);
  });

  it("Focus makes the selected directory the root (URL root param)", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap("/a/an_1?node=dir%3Asrc");
    await userEvent.click(await screen.findByRole("button", { name: "Focus" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("root=dir%3Asrc"));
    expect(screen.getByRole("navigation", { name: /map root/i })).toBeInTheDocument();
  });

  it("the breadcrumb goes back up to the repository root", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap("/a/an_1?root=dir%3Asrc%2Fa");
    const nav = screen.getByRole("navigation", { name: /map root/i });
    await userEvent.click(within(nav).getByRole("button", { name: "acme/widgets" }));
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("root="));
  });

  it("expands a directory by fetching its subgraph and merging without duplicates", async () => {
    const sub: GraphResponse = {
      nodes: [
        { id: "dir:src", kind: "directory", name: "src", parentId: "dir:" },
        { id: "dir:src/a", kind: "directory", name: "a", parentId: "dir:src" },
      ],
      edges: [],
      truncated: false,
    };
    const fetchMock = mockFetch((url) => ({
      status: 200,
      body: decodeURIComponent(url).includes("root=dir:src") ? sub : GRAPH,
    }));
    renderMap();
    await waitFor(() => expect(canvases()[0]?.setGraph).toHaveBeenCalled());
    handlers().onExpand("dir:src");
    await waitFor(() => expect(graphRequests(fetchMock)).toHaveLength(2));
    await waitFor(() => expect(screen.getByText(/4 nodes/)).toBeInTheDocument());
    const calls = canvases()[0]?.setGraph.mock.calls as unknown[][];
    const last = calls[calls.length - 1] ?? [];
    expect(last[1]).toMatchObject({ fresh: false });
    const ids = (last[0] as { nodes: { id: string; parent?: string }[] }).nodes;
    expect(new Set(ids.map((n) => n.id)).size).toBe(4);
    expect(ids.find((n) => n.id === "dir:src/a")?.parent).toBe("dir:src");
  });

  it("the node list is collapsed by default and selects with the keyboard", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap();
    await screen.findByText(/3 nodes/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "List of nodes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    const table = screen.getByRole("table");
    const button = within(table).getByRole("button", { name: "src" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("node=dir%3Asrc"));
  });

  it("Fit and Export PNG use the canvas; the object URL is revoked", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    const create = vi.fn(() => "blob:fake");
    const revoke = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    renderMap();
    await screen.findByText(/3 nodes/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Fit" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(canvases()[0]?.fit).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Export PNG" }));
    expect(canvases()[0]?.exportPng).toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:fake"));
  });

  it("highlight most connected marks the top nodes on the canvas", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    renderMap();
    await screen.findByText(/3 nodes/);
    await userEvent.click(screen.getByRole("button", { name: /highlight most connected/i }));
    await waitFor(() => {
      const calls = canvases()[0]?.setHighlighted.mock.calls as unknown[][];
      const last = calls[calls.length - 1];
      expect(((last?.[0] ?? []) as string[]).length).toBeGreaterThan(0);
    });
  });

  it("destroys the canvas on unmount and leaves no live instance behind", async () => {
    mockFetch(() => ({ status: 200, body: GRAPH }));
    const { unmount } = renderMap();
    await waitFor(() => expect(canvases()[0]).toBeDefined());
    unmount();
    for (const c of canvases()) expect(c.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("MapToolbar", () => {
  function setup(overrides: Partial<MapToolbarProps> = {}) {
    const props: MapToolbarProps = {
      values: {
        level: "dir",
        kinds: ["imports", "calls"],
        conf: "name-match",
        tests: false,
        ext: false,
        depth: 2,
      },
      onChange: vi.fn(),
      highlightTop: false,
      onToggleHighlightTop: vi.fn(),
      onFit: vi.fn(),
      onExportPng: vi.fn(),
      listOpen: false,
      onToggleList: vi.fn(),
      canvasReady: true,
      ...overrides,
    };
    renderApp(<MapToolbar {...props} />);
    return props;
  }

  it("changes the level and exposes pressed state", async () => {
    const props = setup();
    expect(screen.getByRole("button", { name: "Folders" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Symbols" }));
    expect(props.onChange).toHaveBeenCalledWith({ level: "symbol" });
  });

  it("toggles edge kinds but keeps at least one", async () => {
    const props = setup({
      values: {
        level: "symbol",
        kinds: ["calls"],
        conf: "name-match",
        tests: false,
        ext: false,
        depth: 2,
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "calls" }));
    expect(props.onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "extends" }));
    expect(props.onChange).toHaveBeenCalledWith({ kinds: ["calls", "extends"] });
  });

  it("disables symbol-only edge kinds at folder level and external at folder level", () => {
    setup();
    expect(screen.getByRole("button", { name: "extends" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /include external/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "imports" })).toBeEnabled();
  });

  it("changes confidence, tests and depth", async () => {
    const props = setup();
    await userEvent.selectOptions(screen.getByLabelText("Confidence"), "exact");
    expect(props.onChange).toHaveBeenCalledWith({ conf: "exact" });
    await userEvent.click(screen.getByRole("checkbox", { name: /include tests/i }));
    expect(props.onChange).toHaveBeenCalledWith({ tests: true });
    await userEvent.selectOptions(screen.getByLabelText("Depth"), "4");
    expect(props.onChange).toHaveBeenCalledWith({ depth: 4 });
  });

  it("disables fit and export without a canvas and is reachable by keyboard", async () => {
    setup({ canvasReady: false });
    expect(screen.getByRole("button", { name: "Fit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeDisabled();
    expect(screen.getByRole("toolbar", { name: /map controls/i })).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Folders" })).toHaveFocus();
  });
});
