import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode } from "../../api/types.ts";
import { makeAnalysis, mockFetch, renderApp } from "../../test/utils.tsx";
import { FileTree } from "./file-tree.tsx";

const NODES: GraphNode[] = [
  { id: "dir:src", kind: "directory", name: "src", parentId: "dir:" },
  { id: "dir:src/util", kind: "directory", name: "util", parentId: "dir:src" },
  {
    id: "file:src/b.ts",
    kind: "file",
    name: "b.ts",
    file: "src/b.ts",
    language: "typescript",
    parentId: "dir:src",
    meta: { isTest: true },
  },
  {
    id: "file:src/a.ts",
    kind: "file",
    name: "a.ts",
    file: "src/a.ts",
    language: "typescript",
    parentId: "dir:src",
    meta: { parseErrors: 2 },
  },
  {
    id: "file:src/util/z.py",
    kind: "file",
    name: "z.py",
    file: "src/util/z.py",
    language: "python",
    parentId: "dir:src/util",
  },
  { id: "file:README.md", kind: "file", name: "README.md", file: "README.md", parentId: "dir:" },
];

function renderTree(route = "/a/an_1") {
  return renderApp(<FileTree analysisId="an_1" analysis={makeAnalysis()} />, {
    route,
    path: "/a/:analysisId",
  });
}

function location(): URLSearchParams {
  const text = screen.getByTestId("location").textContent ?? "";
  return new URLSearchParams(text.slice(text.indexOf("?")));
}

beforeEach(() => {
  mockFetch(() => ({ status: 200, body: { nodes: NODES, edges: [], truncated: false } }));
});
afterEach(() => vi.unstubAllGlobals());

const rowNames = () =>
  screen.getAllByRole("treeitem").map((row) => row.getAttribute("data-tree-id"));

describe("FileTree", () => {
  it("renders a sorted tree with the top level directories open", async () => {
    renderTree();
    await screen.findByRole("tree", { name: "Repository files" });
    expect(rowNames()).toEqual([
      "dir:src",
      "dir:src/util",
      "file:src/a.ts",
      "file:src/b.ts",
      "file:README.md",
    ]);
    const src = screen.getAllByRole("treeitem")[0];
    expect(src).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("aria-level", "2");
  });

  it("marks test files and parse errors with text, not only colour", async () => {
    renderTree();
    const b = await screen.findByTitle("src/b.ts");
    expect(within(b).getByText("test")).toBeInTheDocument();
    const a = screen.getByTitle("src/a.ts");
    expect(within(a).getByText("2 parse errors")).toBeInTheDocument();
  });

  it("selects a file on click, pushing the node into the URL", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(await screen.findByTitle("src/a.ts"));
    expect(location().get("node")).toBe("file:src/a.ts");
    expect(screen.getByTitle("src/a.ts")).toHaveAttribute("aria-selected", "true");
  });

  it("toggles a directory and selects it on click", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(await screen.findByTitle("src/util"));
    expect(location().get("node")).toBe("dir:src/util");
    expect(rowNames()).toContain("file:src/util/z.py");
    await user.click(screen.getByTitle("src/util"));
    expect(rowNames()).not.toContain("file:src/util/z.py");
  });

  it("follows an external selection: opens the folders above it and marks it selected", async () => {
    renderTree("/a/an_1?node=sym:src/util/z.py%23run");
    const row = await screen.findByTitle("src/util/z.py");
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  it("supports keyboard navigation (roving tabindex)", async () => {
    const user = userEvent.setup();
    renderTree();
    const items = await screen.findAllByRole("treeitem");
    expect(items.filter((i) => i.getAttribute("tabindex") === "0")).toHaveLength(1);

    items[0]?.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTitle("src/util")).toHaveFocus();
    expect(screen.getByTitle("src/util")).toHaveAttribute("tabindex", "0");

    await user.keyboard("{ArrowRight}"); // expand
    expect(screen.getByTitle("src/util")).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}"); // into the folder
    expect(screen.getByTitle("src/util/z.py")).toHaveFocus();
    await user.keyboard("{ArrowLeft}"); // back to the parent
    expect(screen.getByTitle("src/util")).toHaveFocus();
    await user.keyboard("{ArrowLeft}"); // collapse
    expect(screen.getByTitle("src/util")).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{End}");
    expect(screen.getByTitle("README.md")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByTitle("src")).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(location().get("node")).toBe("file:src/a.ts");
  });

  it("activates with the Space key", async () => {
    const user = userEvent.setup();
    renderTree();
    (await screen.findByTitle("README.md")).focus();
    await user.keyboard(" ");
    expect(location().get("node")).toBe("file:README.md");
  });

  it("filters while typing, without hijacking arrow keys in the input", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.type(
      await screen.findByRole("searchbox", { name: "Filter files" }),
      "z.py{ArrowLeft}",
    );
    expect(rowNames()).toEqual(["dir:src", "dir:src/util", "file:src/util/z.py"]);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nothing-here");
    expect(screen.getByText("No files match the filter.")).toBeInTheDocument();
  });

  it("shows an error with a retry button", async () => {
    mockFetch(() => ({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "boom" } },
    }));
    renderTree();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("explains a truncated tree and loads opened directories lazily", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(decodeURIComponent(url));
      if (url.includes("root=dir%3Asrc") && !url.includes("root=dir%3A&")) {
        return {
          status: 200,
          body: {
            nodes: [
              {
                id: "file:src/extra.ts",
                kind: "file",
                name: "extra.ts",
                file: "src/extra.ts",
                parentId: "dir:src",
              },
            ],
            edges: [],
            truncated: false,
          },
        };
      }
      return {
        status: 200,
        body: {
          nodes: [{ id: "dir:src", kind: "directory", name: "src", parentId: "dir:" }],
          edges: [],
          truncated: true,
        },
      };
    });
    renderTree();
    expect(await screen.findByRole("note")).toHaveTextContent("Large repository");
    await waitFor(() => expect(rowNames()).toContain("file:src/extra.ts"));
    expect(calls.some((c) => c.includes("root=dir:src"))).toBe(true);
  });
});
