import type { GraphEdge, GraphNode, RollupRow } from "@repoatlas/schema";
import type { GraphData, SubgraphQuery } from "./types.ts";

// Hand-built fixture used by the store tests (not exported from the package).
const file = (path: string, loc: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  id: `file:${path}`,
  kind: "file",
  name: path.split("/").pop() ?? path,
  file: path,
  language: "typescript",
  parentId: path.includes("/") ? `dir:${path.slice(0, path.lastIndexOf("/"))}` : "dir:",
  meta: { loc },
  ...extra,
});

const dir = (path: string, parentId: string, meta?: GraphNode["meta"]): GraphNode => ({
  id: `dir:${path}`,
  kind: "directory",
  name: path === "" ? "(root)" : (path.split("/").pop() ?? path),
  parentId,
  ...(meta ? { meta } : {}),
});

const sym = (
  path: string,
  local: string,
  kind: GraphNode["kind"],
  parentId: string,
  startLine: number,
): GraphNode => ({
  id: `sym:${path}#${local}`,
  kind,
  name: local.split(".").pop() ?? local,
  qualifiedName: local,
  file: path,
  span: { startLine, endLine: startLine + 5 },
  signature: `${local}()`,
  parentId,
});

const contains = (n: GraphNode): GraphEdge[] =>
  n.parentId ? [{ src: n.parentId, dst: n.id, kind: "contains", confidence: "exact" }] : [];

const nodes: GraphNode[] = [
  { id: "repo:", kind: "repo", name: "demo" },
  dir("", "repo:"),
  dir("src", "dir:"),
  dir("src/core", "dir:src"),
  dir("tests", "dir:", { isTest: true }),
  file("src/main.ts", 50),
  file("src/util.ts", 30),
  file("src/core/engine.ts", 100),
  file("tests/engine.test.ts", 20, { meta: { loc: 20, isTest: true } }),
  sym("src/main.ts", "start", "function", "file:src/main.ts", 3),
  sym("src/util.ts", "helper", "function", "file:src/util.ts", 1),
  sym("src/core/engine.ts", "Engine", "class", "file:src/core/engine.ts", 1),
  sym("src/core/engine.ts", "Engine.stop", "method", "sym:src/core/engine.ts#Engine", 20),
  sym("src/core/engine.ts", "Engine.run", "method", "sym:src/core/engine.ts#Engine", 10),
  sym("tests/engine.test.ts", "testRun", "function", "file:tests/engine.test.ts", 2),
  { id: "ext:npm:lodash", kind: "external", name: "lodash", meta: { ecosystem: "npm" } },
];

const call = (
  from: string,
  to: string,
  confidence: GraphEdge["confidence"],
  line: number,
): GraphEdge => ({ src: from, dst: to, kind: "calls", confidence, line });
const imp = (from: string, to: string): GraphEdge => ({
  src: from,
  dst: to,
  kind: "imports",
  confidence: "exact",
});

const START = "sym:src/main.ts#start";
const HELPER = "sym:src/util.ts#helper";
const RUN = "sym:src/core/engine.ts#Engine.run";
const STOP = "sym:src/core/engine.ts#Engine.stop";
const TEST_RUN = "sym:tests/engine.test.ts#testRun";

const edges: GraphEdge[] = [
  ...nodes.flatMap(contains),
  imp("file:src/main.ts", "file:src/core/engine.ts"),
  imp("file:src/main.ts", "file:src/util.ts"),
  imp("file:src/core/engine.ts", "file:src/util.ts"),
  imp("file:src/main.ts", "ext:npm:lodash"),
  imp("file:tests/engine.test.ts", "file:src/core/engine.ts"),
  call(START, RUN, "exact", 5),
  call(START, HELPER, "inferred", 6),
  call(RUN, HELPER, "name-match", 12),
  call(HELPER, START, "exact", 2), // cycle: start -> helper -> start
  call(RUN, STOP, "exact", 14),
  call(TEST_RUN, RUN, "exact", 3),
];

const fileRollup = (src: string, dst: string): RollupRow => ({
  level: "file",
  src: `file:${src}`,
  dst: `file:${dst}`,
  kind: "imports",
  weight: 1,
});

const rollups: RollupRow[] = [
  { level: "dir", src: "dir:src", dst: "dir:src/core", kind: "imports", weight: 3 },
  { level: "dir", src: "dir:src/core", dst: "dir:src", kind: "imports", weight: 1 },
  { level: "dir", src: "dir:src", dst: "dir:src/core", kind: "calls", weight: 2 },
  { level: "dir", src: "dir:tests", dst: "dir:src/core", kind: "imports", weight: 1 },
  fileRollup("src/main.ts", "src/core/engine.ts"),
  fileRollup("src/main.ts", "src/util.ts"),
  fileRollup("src/core/engine.ts", "src/util.ts"),
  fileRollup("tests/engine.test.ts", "src/core/engine.ts"),
];

/**
 * The pipeline emits one rollup row per variant (tests included or not x min confidence).
 * Here every demo edge is exact, and rows that touch the `tests` area are test edges.
 */
function withVariants(base: RollupRow[]): RollupRow[] {
  const out: RollupRow[] = [];
  for (const row of base) {
    const touchesTests = row.src.includes("tests") || row.dst.includes("tests");
    for (const includeTests of [true, false]) {
      if (!includeTests && touchesTests) continue;
      for (const minConfidence of ["exact", "inferred", "name-match"] as const) {
        if (includeTests && minConfidence === "name-match") out.push(row);
        else out.push({ ...row, includeTests, minConfidence });
      }
    }
  }
  return out;
}

export const ids = { START, HELPER, RUN, STOP, TEST_RUN };

export function demoGraph(): GraphData {
  return {
    nodes: [...nodes],
    edges: [...edges],
    rollups: withVariants(rollups),
    unresolved: [{ file: "src/main.ts", line: 9, name: "mystery", kind: "calls" }],
  };
}

export function baseQuery(overrides: Partial<SubgraphQuery> = {}): SubgraphQuery {
  return {
    level: "dir",
    root: "dir:",
    depth: 3,
    edgeKinds: ["imports", "calls"],
    includeTests: true,
    includeExternal: false,
    minConfidence: "name-match",
    maxNodes: 2000,
    maxEdges: 6000,
    ...overrides,
  };
}
