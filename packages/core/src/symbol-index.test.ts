import type { GraphNode } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { buildSymbolIndex } from "./symbol-index.ts";

const sym = (
  id: string,
  kind: GraphNode["kind"],
  name: string,
  file: string,
  startLine: number,
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  kind,
  name,
  file,
  language: "typescript",
  span: { startLine, endLine: startLine + 1 },
  ...extra,
});

describe("buildSymbolIndex", () => {
  const nodes: GraphNode[] = [
    { id: "file:b.ts", kind: "file", name: "b.ts", file: "b.ts" },
    sym("sym:b.ts#save", "function", "save", "b.ts", 1, { qualifiedName: "b.save" }),
    sym("sym:a.ts#User.save", "method", "save", "a.ts", 9, {
      qualifiedName: "a.User.save",
      parentId: "sym:a.ts#User",
    }),
    sym("sym:a.ts#User", "class", "User", "a.ts", 1, { qualifiedName: "a.User" }),
    sym("sym:a.ts#User.load", "method", "load", "a.ts", 5, { parentId: "sym:a.ts#User" }),
  ];
  const index = buildSymbolIndex(nodes);

  it("indexes only symbol nodes", () => {
    expect(index.byId.has("file:b.ts")).toBe(false);
    expect(index.byId.size).toBe(4);
  });

  it("orders deterministically by file and line", () => {
    expect(index.byFile.get("a.ts")?.map((n) => n.id)).toEqual([
      "sym:a.ts#User",
      "sym:a.ts#User.load",
      "sym:a.ts#User.save",
    ]);
    expect(index.byShortName.get("save")?.map((n) => n.id)).toEqual([
      "sym:a.ts#User.save",
      "sym:b.ts#save",
    ]);
    expect(index.byQualifiedName.get("a.User")?.[0]?.id).toBe("sym:a.ts#User");
  });

  it("returns members via parentId", () => {
    expect(index.membersOf("sym:a.ts#User").map((n) => n.name)).toEqual(["load", "save"]);
    expect(index.membersOf("nope")).toEqual([]);
  });

  it("tracks super types and module files", () => {
    index.addSuperType("sym:a.ts#User", "sym:b.ts#Base");
    index.addSuperType("sym:a.ts#User", "sym:b.ts#Base");
    expect(index.superTypesOf("sym:a.ts#User")).toEqual(["sym:b.ts#Base"]);
    index.setModuleFiles("pkg", ["z.go", "a.go", "z.go"]);
    expect(index.moduleToFiles.get("pkg")).toEqual(["a.go", "z.go"]);
  });
});
