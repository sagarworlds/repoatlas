// Pure helpers for the detail panel (no React), so they can be unit tested.
import type { AnalysisRecordDto, AnalysisStats, GraphNode, NodeKind } from "../../api/types.ts";
import { buildGithubBlobUrl } from "../../lib/github.ts";
import type { ExplorerParams } from "../url-state.ts";

const KIND_LABELS: Record<NodeKind, string> = {
  repo: "Repository",
  directory: "Directory",
  file: "File",
  module: "Module",
  class: "Class",
  interface: "Interface",
  function: "Function",
  method: "Method",
  external: "External package",
};

export function kindLabel(kind: NodeKind): string {
  return KIND_LABELS[kind];
}

/** "12-40", "12" for a one-line span, undefined without a span. */
export function lineRange(node: GraphNode): string | undefined {
  if (!node.span) return undefined;
  const { startLine, endLine } = node.span;
  return endLine > startLine ? `${startLine}–${endLine}` : String(startLine);
}

/** "src/a.ts:12-40" / "src/a.ts"; undefined for nodes without a file. */
export function locationText(node: GraphNode): string | undefined {
  if (node.file === undefined) return undefined;
  const lines = lineRange(node);
  return lines === undefined ? node.file : `${node.file}:${lines}`;
}

/** Link to the node on GitHub (pinned to the analysed commit); undefined without a file. */
export function githubUrlForNode(
  analysis: Pick<AnalysisRecordDto, "owner" | "repo" | "ref" | "commitSha">,
  node: GraphNode,
): string | undefined {
  if (node.file === undefined) return undefined;
  return buildGithubBlobUrl(
    analysis.owner,
    analysis.repo,
    analysis.commitSha ?? analysis.ref,
    node.file,
    node.span?.startLine,
    node.span?.endLine,
  );
}

export interface CountLink {
  key: "callers" | "callees" | "imports" | "importedBy";
  label: string;
  count: number;
  /** State patch to apply when clicked; undefined when there is nothing to open. */
  patch: Partial<ExplorerParams> | undefined;
}

/** The four relation counts, each with the tab it opens (callers/callees -> flow, imports -> deps). */
export function countLinks(
  node: GraphNode,
  counts: { callers: number; callees: number; importedBy: number; imports: number },
): CountLink[] {
  const flow = { tab: "flow", node: node.id, hl: undefined } as const;
  const deps = node.file !== undefined ? ({ tab: "deps", file: node.file } as const) : undefined;
  return [
    {
      key: "callers",
      label: "Callers",
      count: counts.callers,
      patch: counts.callers > 0 ? flow : undefined,
    },
    {
      key: "callees",
      label: "Callees",
      count: counts.callees,
      patch: counts.callees > 0 ? flow : undefined,
    },
    {
      key: "imports",
      label: "Imports",
      count: counts.imports,
      patch: counts.imports > 0 ? deps : undefined,
    },
    {
      key: "importedBy",
      label: "Imported by",
      count: counts.importedBy,
      patch: counts.importedBy > 0 ? deps : undefined,
    },
  ];
}

/** Share of references that were resolved to a target (0-1); undefined when there were none. */
export function resolutionRate(stats: AnalysisStats): number | undefined {
  const { total, resolved } = stats.references;
  return total > 0 ? resolved / total : undefined;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
