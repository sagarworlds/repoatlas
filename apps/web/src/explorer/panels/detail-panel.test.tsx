import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, NodeDetailResponse } from "../../api/types.ts";
import { makeAnalysis, mockFetch, renderApp } from "../../test/utils.tsx";
import { countLinks, githubUrlForNode, lineRange, locationText } from "./detail-model.ts";
import { DetailPanel } from "./detail-panel.tsx";

const METHOD: GraphNode = {
  id: "sym:src/a.ts#Svc.run",
  kind: "method",
  name: "run",
  qualifiedName: "Svc.run",
  language: "typescript",
  file: "src/a.ts",
  span: { startLine: 12, endLine: 40 },
  signature: "run(<script>alert(1)</script>): void",
};

const DETAIL: NodeDetailResponse = {
  node: METHOD,
  parents: [
    { id: "dir:src", kind: "directory", name: "src" },
    { id: "file:src/a.ts", kind: "file", name: "a.ts", file: "src/a.ts" },
    { id: "sym:src/a.ts#Svc", kind: "class", name: "Svc", file: "src/a.ts" },
  ],
  children: [{ id: "sym:src/a.ts#Svc.run.inner", kind: "function", name: "inner" }],
  counts: { callers: 3, callees: 0, importedBy: 2, imports: 1 },
};

const analysis = makeAnalysis({ commitSha: "abc1234567890" });

function renderPanel(route: string) {
  return renderApp(<DetailPanel analysisId="an_1" analysis={analysis} />, {
    route,
    path: "/a/:analysisId",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("detail-model", () => {
  it("formats line ranges and locations", () => {
    expect(lineRange(METHOD)).toBe("12–40");
    expect(lineRange({ ...METHOD, span: { startLine: 7, endLine: 7 } })).toBe("7");
    expect(locationText(METHOD)).toBe("src/a.ts:12–40");
    expect(locationText({ id: "dir:x", kind: "directory", name: "x" })).toBeUndefined();
  });

  it("builds the GitHub link from the commit and the span, only for nodes with a file", () => {
    expect(githubUrlForNode(analysis, METHOD)).toBe(
      "https://github.com/acme/widgets/blob/abc1234567890/src/a.ts#L12-L40",
    );
    expect(githubUrlForNode(analysis, { id: "dir:x", kind: "directory", name: "x" })).toBe(
      undefined,
    );
  });

  it("links callers and callees to the flow tab and imports to the deps tab", () => {
    const links = countLinks(METHOD, DETAIL.counts);
    const byKey = Object.fromEntries(links.map((l) => [l.key, l.patch]));
    expect(byKey.callers).toMatchObject({ tab: "flow", node: METHOD.id });
    expect(byKey.callees).toBeUndefined(); // count 0: nothing to open
    expect(byKey.imports).toMatchObject({ tab: "deps", file: "src/a.ts" });
    expect(byKey.importedBy).toMatchObject({ tab: "deps", file: "src/a.ts" });
  });
});

describe("DetailPanel", () => {
  it("shows a hint and repository statistics when nothing is selected", () => {
    mockFetch(() => ({ status: 500, body: {} }));
    renderApp(
      <DetailPanel
        analysisId="an_1"
        analysis={makeAnalysis({
          stats: {
            languages: {
              typescript: {
                files: 12,
                bytes: 900,
                pluginTier: 3,
                references: { total: 100, resolved: 80 },
              },
            },
            nodesByKind: { file: 12, function: 30 },
            references: { total: 100, resolved: 80 },
            parseErrorFiles: 1,
          } as never,
        })}
      />,
      { route: "/a/an_1", path: "/a/:analysisId" },
    );
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Languages in this repository" })).toHaveTextContent(
      "TypeScript · 12 files · Tier 3 · 80% resolved",
    );
    expect(screen.getByText("80% resolved (80 of 100)")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Edge confidence legend" })).toBeInTheDocument();
  });

  it("shows the node, renders the signature as text and links to GitHub", async () => {
    mockFetch(() => ({ status: 200, body: DETAIL }));
    renderPanel("/a/an_1?node=sym:src/a.ts%23Svc.run");
    expect(await screen.findByRole("heading", { name: "run" })).toBeInTheDocument();
    expect(screen.getByText("Method")).toBeInTheDocument();
    expect(screen.getByText("Svc.run")).toBeInTheDocument();
    // The signature is text; no element was created from it.
    expect(screen.getByText("run(<script>alert(1)</script>): void")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    const link = screen.getByRole("link", { name: "Open on GitHub" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/blob/abc1234567890/src/a.ts#L12-L40",
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("list", { name: "Edge confidence legend" })).toBeInTheDocument();
  });

  it("switches tabs from the relation counts", async () => {
    mockFetch(() => ({ status: 200, body: DETAIL }));
    const user = userEvent.setup();
    renderPanel("/a/an_1?node=sym:src/a.ts%23Svc.run");
    await user.click(await screen.findByRole("link", { name: /Callers/ }));
    const text = screen.getByTestId("location").textContent ?? "";
    expect(text).toContain("tab=flow");
    expect(decodeURIComponent(text)).toContain("node=sym:src/a.ts#Svc.run");
    // Callees has no edges, so it is not a link.
    expect(screen.queryByRole("link", { name: /Callees/ })).toBeNull();
  });

  it("selects a breadcrumb entry and a child", async () => {
    mockFetch(() => ({ status: 200, body: DETAIL }));
    const user = userEvent.setup();
    renderPanel("/a/an_1?node=sym:src/a.ts%23Svc.run");
    const nav = await screen.findByRole("navigation", { name: "Location of the selected node" });
    await user.click(within(nav).getByRole("button", { name: "a.ts" }));
    expect(decodeURIComponent(screen.getByTestId("location").textContent ?? "")).toContain(
      "node=file:src/a.ts",
    );
  });

  it("copies the qualified name", async () => {
    mockFetch(() => ({ status: 200, body: DETAIL }));
    const user = userEvent.setup();
    // user-event installs its own clipboard stub; spy on it after setup.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderPanel("/a/an_1?node=sym:src/a.ts%23Svc.run");
    await user.click(await screen.findByRole("button", { name: "Copy name" }));
    expect(writeText).toHaveBeenCalledWith("Svc.run");
    expect(await screen.findByText("Copied to clipboard")).toBeInTheDocument();
  });

  it("has no GitHub link for a directory", async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        node: { id: "dir:src", kind: "directory", name: "src" },
        parents: [],
        children: [],
        counts: { callers: 0, callees: 0, importedBy: 0, imports: 0 },
      },
    }));
    renderPanel("/a/an_1?node=dir:src");
    await screen.findByRole("heading", { name: "src" });
    expect(screen.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
  });

  it("shows a not-found state and can clear the selection", async () => {
    mockFetch(() => ({
      status: 404,
      body: { error: { code: "NODE_NOT_FOUND", message: "No such node" } },
    }));
    const user = userEvent.setup();
    renderPanel("/a/an_1?node=file:gone.ts");
    expect(await screen.findByText("Node not found")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByTestId("location").textContent).not.toContain("node=");
  });

  it("shows an error with a retry button for other failures", async () => {
    mockFetch(() => ({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "kaput" } },
    }));
    renderPanel("/a/an_1?node=file:a.ts");
    expect(await screen.findByRole("alert")).toHaveTextContent("kaput");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
