import type { Confidence, EdgeMeta, GraphEdge, GraphNode } from "@repoatlas/schema";
import { externalId, fileId } from "@repoatlas/schema";
import type { FileScope } from "./scope.ts";
import { compareText } from "./text.ts";

interface Accumulator {
  src: string;
  dst: string;
  line: number;
  confidence: Confidence;
  names: Set<string>;
  packages: Set<string>;
}

function addEdge(
  byKey: Map<string, Accumulator>,
  src: string,
  dst: string,
  line: number,
  confidence: Confidence,
  names: readonly string[],
  packageName: string | undefined,
): void {
  if (src === dst) return;
  const key = `${src}\u0000${dst}`;
  let acc = byKey.get(key);
  if (acc === undefined) {
    acc = { src, dst, line, confidence, names: new Set(), packages: new Set() };
    byKey.set(key, acc);
  } else {
    if (confidence === "exact") acc.confidence = "exact";
    acc.line = Math.min(acc.line, line);
  }
  for (const name of names) acc.names.add(name);
  if (packageName !== undefined && packageName !== "") acc.packages.add(packageName);
}

function toEdge(acc: Accumulator): GraphEdge {
  const meta: EdgeMeta = {};
  if (acc.names.size > 0) meta.importedNames = [...acc.names].sort(compareText);
  if (acc.packages.size > 0) {
    const packages = [...acc.packages].sort(compareText);
    meta.package = packages[0];
    meta.packages = packages;
  }
  const edge: GraphEdge = {
    src: acc.src,
    dst: acc.dst,
    kind: "imports",
    confidence: acc.confidence,
    line: acc.line,
  };
  if (Object.keys(meta).length > 0) edge.meta = meta;
  return edge;
}

/**
 * File-level `imports` edges, one per (file, target):
 * - internal single-type and static imports: `file -> file`, `exact` (decided by FQN lookup);
 * - wildcard imports: `file -> file` (`inferred`) for each file the wildcard was actually
 *   used for, which `scope.wildcardUses` records while references are resolved;
 * - everything else outside the repository: `file -> ext:maven:{key}` (`inferred`) with
 *   `meta.package` / `meta.packages` listing the Java packages involved.
 * Also returns the external nodes. Output is sorted.
 */
export function buildImportEdges(scopes: readonly FileScope[]): {
  imports: GraphEdge[];
  externals: GraphNode[];
} {
  const byKey = new Map<string, Accumulator>();
  for (const scope of scopes) {
    const src = fileId(scope.file);
    for (const outcome of scope.outcomes) {
      const target = outcome.target;
      if (target.kind === "file") {
        addEdge(
          byKey,
          src,
          fileId(target.file),
          outcome.line,
          "exact",
          outcome.importedNames,
          undefined,
        );
      } else if (target.kind === "external") {
        addEdge(
          byKey,
          src,
          externalId("maven", target.key),
          outcome.line,
          "inferred",
          outcome.importedNames,
          target.packageName,
        );
      }
    }
    for (const [file, line] of scope.wildcardUses) {
      addEdge(byKey, src, fileId(file), line, "inferred", [], undefined);
    }
  }
  const imports = [...byKey.values()]
    .map(toEdge)
    .sort((a, b) => compareText(a.src, b.src) || compareText(a.dst, b.dst));
  const externalIds = [
    ...new Set(imports.filter((e) => e.dst.startsWith("ext:")).map((e) => e.dst)),
  ];
  const externals: GraphNode[] = externalIds.sort(compareText).map((id) => ({
    id,
    kind: "external",
    name: id.slice("ext:maven:".length),
    meta: { ecosystem: "maven" },
  }));
  return { imports, externals };
}
