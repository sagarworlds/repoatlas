import type { GraphEdge, GraphNode, RollupRow } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { ancestorDirs, computeRollups } from "./rollups.ts";

const file = (path: string): GraphNode => ({
  id: `file:${path}`,
  kind: "file",
  name: path.split("/").pop() ?? path,
  file: path,
});
const fn = (path: string, name: string): GraphNode => ({
  id: `sym:${path}#${name}`,
  kind: "function",
  name,
  file: path,
});
const edge = (
  src: string,
  dst: string,
  kind: GraphEdge["kind"],
  callCount?: number,
): GraphEdge => ({
  src,
  dst,
  kind,
  confidence: "exact",
  ...(callCount === undefined ? {} : { meta: { callCount } }),
});

describe("ancestorDirs", () => {
  it("lists directories outermost first and excludes the root", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorDirs("top.ts")).toEqual([]);
  });
});

describe("computeRollups", () => {
  const nodes: GraphNode[] = [
    { id: "repo:", kind: "repo", name: "r" },
    { id: "dir:src", kind: "directory", name: "src" },
    file("src/a/x.ts"),
    file("src/a/y.ts"),
    file("src/a/deep/w.ts"),
    file("src/b/z.ts"),
    file("lib/q.ts"),
    fn("src/a/x.ts", "f"),
    fn("src/a/y.ts", "g"),
    fn("src/a/deep/w.ts", "k"),
    fn("src/b/z.ts", "h"),
    fn("lib/q.ts", "m"),
    { id: "ext:npm:lodash", kind: "external", name: "lodash" },
  ];
  const edges: GraphEdge[] = [
    edge("sym:src/a/x.ts#f", "sym:src/b/z.ts#h", "calls", 3), // cross-dir call
    edge("sym:src/a/y.ts#g", "sym:src/b/z.ts#h", "calls"), // default weight 1
    edge("file:src/a/x.ts", "file:src/b/z.ts", "imports"),
    edge("file:src/a/x.ts", "file:src/a/y.ts", "imports"), // internal to src/a
    edge("file:src/a/x.ts", "ext:npm:lodash", "imports"), // external: ignored
    edge("file:src/a/x.ts", "sym:src/b/z.ts#h", "calls", 2), // top-level call from a file
    edge("sym:src/a/deep/w.ts#k", "sym:src/a/y.ts#g", "calls"), // nested dir -> ancestor dir
    edge("sym:src/b/z.ts#h", "sym:lib/q.ts#m", "calls"),
    edge("sym:src/a/x.ts#f", "sym:src/a/x.ts#f", "calls"), // same file: ignored
    edge("dir:src", "file:src/a/x.ts", "contains"), // not imports/calls: ignored
  ];

  it("matches the hand-computed rows", () => {
    const expected: RollupRow[] = [
      { level: "dir", kind: "calls", src: "dir:src", dst: "dir:lib", weight: 1 },
      { level: "dir", kind: "calls", src: "dir:src/a", dst: "dir:src/b", weight: 6 },
      { level: "dir", kind: "calls", src: "dir:src/b", dst: "dir:lib", weight: 1 },
      { level: "dir", kind: "imports", src: "dir:src/a", dst: "dir:src/b", weight: 1 },
      {
        level: "file",
        kind: "calls",
        src: "file:src/a/deep/w.ts",
        dst: "file:src/a/y.ts",
        weight: 1,
      },
      { level: "file", kind: "calls", src: "file:src/a/x.ts", dst: "file:src/b/z.ts", weight: 5 },
      { level: "file", kind: "calls", src: "file:src/a/y.ts", dst: "file:src/b/z.ts", weight: 1 },
      { level: "file", kind: "calls", src: "file:src/b/z.ts", dst: "file:lib/q.ts", weight: 1 },
      { level: "file", kind: "imports", src: "file:src/a/x.ts", dst: "file:src/a/y.ts", weight: 1 },
      { level: "file", kind: "imports", src: "file:src/a/x.ts", dst: "file:src/b/z.ts", weight: 1 },
    ];
    // Default variant only: no variant fields.
    expect(computeRollups(nodes, edges).filter((r) => r.includeTests === undefined)).toEqual(
      expected,
    );
  });

  it("emits includeTests / minConfidence variants", () => {
    const testNodes: GraphNode[] = [
      file("src/a.ts"),
      { ...file("src/a.test.ts"), meta: { isTest: true } },
      file("lib/b.ts"),
      fn("src/a.ts", "f"),
      fn("src/a.test.ts", "t"),
      fn("lib/b.ts", "g"),
    ];
    const testEdges: GraphEdge[] = [
      edge("sym:src/a.ts#f", "sym:lib/b.ts#g", "calls", 2),
      { ...edge("sym:src/a.test.ts#t", "sym:lib/b.ts#g", "calls", 5), confidence: "inferred" },
    ];
    const rows = computeRollups(testNodes, testEdges).filter(
      (r) => r.level === "dir" && r.dst === "dir:lib",
    );
    const weight = (src: string, includeTests?: boolean, minConfidence?: string) =>
      rows.find(
        (r) =>
          r.src === src && r.includeTests === includeTests && r.minConfidence === minConfidence,
      )?.weight;
    expect(weight("dir:src")).toBe(7); // everything
    expect(weight("dir:src", false, "name-match")).toBe(2); // test edge dropped
    expect(weight("dir:src", true, "exact")).toBe(2); // inferred edge dropped
    expect(weight("dir:src", false, "exact")).toBe(2);
  });

  it("never emits the root directory or same-directory rows", () => {
    const rows = computeRollups(nodes, edges).filter((r) => r.level === "dir");
    expect(rows.some((r) => r.src === "dir:" || r.dst === "dir:")).toBe(false);
    expect(rows.some((r) => r.src === r.dst)).toBe(false);
  });

  it("is independent of edge order", () => {
    expect(computeRollups(nodes, [...edges].reverse())).toEqual(computeRollups(nodes, edges));
  });
});
