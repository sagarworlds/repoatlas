import type { GraphNode } from "@repoatlas/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStore } from "./index.ts";
import { baseQuery, demoGraph, ids } from "./test-graph.ts";
import type { GraphStore } from "./types.ts";

let store: GraphStore;
const A = "a1";
beforeAll(() => {
  store = openStore(":memory:");
  store.createAnalysis({ id: A, owner: "o", repo: "r", ref: "main", analyzerVersion: "1" });
  store.saveGraph(A, demoGraph());
});
afterAll(() => store.close());

const idsOf = (nodes: { id: string }[] | undefined) => (nodes ?? []).map((n) => n.id).sort();
const edgeKeys = (edges: { src: string; dst: string; kind: string }[]) =>
  edges.map((e) => `${e.src}>${e.dst}:${e.kind}`).sort();

describe("getSubgraph dir level", () => {
  it("returns directories and rollup edges with weight", () => {
    const r = store.getSubgraph(A, baseQuery());
    expect(idsOf(r.nodes)).toEqual(["dir:", "dir:src", "dir:src/core", "dir:tests"]);
    expect(r.truncated).toBe(false);
    const e = r.edges.find((x) => x.src === "dir:src" && x.kind === "imports");
    expect(e).toMatchObject({ dst: "dir:src/core", weight: 3, confidence: "inferred" });
    expect(r.edges).toHaveLength(4);
  });

  it("annotates childCount, loc and degree", () => {
    const r = store.getSubgraph(A, baseQuery());
    const src = r.nodes.find((n) => n.id === "dir:src");
    expect(src?.meta).toMatchObject({ childCount: 3, loc: 180, degree: 3 });
    expect(r.nodes.find((n) => n.id === "dir:")?.meta?.loc).toBe(200);
  });

  it("respects depth and root", () => {
    const shallow = store.getSubgraph(A, baseQuery({ depth: 1 }));
    expect(idsOf(shallow.nodes)).toEqual(["dir:", "dir:src", "dir:tests"]);
    const sub = store.getSubgraph(A, baseQuery({ root: "dir:src", depth: 1 }));
    expect(idsOf(sub.nodes)).toEqual(["dir:src", "dir:src/core"]);
    // "repo:" is treated as the root directory
    expect(idsOf(store.getSubgraph(A, baseQuery({ root: "repo:", depth: 1 })).nodes)).toEqual([
      "dir:",
      "dir:src",
      "dir:tests",
    ]);
    expect(store.getSubgraph(A, baseQuery({ root: "dir:missing" }))).toEqual({
      nodes: [],
      edges: [],
      truncated: false,
    });
  });

  it("filters edge kinds and tests", () => {
    const calls = store.getSubgraph(A, baseQuery({ edgeKinds: ["calls"] }));
    expect(edgeKeys(calls.edges)).toEqual(["dir:src>dir:src/core:calls"]);
    const noTests = store.getSubgraph(A, baseQuery({ includeTests: false }));
    expect(idsOf(noTests.nodes)).not.toContain("dir:tests");
    expect(noTests.edges.every((e) => e.src !== "dir:tests")).toBe(true);
  });

  it("picks the rollup variant that matches includeTests and minConfidence", () => {
    const data = demoGraph();
    // Same pair, three variants with different weights.
    data.rollups = [
      { level: "dir", src: "dir:src", dst: "dir:src/core", kind: "calls", weight: 9 },
      {
        level: "dir",
        src: "dir:src",
        dst: "dir:src/core",
        kind: "calls",
        weight: 4,
        includeTests: false,
        minConfidence: "name-match",
      },
      {
        level: "dir",
        src: "dir:src",
        dst: "dir:src/core",
        kind: "calls",
        weight: 2,
        includeTests: true,
        minConfidence: "exact",
      },
    ];
    store.createAnalysis({ id: "v1", owner: "o", repo: "r", ref: "main", analyzerVersion: "1" });
    store.saveGraph("v1", data);
    const weightOf = (overrides: Parameters<typeof baseQuery>[0]) =>
      store.getSubgraph("v1", baseQuery({ edgeKinds: ["calls"], ...overrides })).edges[0];
    expect(weightOf({})?.weight).toBe(9);
    expect(weightOf({ includeTests: false })?.weight).toBe(4);
    expect(weightOf({ minConfidence: "exact" })).toMatchObject({ weight: 2, confidence: "exact" });
    expect(weightOf({ includeTests: false, minConfidence: "exact" })).toBeUndefined();
  });

  it("never returns external nodes at dir level", () => {
    const r = store.getSubgraph(A, baseQuery({ includeExternal: true }));
    expect(r.nodes.some((n) => n.kind === "external")).toBe(false);
  });
});

