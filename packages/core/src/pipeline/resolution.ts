import type { LanguagePlugin, RepoView, SymbolIndex } from "@repoatlas/plugin-api";
import {
  type FileExtraction,
  type GraphEdge,
  GraphEdgeSchema,
  type GraphNode,
  GraphNodeSchema,
  type Unresolved,
  UnresolvedSchema,
} from "@repoatlas/schema";
import { AnalysisError } from "../errors.ts";
import type { PipelineContext } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { PluginRun } from "./extract.ts";

/** A plugin's resolution after every item was checked against the schema. */
export interface SanitizedResolution {
  /** `imports` and `edges` of the plugin together. */
  edges: GraphEdge[];
  /** External and module nodes. */
  nodes: GraphNode[];
  unresolved: Unresolved[];
  /** Edges that failed schema validation (they count as dropped invalid edges). */
  invalidEdges: number;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function field(raw: unknown, name: string): unknown {
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Plugin output is untrusted: every edge, node and unresolved entry is parsed on its own,
 * so one bad item never throws away the rest.
 */
export function sanitizeResolution(
  plugin: string,
  raw: unknown,
  diagnostics: Diagnostics,
): SanitizedResolution {
  const edges: GraphEdge[] = [];
  let invalidEdges = 0;
  for (const item of [...asArray(field(raw, "imports")), ...asArray(field(raw, "edges"))]) {
    const parsed = GraphEdgeSchema.safeParse(item);
    if (parsed.success) edges.push(parsed.data);
    else invalidEdges++;
  }

  const nodes: GraphNode[] = [];
  let invalidNodes = 0;
  for (const item of [...asArray(field(raw, "externals")), ...asArray(field(raw, "modules"))]) {
    const parsed = GraphNodeSchema.safeParse(item);
    if (parsed.success && (parsed.data.kind === "external" || parsed.data.kind === "module")) {
      nodes.push(parsed.data);
    } else {
      invalidNodes++;
    }
  }

  const unresolved: Unresolved[] = [];
  let invalidUnresolved = 0;
  for (const item of asArray(field(raw, "unresolved"))) {
    const parsed = UnresolvedSchema.safeParse(item);
    if (parsed.success) unresolved.push(parsed.data);
    else invalidUnresolved++;
  }

  if (invalidNodes > 0) {
    diagnostics.addPluginError(
      plugin,
      "validate",
      `dropped ${invalidNodes} invalid external/module nodes`,
    );
  }
  if (invalidUnresolved > 0) {
    diagnostics.addPluginError(
      plugin,
      "validate",
      `dropped ${invalidUnresolved} invalid unresolved entries`,
    );
  }
  return { edges, nodes, unresolved, invalidEdges };
}

/** Gets the plugin's resolution: already known (analyzeProject) or via `plugin.resolve`. */
export async function resolvePlugin(
  run: PluginRun,
  index: SymbolIndex,
  repo: RepoView,
  ctx: PipelineContext,
  diagnostics: Diagnostics,
): Promise<SanitizedResolution> {
  const plugin: LanguagePlugin = run.plugin;
  let raw: unknown = run.resolution;
  if (raw === undefined) {
    try {
      raw = await plugin.resolve({
        extractions: run.extractions as FileExtraction[],
        index,
        info: run.info,
        repo,
      });
    } catch (err) {
      if (err instanceof AnalysisError && (err.code === "CANCELLED" || err.code === "TIMEOUT")) {
        throw err;
      }
      diagnostics.addPluginError(plugin.id, "resolve", err);
      raw = {};
    }
  }
  ctx.check();
  return sanitizeResolution(plugin.id, raw, diagnostics);
}
