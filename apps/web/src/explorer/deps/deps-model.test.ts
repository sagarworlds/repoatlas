import { describe, expect, it } from "vitest";
import type { DepsResponse, GraphEdge, GraphNode } from "../../api/types.ts";
import {
  buildDepsModel,
  countItems,
  type DepItem,
  edgeMetaText,
  fileOfNodeId,
  filePathOf,
  UNRESOLVED_LABEL,
} from "./deps-model.ts";

const file = (path: string): GraphNode => ({
  id: `file:${path}`,
  kind: "file",
  name: path.split("/").pop() ?? path,
  file: path,
});
const ext = (ecosystem: string, pkg: string): GraphNode => ({
  id: `ext:${ecosystem}:${pkg}`,
  kind: "external",
  name: pkg,
});
const imp = (src: GraphNode, dst: GraphNode, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  src: src.id,
  dst: dst.id,
  kind: "imports",
  confidence: "exact",
  ...extra,
});
const paths = (items: DepItem[]) => items.map((i) => i.path);

const a = file("src/a.ts");
const b = file("src/b.ts");
const c = file("src/c.ts");
const d = file("src/d.ts");

describe("fileOfNodeId / filePathOf", () => {
  it("derives the file from file and symbol ids", () => {
    expect(fileOfNodeId("file:src/a.ts")).toBe("src/a.ts");
    expect(fileOfNodeId("sym:src/a.ts#Foo.bar")).toBe("src/a.ts");
    expect(fileOfNodeId("dir:src")).toBeUndefined();
    expect(fileOfNodeId(undefined)).toBeUndefined();
  });

  it("falls back to the id when a file node has no file field", () => {
    expect(filePathOf({ id: "file:x/y.ts", kind: "file", name: "y.ts" })).toBe("x/y.ts");
  });
});

describe("buildDepsModel", () => {
  it("returns undefined when the centre is not in the response", () => {
    expect(buildDepsModel({ nodes: [a], edges: [] }, "src/zzz.ts", 1)).toBeUndefined();
  });

  it("splits importers and imports and sorts them by path", () => {
    const data: DepsResponse = {
      nodes: [a, b, c, d],
      edges: [imp(a, d), imp(a, c), imp(b, a)],
    };
    const model = buildDepsModel(data, "src/a.ts", 1);
    expect(paths(model?.imports ?? [])).toEqual(["src/c.ts", "src/d.ts"]);
    expect(paths(model?.importedBy ?? [])).toEqual(["src/b.ts"]);
  });

  it("nests deeper hops under their parent and respects the depth cap", () => {
    const data: DepsResponse = { nodes: [a, b, c, d], edges: [imp(a, b), imp(b, c), imp(c, d)] };
    const two = buildDepsModel(data, "src/a.ts", 2);
    expect(paths(two?.imports ?? [])).toEqual(["src/b.ts"]);
    expect(paths(two?.imports[0]?.children ?? [])).toEqual(["src/c.ts"]);
    expect(two?.imports[0]?.children[0]?.hop).toBe(2);
    expect(countItems(two?.imports ?? [])).toBe(2);

    const three = buildDepsModel(data, "src/a.ts", 3);
    expect(countItems(three?.imports ?? [])).toBe(3);
    expect(three?.imports[0]?.children[0]?.children[0]?.path).toBe("src/d.ts");

    const one = buildDepsModel(data, "src/a.ts", 1);
    expect(countItems(one?.imports ?? [])).toBe(1);
  });

  it("places each file once per column when imports are circular", () => {
    const data: DepsResponse = { nodes: [a, b, c], edges: [imp(a, b), imp(b, c), imp(c, a)] };
    const model = buildDepsModel(data, "src/a.ts", 3);
    // Right column: b, then c below b. The centre (a) is never repeated.
    expect(paths(model?.imports ?? [])).toEqual(["src/b.ts"]);
    expect(countItems(model?.imports ?? [])).toBe(2);
    // Left column: c imports a, b imports c.
    expect(paths(model?.importedBy ?? [])).toEqual(["src/c.ts"]);
    expect(countItems(model?.importedBy ?? [])).toBe(2);
    // b and c appear on both sides, so they are flagged as circular.
    expect(model?.imports[0]?.circular).toBe(true);
  });

  it("does not repeat a file reachable by two paths (diamond)", () => {
    const data: DepsResponse = {
      nodes: [a, b, c, d],
      edges: [imp(a, b), imp(a, c), imp(b, d), imp(c, d)],
    };
    const model = buildDepsModel(data, "src/a.ts", 2);
    expect(countItems(model?.imports ?? [])).toBe(3);
  });

  it("groups externals by ecosystem, leaves unresolved modules in their own group", () => {
    const mod: GraphNode = { id: "mod:ts:left-pad", kind: "module", name: "left-pad" };
    const data: DepsResponse = {
      nodes: [a, b, ext("npm", "react"), ext("npm", "zod"), ext("pypi", "requests"), mod],
      edges: [
        imp(a, ext("npm", "zod"), { meta: { importedNames: ["z"], alias: "zz" } }),
        imp(a, ext("npm", "react")),
        imp(b, ext("npm", "react")),
        imp(a, ext("pypi", "requests")),
        imp(a, mod, { confidence: "name-match" }),
        imp(a, b),
      ],
    };
    const model = buildDepsModel(data, "src/a.ts", 1);
    expect(model?.externals.map((g) => g.label)).toEqual(["npm", "pypi", UNRESOLVED_LABEL]);
    const npm = model?.externals.find((g) => g.label === "npm");
    expect(npm?.items.map((i) => i.name)).toEqual(["react", "zod"]);
    // b is in the right column, so its import of react counts as a second user.
    expect(npm?.items[0]?.usedBy).toEqual(["src/a.ts", "src/b.ts"]);
    expect(npm?.items[1]?.edge.meta?.alias).toBe("zz");
  });

  it("ignores edges of other kinds", () => {
    const data: DepsResponse = {
      nodes: [a, b],
      edges: [{ src: a.id, dst: b.id, kind: "calls", confidence: "exact" }],
    };
    const model = buildDepsModel(data, "src/a.ts", 1);
    expect(model?.imports).toEqual([]);
  });
});

describe("edgeMetaText", () => {
  it("lists names, alias, dynamic and line; truncates long name lists", () => {
    expect(edgeMetaText({ src: "x", dst: "y", kind: "imports", confidence: "exact" })).toEqual([]);
    const text = edgeMetaText({
      src: "x",
      dst: "y",
      kind: "imports",
      confidence: "exact",
      line: 3,
      meta: { importedNames: ["a", "b", "c", "d", "e", "f", "g"], alias: "q", isDynamic: true },
    });
    expect(text).toEqual(["imports a, b, c, d, e, +2 more", "as q", "dynamic", "line 3"]);
  });
});
