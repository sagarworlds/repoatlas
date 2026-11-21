import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../api/types.ts";
import { moveIndex, navigationForNode, secondaryText, toggleKind } from "./search-navigation.ts";

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: "sym:src/a.ts#f",
  kind: "function",
  name: "f",
  ...over,
});

describe("navigationForNode", () => {
  it("sends functions and methods to the call flow tab", () => {
    expect(navigationForNode(node({}))).toMatchObject({ tab: "flow", node: "sym:src/a.ts#f" });
    expect(navigationForNode(node({ kind: "method" }))).toMatchObject({ tab: "flow" });
  });

  it("sends classes and interfaces to the map tab with the node selected", () => {
    expect(navigationForNode(node({ kind: "class", id: "sym:a#C" }))).toMatchObject({
      tab: "map",
      node: "sym:a#C",
    });
    expect(navigationForNode(node({ kind: "interface" })).tab).toBe("map");
  });

  it("sends files to the deps tab and sets the file", () => {
    expect(
      navigationForNode(node({ kind: "file", id: "file:src/a.ts", file: "src/a.ts" })),
    ).toEqual({
      tab: "deps",
      node: "file:src/a.ts",
      file: "src/a.ts",
      hl: undefined,
    });
    // falls back to the id when `file` is missing
    expect(navigationForNode(node({ kind: "file", id: "file:lib/b.py" })).file).toBe("lib/b.py");
  });

  it("focuses the map on a directory", () => {
    expect(navigationForNode(node({ kind: "directory", id: "dir:src" }))).toMatchObject({
      tab: "map",
      node: "dir:src",
      root: "dir:src",
    });
  });
});

describe("helpers", () => {
  it("toggleKind adds, removes and keeps chip order", () => {
    expect(toggleKind([], "file")).toEqual(["file"]);
    expect(toggleKind(["file"], "function")).toEqual(["function", "file"]);
    expect(toggleKind(["function", "file"], "function")).toEqual(["file"]);
  });

  it("moveIndex wraps", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });

  it("secondaryText prefers the qualified name", () => {
    expect(secondaryText(node({ qualifiedName: "A.f", file: "a.ts" }))).toBe("A.f");
    expect(secondaryText(node({ file: "a.ts" }))).toBe("a.ts");
    expect(secondaryText(node({ kind: "file", id: "file:x", file: "x" }))).toBe("x");
  });
});
