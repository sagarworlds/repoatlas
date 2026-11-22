import type { Confidence, EdgeMeta, FileExtraction, GraphEdge, GraphNode } from "@repoatlas/schema";
import { fileId, parseId } from "@repoatlas/schema";
import type { ImportOutcome, ImportTarget } from "./imports.ts";

interface Accumulator {
  src: string;
  dst: string;
  line: number;
  confidence: Confidence;
  names: Set<string>;
  alias?: string;
  allDynamic: boolean;
  allReexport: boolean;
  stdlibModules: Set<string>;
}

function better(a: Confidence, b: Confidence): Confidence {
  return a === "exact" || b === "exact" ? "exact" : a;
}

function addTarget(
  byKey: Map<string, Accumulator>,
  src: string,
  line: number,
  target: ImportTarget,
): void {
  if (target.dst === src) return; // `from . import x` inside the package's own __init__.py
  const key = `${src}\u0000${target.dst}`;
  let acc = byKey.get(key);
  if (!acc) {
    acc = {
      src,
      dst: target.dst,
      line,
      confidence: target.confidence,
      names: new Set(),
      allDynamic: true,
      allReexport: true,
      stdlibModules: new Set(),
    };
    byKey.set(key, acc);
  } else {
    acc.confidence = better(acc.confidence, target.confidence);
    acc.line = Math.min(acc.line, line);
  }
  for (const name of target.names) acc.names.add(name);
  acc.alias ??= target.alias;
  acc.allDynamic &&= target.dynamic;
  acc.allReexport &&= target.reexport;
  if (target.stdlibModule !== undefined) acc.stdlibModules.add(target.stdlibModule);
}

function toEdge(acc: Accumulator): GraphEdge {
  const meta: EdgeMeta = {};
  if (acc.names.size > 0) meta.importedNames = [...acc.names].sort();
  if (acc.alias !== undefined) meta.alias = acc.alias;
  if (acc.allDynamic) meta.isDynamic = true;
  if (acc.allReexport && acc.names.size > 0) meta.isReexport = true;
  if (acc.stdlibModules.size > 0) {
    const modules = [...acc.stdlibModules].sort();
    meta.package = modules[0];
    meta.packages = modules;
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

function externalNode(id: string): GraphNode {
  const parsed = parseId(id);
  const name = parsed?.kind === "external" ? parsed.pkg : id;
  return { id, kind: "external", name, meta: { ecosystem: "pypi" } };
}

/**
 * Merges the per-statement outcomes into file-level `imports` edges: one edge per
 * (file, target), with the first line, the best confidence, the union of imported names and
 * the alias. Also returns the external nodes that those edges point to. Output is sorted.
 */
export function buildImportEdges(
  extractions: readonly FileExtraction[],
  outcomes: Map<string, ImportOutcome[]>,
): { imports: GraphEdge[]; externals: GraphNode[] } {
  const byKey = new Map<string, Accumulator>();
  for (const extraction of extractions) {
    const list = outcomes.get(extraction.file) ?? [];
    const src = fileId(extraction.file);
    extraction.imports.forEach((imp, i) => {
      for (const target of list[i]?.targets ?? []) addTarget(byKey, src, imp.line, target);
    });
  }
  const imports = [...byKey.values()]
    .map(toEdge)
    .sort((a, b) => (a.src === b.src ? (a.dst < b.dst ? -1 : 1) : a.src < b.src ? -1 : 1));
  const externalIds = new Set(imports.filter((e) => e.dst.startsWith("ext:")).map((e) => e.dst));
  const externals = [...externalIds].sort().map(externalNode);
  return { imports, externals };
}