describe("getSubgraph file level", () => {
  it("returns directories as parents plus files and file rollups", () => {
    const r = store.getSubgraph(A, baseQuery({ level: "file", includeTests: false }));
    expect(idsOf(r.nodes)).toEqual([
      "dir:",
      "dir:src",
      "dir:src/core",
      "file:src/core/engine.ts",
      "file:src/main.ts",
      "file:src/util.ts",
    ]);
    expect(edgeKeys(r.edges)).toEqual([
      "file:src/core/engine.ts>file:src/util.ts:imports",
      "file:src/main.ts>file:src/core/engine.ts:imports",
      "file:src/main.ts>file:src/util.ts:imports",
    ]);
    const file = r.nodes.find((n) => n.id === "file:src/main.ts");
    expect(file?.parentId).toBe("dir:src");
    expect(file?.meta).toMatchObject({ loc: 50, childCount: 1, degree: 2 });
  });

  it("includeTests keeps test files, includeExternal adds ext nodes and edges", () => {
    const r = store.getSubgraph(A, baseQuery({ level: "file", includeExternal: true }));
    expect(idsOf(r.nodes)).toContain("file:tests/engine.test.ts");
    expect(idsOf(r.nodes)).toContain("ext:npm:lodash");
    expect(edgeKeys(r.edges)).toContain("file:src/main.ts>ext:npm:lodash:imports");
    const noImports = store.getSubgraph(
      A,
      baseQuery({ level: "file", includeExternal: true, edgeKinds: ["calls"] }),
    );
    expect(noImports.nodes.some((n) => n.kind === "external")).toBe(false);
  });
});

describe("getSubgraph symbol level", () => {
  const symbolQuery = (o = {}) =>
    baseQuery({ level: "symbol", root: "dir:src", depth: 5, includeTests: false, ...o });

  it("returns symbols with their ancestors and real call edges", () => {
    const r = store.getSubgraph(A, symbolQuery());
    expect(idsOf(r.nodes)).toContain(ids.RUN);
    expect(idsOf(r.nodes)).toContain("file:src/core/engine.ts");
    expect(r.nodes.find((n) => n.id === ids.RUN)?.parentId).toBe("sym:src/core/engine.ts#Engine");
    const calls = r.edges.filter((e) => e.kind === "calls");
    expect(calls).toHaveLength(5);
    expect(calls.find((e) => e.src === ids.START && e.dst === ids.RUN)).toMatchObject({
      confidence: "exact",
      line: 5,
    });
    // contains edges are never returned (parentId already says it)
    expect(r.edges.some((e) => e.kind === "contains")).toBe(false);
  });

  it("filters by minConfidence", () => {
    const inferred = store.getSubgraph(A, symbolQuery({ minConfidence: "inferred" }));
    expect(inferred.edges.some((e) => e.confidence === "name-match")).toBe(false);
    expect(inferred.edges.some((e) => e.confidence === "inferred")).toBe(true);
    const exact = store.getSubgraph(A, symbolQuery({ minConfidence: "exact" }));
    expect(exact.edges.every((e) => e.confidence === "exact")).toBe(true);
  });

  it("excludes test symbols and includes externals when asked", () => {
    const all = store.getSubgraph(A, symbolQuery({ root: "dir:", includeTests: true }));
    expect(idsOf(all.nodes)).toContain(ids.TEST_RUN);
    const noTests = store.getSubgraph(A, symbolQuery({ root: "dir:" }));
    expect(idsOf(noTests.nodes)).not.toContain(ids.TEST_RUN);
    const ext = store.getSubgraph(A, symbolQuery({ includeExternal: true }));
    expect(idsOf(ext.nodes)).toContain("ext:npm:lodash");
  });

  it("works with a class as root", () => {
    const cls = "sym:src/core/engine.ts#Engine";
    const r = store.getSubgraph(A, baseQuery({ level: "symbol", root: cls, depth: 1 }));
    expect(idsOf(r.nodes)).toEqual([ids.RUN, ids.STOP, cls].sort());
    expect(edgeKeys(r.edges)).toEqual([`${ids.RUN}>${ids.STOP}:calls`]);
  });
});

describe("getSubgraph truncation", () => {
  it("drops lowest-degree leaves, keeps the root and sets truncated", () => {
    const r = store.getSubgraph(
      A,
      baseQuery({ level: "symbol", root: "dir:", depth: 5, maxNodes: 8 }),
    );
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBe(8);
    expect(r.nodes.some((n) => n.id === "dir:")).toBe(true);
    const kept = new Set(r.nodes.map((n) => n.id));
    for (const n of r.nodes) {
      if (n.id !== "dir:" && n.parentId !== undefined) expect(kept.has(n.parentId)).toBe(true); // tree stays connected
    }
    for (const e of r.edges) {
      expect(kept.has(e.src) && kept.has(e.dst)).toBe(true);
    }
  });

  it("caps edges by weight", () => {
    const r = store.getSubgraph(A, baseQuery({ maxEdges: 1 }));
    expect(r.truncated).toBe(true);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]?.weight).toBe(3);
  });

  it("with maxNodes 1 only the root remains", () => {
    const r = store.getSubgraph(A, baseQuery({ maxNodes: 1 }));
    expect(idsOf(r.nodes)).toEqual(["dir:"]);
    expect(r.edges).toEqual([]);
  });
});

