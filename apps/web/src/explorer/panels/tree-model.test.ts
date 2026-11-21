import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../api/types.ts";
import {
  ancestorDirIds,
  buildTree,
  defaultExpanded,
  flattenTree,
  navigate,
  treeIdForNode,
} from "./tree-model.ts";

function dir(path: string): GraphNode {
  const parent = path.includes("/") ? `dir:${path.slice(0, path.lastIndexOf("/"))}` : "dir:";
  return {
    id: `dir:${path}`,
    kind: "directory",
    name: path.slice(path.lastIndexOf("/") + 1),
    parentId: parent,
  };
}
function file(path: string, extra: Partial<GraphNode> = {}): GraphNode {
  const slash = path.lastIndexOf("/");
  return {
    id: `file:${path}`,
    kind: "file",
    name: path.slice(slash + 1),
    file: path,
    parentId: slash === -1 ? "dir:" : `dir:${path.slice(0, slash)}`,
    ...extra,
  };
}

const NODES: GraphNode[] = [
  file("README.md"),
  file("src/b.ts"),
  file("src/a.ts"),
  dir("src"),
  dir("src/util"),
  file("src/util/z.ts"),
  dir("Zed"),
  file("src/B.ts"),
];

describe("buildTree", () => {
  it("nests entries under their parent and sorts directories first, by code unit", () => {
    const model = buildTree(NODES);
    expect(model.roots.map((r) => r.name)).toEqual(["Zed", "src", "README.md"]);
    const src = model.byId.get("dir:src");
    // "B.ts" < "a.ts" in code-unit order (uppercase first), directories before files.
    expect(src?.children.map((c) => c.name)).toEqual(["util", "B.ts", "a.ts", "b.ts"]);
  });

  it("is independent of the input order", () => {
    const forward = buildTree(NODES).roots.map((r) => r.id);
    const backward = buildTree([...NODES].reverse()).roots.map((r) => r.id);
    expect(backward).toEqual(forward);
  });

  it("ignores symbols and the root directory, and shows orphans at the top level", () => {
    const model = buildTree([
      { id: "dir:", kind: "directory", name: "" },
      { id: "sym:a.ts#f", kind: "function", name: "f", file: "a.ts" },
      file("deep/x.ts"), // parent dir:deep is missing (truncated response)
    ]);
    expect(model.roots.map((r) => r.id)).toEqual(["file:deep/x.ts"]);
  });
});

describe("expansion helpers", () => {
  it("expands the top level directories by default", () => {
    expect([...defaultExpanded(buildTree(NODES))].sort()).toEqual(["dir:Zed", "dir:src"]);
  });

  it("maps selected nodes to tree entries", () => {
    expect(treeIdForNode("file:src/a.ts")).toBe("file:src/a.ts");
    expect(treeIdForNode("dir:src")).toBe("dir:src");
    expect(treeIdForNode("sym:src/a.ts#Foo.bar")).toBe("file:src/a.ts");
    expect(treeIdForNode("dir:")).toBeUndefined();
    expect(treeIdForNode("ext:lodash")).toBeUndefined();
    expect(treeIdForNode(undefined)).toBeUndefined();
  });

  it("lists the directories to open for a deep selection", () => {
    expect(ancestorDirIds("file:a/b/c.ts")).toEqual(["dir:a", "dir:a/b"]);
    expect(ancestorDirIds("file:top.ts")).toEqual([]);
  });
});

describe("flattenTree", () => {
  const model = buildTree(NODES);

  it("shows only the children of expanded directories", () => {
    const rows = flattenTree(model.roots, new Set(["dir:src"]));
    expect(rows.map((r) => r.item.path)).toEqual([
      "Zed",
      "src",
      "src/util",
      "src/B.ts",
      "src/a.ts",
      "src/b.ts",
      "README.md",
    ]);
    const util = rows.find((r) => r.item.id === "dir:src/util");
    expect(util).toMatchObject({ depth: 1, expanded: false, posInSet: 1, setSize: 4 });
  });

  it("filters by path, keeping and expanding ancestors", () => {
    const rows = flattenTree(model.roots, new Set(), "Z.TS");
    expect(rows.map((r) => r.item.path)).toEqual(["src", "src/util", "src/util/z.ts"]);
    expect(rows.every((r) => r.item.isDir === false || r.expanded)).toBe(true);
  });
});

describe("navigate (keyboard)", () => {
  const model = buildTree(NODES);
  const rows = flattenTree(model.roots, new Set(["dir:src"]));

  it("moves with arrows, Home and End and clamps at the ends", () => {
    expect(navigate(rows, "dir:Zed", "ArrowDown")).toEqual({ type: "focus", id: "dir:src" });
    expect(navigate(rows, "dir:Zed", "ArrowUp")).toEqual({ type: "focus", id: "dir:Zed" });
    expect(navigate(rows, "dir:src", "Home")).toEqual({ type: "focus", id: "dir:Zed" });
    expect(navigate(rows, "dir:src", "End")).toEqual({ type: "focus", id: "file:README.md" });
    expect(navigate(rows, "file:README.md", "ArrowDown")).toEqual({
      type: "focus",
      id: "file:README.md",
    });
  });

  it("expands, enters and collapses directories with Right and Left", () => {
    expect(navigate(rows, "dir:src/util", "ArrowRight")).toEqual({
      type: "expand",
      id: "dir:src/util",
    });
    expect(navigate(rows, "dir:src", "ArrowRight")).toEqual({
      type: "focus",
      id: "dir:src/util",
    });
    expect(navigate(rows, "dir:src", "ArrowLeft")).toEqual({ type: "collapse", id: "dir:src" });
    expect(navigate(rows, "file:src/a.ts", "ArrowLeft")).toEqual({ type: "focus", id: "dir:src" });
    expect(navigate(rows, "file:README.md", "ArrowRight")).toBeUndefined();
  });

  it("starts at the first row when nothing is focused and handles an empty tree", () => {
    expect(navigate(rows, undefined, "ArrowDown")).toEqual({ type: "focus", id: "dir:Zed" });
    expect(navigate([], undefined, "ArrowDown")).toBeUndefined();
  });
});
