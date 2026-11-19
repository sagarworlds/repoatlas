import {
  CONFIDENCE_RANK,
  CONFIDENCES,
  type Confidence,
  dirId,
  fileId,
  type GraphEdge,
  type GraphNode,
  type RollupRow,
} from "@repoatlas/schema";

type RollupKind = RollupRow["kind"];

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Directory paths above a file, outermost first, excluding the root: "a/b/c.ts" -> ["a","a/b"]. */
export function ancestorDirs(filePath: string): string[] {
  const parts = filePath.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(0, i + 1).join("/"));
  return out;
}

/** True when directory path `outer` is a strict ancestor of directory path `inner`. */
function isAncestorDir(outer: string, inner: string): boolean {
  return inner.startsWith(`${outer}/`);
}

function addWeight(map: Map<string, number>, key: string, weight: number): void {
  map.set(key, (map.get(key) ?? 0) + weight);
}

const SEP = "\u0000";

/**
 * Aggregated views (GRAPH_SCHEMA §6). Only `imports` and `calls` edges between two
 * different files count. Endpoints are mapped to their file; repo/dir/module/external
 * endpoints are ignored. Directory rows exclude pairs where one directory contains the
 * other (so the root directory never appears).
 *
 * Every (src, dst, kind) is emitted once per variant: includeTests (true/false) x
 * minConfidence (exact / inferred / name-match). The default variant (tests included,
 * name-match) has no variant fields; the others set both, so the store can answer
 * `includeTests` and `minConfidence` queries without touching the edges.
 */
export function computeRollups(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): RollupRow[] {
  // node id -> repo-relative file path, for file and symbol nodes only.
  const fileOf = new Map<string, string>();
  const testFiles = new Set<string>();
  for (const node of nodes) {
    if (node.file === undefined) continue;
    if (node.kind === "file") {
      fileOf.set(node.id, node.file);
      if (node.meta?.isTest === true) testFiles.add(node.file);
    } else if (
      node.kind === "class" ||
      node.kind === "interface" ||
      node.kind === "function" ||
      node.kind === "method"
    ) {
      fileOf.set(node.id, node.file);
    }
  }

  // key = variant SEP kind SEP srcFile SEP dstFile
  const fileWeights = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "imports" && edge.kind !== "calls") continue;
    const srcFile = fileOf.get(edge.src);
    const dstFile = fileOf.get(edge.dst);
    if (srcFile === undefined || dstFile === undefined || srcFile === dstFile) continue;
    const weight = edge.kind === "calls" ? (edge.meta?.callCount ?? 1) : 1;
    const touchesTest = testFiles.has(srcFile) || testFiles.has(dstFile);
    for (const includeTests of [true, false]) {
      if (!includeTests && touchesTest) continue;
      for (const minConfidence of CONFIDENCES) {
        if (CONFIDENCE_RANK[edge.confidence] < CONFIDENCE_RANK[minConfidence]) continue;
        const variant = `${includeTests ? "t" : "n"}${minConfidence}`;
        addWeight(fileWeights, [variant, edge.kind, srcFile, dstFile].join(SEP), weight);
      }
    }
  }

  const dirWeights = new Map<string, number>();
  const rows: RollupRow[] = [];
  for (const [key, weight] of fileWeights) {
    const [variant, kind, srcFile, dstFile] = key.split(SEP) as [
      string,
      RollupKind,
      string,
      string,
    ];
    const fileRow: RollupRow = {
      level: "file",
      src: fileId(srcFile),
      dst: fileId(dstFile),
      kind,
      weight,
    };
    rows.push(withVariant(fileRow, variant));

    const dstDirs = ancestorDirs(dstFile);
    for (const a of ancestorDirs(srcFile)) {
      for (const b of dstDirs) {
        if (a === b || isAncestorDir(a, b) || isAncestorDir(b, a)) continue;
        addWeight(dirWeights, [variant, kind, a, b].join(SEP), weight);
      }
    }
  }
  for (const [key, weight] of dirWeights) {
    const [variant, kind, a, b] = key.split(SEP) as [string, RollupKind, string, string];
    const dirRow: RollupRow = { level: "dir", src: dirId(a), dst: dirId(b), kind, weight };
    rows.push(withVariant(dirRow, variant));
  }

  return rows.sort(
    (x, y) =>
      compareCodeUnits(x.level, y.level) ||
      compareCodeUnits(x.kind, y.kind) ||
      compareCodeUnits(x.src, y.src) ||
      compareCodeUnits(x.dst, y.dst) ||
      compareCodeUnits(variantKey(x), variantKey(y)),
  );
}

/** Variant = "t"/"n" (tests included or not) + minimum confidence; the default has no fields. */
function withVariant(row: RollupRow, variant: string): RollupRow {
  const includeTests = variant.startsWith("t");
  const minConfidence = variant.slice(1) as Confidence;
  if (includeTests && minConfidence === "name-match") return row;
  return { ...row, includeTests, minConfidence };
}

function variantKey(row: RollupRow): string {
  return `${row.includeTests === false ? "n" : "t"}${row.minConfidence ?? "name-match"}`;
}