describe("getNodeDetail", () => {
  it("returns breadcrumb root first and counts", () => {
    const d = store.getNodeDetail(A, ids.RUN);
    expect(d?.parents.map((p) => p.id)).toEqual([
      "repo:",
      "dir:",
      "dir:src",
      "dir:src/core",
      "file:src/core/engine.ts",
      "sym:src/core/engine.ts#Engine",
    ]);
    expect(d?.counts).toEqual({ callers: 2, callees: 2, importedBy: 0, imports: 0 });
  });

  it("orders children by start line then name", () => {
    const d = store.getNodeDetail(A, "sym:src/core/engine.ts#Engine");
    expect(d?.children.map((c) => c.name)).toEqual(["run", "stop"]);
  });

  it("aggregates symbol calls for file nodes, ignoring intra-file calls", () => {
    const d = store.getNodeDetail(A, "file:src/core/engine.ts");
    // callers: start->run, testRun->run; callees: run->helper (run->stop is internal)
    expect(d?.counts).toEqual({ callers: 2, callees: 1, importedBy: 2, imports: 1 });
    const main = store.getNodeDetail(A, "file:src/main.ts");
    expect(main?.counts).toMatchObject({ imports: 3, importedBy: 0 });
  });

  it("returns undefined for unknown nodes and an empty breadcrumb for the repo", () => {
    expect(store.getNodeDetail(A, "sym:nope#x")).toBeUndefined();
    expect(store.getNodeDetail(A, "repo:")?.parents).toEqual([]);
  });
});

describe("getCallflow", () => {
  it("walks callers and callees with depth limits", () => {
    const r = store.getCallflow(A, ids.RUN, 1, 1);
    expect(r?.focus).toBe(ids.RUN);
    expect(r?.nodes[0]?.id).toBe(ids.RUN);
    expect(idsOf(r?.nodes)).toEqual(
      [ids.HELPER, ids.RUN, ids.START, ids.STOP, ids.TEST_RUN].sort(),
    );
    expect(r?.edges.every((e) => e.kind === "calls")).toBe(true);
    const edge = r?.edges.find((e) => e.src === ids.START && e.dst === ids.RUN);
    expect(edge).toMatchObject({ line: 5, confidence: "exact" });
  });

  it("only goes as deep as asked", () => {
    const up = store.getCallflow(A, ids.STOP, 1, 0);
    expect(idsOf(up?.nodes)).toEqual([ids.RUN, ids.STOP].sort());
    const up2 = store.getCallflow(A, ids.STOP, 2, 0);
    expect(idsOf(up2?.nodes)).toEqual([ids.RUN, ids.START, ids.STOP, ids.TEST_RUN].sort());
  });

  it("depth 0 returns only the focus node", () => {
    const r = store.getCallflow(A, ids.RUN, 0, 0);
    expect(idsOf(r?.nodes)).toEqual([ids.RUN]);
    expect(r?.edges).toEqual([]);
  });

  it("is cycle safe and clamps depths to 0..4", () => {
    const r = store.getCallflow(A, ids.START, 99, 99);
    expect(new Set(r?.nodes.map((n) => n.id)).size).toBe(r?.nodes.length);
    expect(idsOf(r?.nodes)).toContain(ids.HELPER);
    const neg = store.getCallflow(A, ids.START, -5, Number.NaN);
    expect(neg?.nodes).toHaveLength(1);
  });

  it("returns undefined for a missing node", () => {
    expect(store.getCallflow(A, "sym:nope#x", 1, 1)).toBeUndefined();
  });
});

describe("getDeps", () => {
  it("imports direction includes externals", () => {
    const r = store.getDeps(A, "src/main.ts", "imports", 1);
    expect(idsOf(r?.nodes)).toEqual([
      "ext:npm:lodash",
      "file:src/core/engine.ts",
      "file:src/main.ts",
      "file:src/util.ts",
    ]);
    expect(r?.edges.every((e) => e.kind === "imports")).toBe(true);
    expect(r?.edges).toHaveLength(3);
  });

  it("importedBy and depth", () => {
    const d1 = store.getDeps(A, "src/util.ts", "importedBy", 1);
    expect(idsOf(d1?.nodes)).toEqual([
      "file:src/core/engine.ts",
      "file:src/main.ts",
      "file:src/util.ts",
    ]);
    const d2 = store.getDeps(A, "src/util.ts", "importedBy", 2);
    expect(idsOf(d2?.nodes)).toContain("file:tests/engine.test.ts");
    const both = store.getDeps(A, "src/core/engine.ts", "both", 1);
    expect(idsOf(both?.nodes)).toEqual([
      "file:src/core/engine.ts",
      "file:src/main.ts",
      "file:src/util.ts",
      "file:tests/engine.test.ts",
    ]);
  });

  it("undefined for missing files and for directories", () => {
    expect(store.getDeps(A, "nope.ts", "both", 1)).toBeUndefined();
    expect(store.getDeps(A, "src", "both", 1)).toBeUndefined();
  });
});

