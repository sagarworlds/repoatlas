import {
  type FileExtraction,
  fileId,
  type GraphEdge,
  type GraphNode,
  MAX_SIGNATURE_LENGTH,
  symbolId,
} from "@repoatlas/schema";
import { compareCodeUnits } from "./util.ts";

export interface SymbolBuild {
  nodes: GraphNode[];
  /** `contains` edges: file -> top-level symbol, class -> method, parent -> nested symbol. */
  edges: GraphEdge[];
  /** True when `maxNodes` was reached and later definitions were dropped. */
  truncated: boolean;
}

/**
 * Turns the definitions of every extraction into symbol nodes plus `contains` edges.
 * Extractions are processed in file order and definitions in (line, localId) order, so the
 * output is deterministic. A definition whose localId already exists in the same file is
 * ignored (first one wins); an unknown `parentLocalId` falls back to the file node.
 */
export function buildSymbolNodes(
  extractions: readonly FileExtraction[],
  maxNodes: number,
): SymbolBuild {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sorted = [...extractions].sort((a, b) => compareCodeUnits(a.file, b.file));

  for (const extraction of sorted) {
    const definitions = [...extraction.definitions].sort(
      (a, b) => a.span.startLine - b.span.startLine || compareCodeUnits(a.localId, b.localId),
    );
    const knownLocalIds = new Set(definitions.map((d) => d.localId));
    const added = new Set<string>();

    for (const def of definitions) {
      if (added.has(def.localId)) continue;
      if (nodes.length >= maxNodes) return { nodes, edges, truncated: true };
      added.add(def.localId);

      const id = symbolId(extraction.file, def.localId);
      const hasParent =
        def.parentLocalId !== undefined &&
        def.parentLocalId !== def.localId &&
        knownLocalIds.has(def.parentLocalId);
      const parentId = hasParent
        ? symbolId(extraction.file, def.parentLocalId as string)
        : fileId(extraction.file);

      const node: GraphNode = {
        id,
        kind: def.kind,
        name: def.name,
        qualifiedName: def.localId,
        language: extraction.language,
        file: extraction.file,
        span: def.span,
        parentId,
        meta: { loc: def.span.endLine - def.span.startLine + 1, ...def.meta },
      };
      if (def.signature !== undefined)
        node.signature = def.signature.slice(0, MAX_SIGNATURE_LENGTH);
      nodes.push(node);
      edges.push({ src: parentId, dst: id, kind: "contains", confidence: "exact" });
    }
  }
  return { nodes, edges, truncated: false };
}
