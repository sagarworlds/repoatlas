import type { FileExtraction, GraphEdge, RawReference, Unresolved } from "@repoatlas/schema";
import { fileId, symbolId } from "@repoatlas/schema";
import { makeEdge } from "../helpers.ts";
import type { ResolvedRef } from "./types.ts";

function edgeKindFor(ref: RawReference, resolved: ResolvedRef): GraphEdge["kind"] {
  switch (ref.kind) {
    case "extends":
      return "extends";
    case "implements":
      return "implements";
    case "type":
      return "references";
    default:
      // call / instantiate: a class used without a known constructor is only a reference.
      return resolved.asReference === true ? "references" : "calls";
  }
}

/** The edge source: the enclosing definition, or the file for top-level code. */
export function sourceNodeId(extraction: FileExtraction, ref: RawReference): string {
  return ref.fromLocalId === undefined
    ? fileId(extraction.file)
    : symbolId(extraction.file, ref.fromLocalId);
}

/** One edge per target (name-match can yield up to three). Unresolved refs yield none. */
export function toEdges(
  extraction: FileExtraction,
  ref: RawReference,
  resolved: ResolvedRef,
  fromNodeId?: string,
): GraphEdge[] {
  const src = fromNodeId ?? sourceNodeId(extraction, ref);
  const kind = edgeKindFor(ref, resolved);
  return resolved.targets.map((t) => makeEdge(src, t.nodeId, kind, t.confidence, ref.line));
}

/** Entry for `ResolutionResult.unresolved`. */
export function toUnresolved(extraction: FileExtraction, ref: RawReference): Unresolved {
  return { file: extraction.file, line: ref.line, name: ref.name, kind: ref.kind };
}

export interface ResolutionSummary {
  total: number;
  resolved: number;
  unresolved: number;
  /** Reason -> count; results without a reason are counted under "unknown". */
  byReason: Record<string, number>;
}

export function summariseResolution(results: Iterable<ResolvedRef>): ResolutionSummary {
  const summary: ResolutionSummary = { total: 0, resolved: 0, unresolved: 0, byReason: {} };
  for (const r of results) {
    summary.total++;
    if (r.targets.length > 0) {
      summary.resolved++;
      continue;
    }
    summary.unresolved++;
    const reason = r.reason ?? "unknown";
    summary.byReason[reason] = (summary.byReason[reason] ?? 0) + 1;
  }
  return summary;
}