describe("cyclic graphs (up and down walks do not share visited state)", () => {
  const fnNode = (name: string) => ({
    id: `sym:c.ts#${name}`,
    kind: "function" as const,
    name,
    file: "c.ts",
  });
  const fileNode = (name: string) => ({
    id: `file:${name}.ts`,
    kind: "file" as const,
    name: `${name}.ts`,
    file: `${name}.ts`,
  });
  const edge = (src: string, dst: string, kind: "calls" | "imports") => ({
    src,
    dst,
    kind,
    confidence: "exact" as const,
  });

  it("getCallflow expands a node that is both caller and callee", () => {
    const s = openStore(":memory:");
    s.createAnalysis({ id: "c1", owner: "o", repo: "r", ref: "m", analyzerVersion: "1" });
    // A calls B, B calls C, B calls A.
    s.saveGraph("c1", {
      nodes: [fnNode("A"), fnNode("B"), fnNode("C")],
      edges: [
        edge("sym:c.ts#A", "sym:c.ts#B", "calls"),
        edge("sym:c.ts#B", "sym:c.ts#C", "calls"),
        edge("sym:c.ts#B", "sym:c.ts#A", "calls"),
      ],
      rollups: [],
      unresolved: [],
    });
    const r = s.getCallflow("c1", "sym:c.ts#A", 1, 2);
    expect(idsOf(r?.nodes)).toEqual(["sym:c.ts#A", "sym:c.ts#B", "sym:c.ts#C"]);
    s.close();
  });

  it("getDeps 'both' finds importers of a mutually importing file", () => {
    const s = openStore(":memory:");
    s.createAnalysis({ id: "c2", owner: "o", repo: "r", ref: "m", analyzerVersion: "1" });
    // a <-> b, d imports b.
    s.saveGraph("c2", {
      nodes: [fileNode("a"), fileNode("b"), fileNode("d")],
      edges: [
        edge("file:a.ts", "file:b.ts", "imports"),
        edge("file:b.ts", "file:a.ts", "imports"),
        edge("file:d.ts", "file:b.ts", "imports"),
      ],
      rollups: [],
      unresolved: [],
    });
    const both = s.getDeps("c2", "a.ts", "both", 2);
    expect(idsOf(both?.nodes)).toEqual(["file:a.ts", "file:b.ts", "file:d.ts"]);
    const importedBy = s.getDeps("c2", "a.ts", "importedBy", 2);
    expect(idsOf(importedBy?.nodes)).toEqual(idsOf(both?.nodes));
    s.close();
  });
});

describe("getSubgraph work is bounded on huge graphs", () => {
  it("stops collecting at the candidate limit and reports truncation", () => {
    const s = openStore(":memory:");
    s.createAnalysis({ id: "h1", owner: "o", repo: "r", ref: "m", analyzerVersion: "1" });
    // 60 dirs x 100 files x 10 functions = 60k symbol nodes.
    const nodes: GraphNode[] = [{ id: "dir:", kind: "directory", name: "root" }];
    for (let d = 0; d < 60; d++) {
      nodes.push({ id: `dir:d${d}`, kind: "directory", name: `d${d}`, parentId: "dir:" });
      for (let f = 0; f < 100; f++) {
        const path = `d${d}/f${f}.ts`;
        nodes.push({
          id: `file:${path}`,
          kind: "file",
          name: `f${f}.ts`,
          file: path,
          parentId: `dir:d${d}`,
        });
        for (let k = 0; k < 10; k++) {
          nodes.push({
            id: `sym:${path}#k${k}`,
            kind: "function",
            name: `k${k}`,
            file: path,
            parentId: `file:${path}`,
          });
        }
      }
    }
    s.saveGraph("h1", { nodes, edges: [], rollups: [], unresolved: [] });
    const start = performance.now();
    const r = s.getSubgraph(
      "h1",
      baseQuery({ level: "symbol", depth: 5, maxNodes: 200, maxEdges: 600 }),
    );
    const elapsed = performance.now() - start;
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(200);
    expect(r.nodes.some((n) => n.id === "dir:")).toBe(true);
    expect(elapsed).toBeLessThan(2000); // unbounded collection took many seconds
    s.close();
  });
});
