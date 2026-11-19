import { z } from "zod";

/** Bump on breaking schema changes; stored per analysis. */
export const SCHEMA_VERSION = 1;

export const NODE_KINDS = [
  "repo",
  "directory",
  "file",
  "module",
  "class",
  "interface",
  "function",
  "method",
  "external",
] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const LANGUAGE_IDS = [
  "typescript",
  "javascript",
  "python",
  "go",
  "java",
  "kotlin",
  "csharp",
  "rust",
  "php",
  "ruby",
  "c",
  "cpp",
] as const;
export const LanguageIdSchema = z.enum(LANGUAGE_IDS);
export type LanguageId = z.infer<typeof LanguageIdSchema>;

export const EDGE_KINDS = [
  "contains",
  "imports",
  "calls",
  "extends",
  "implements",
  "references",
] as const;
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const CONFIDENCES = ["exact", "inferred", "name-match"] as const;
export const ConfidenceSchema = z.enum(CONFIDENCES);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Higher number = more trustworthy. Used when merging duplicate edges. */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  "name-match": 0,
  inferred: 1,
  exact: 2,
};

export const SpanSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});
export type Span = z.infer<typeof SpanSchema>;

// `.loose()` keeps unknown keys: plugins may add namespaced keys like "py.decorators".
export const NodeMetaSchema = z
  .object({
    visibility: z.enum(["public", "protected", "private", "internal"]).optional(),
    isStatic: z.boolean().optional(),
    isAsync: z.boolean().optional(),
    isExported: z.boolean().optional(),
    isTest: z.boolean().optional(),
    isGenerated: z.boolean().optional(),
    ecosystem: z.string().optional(),
    loc: z.number().int().min(0).optional(),
  })
  .loose();
export type NodeMeta = z.infer<typeof NodeMetaSchema>;

export const MAX_SIGNATURE_LENGTH = 300;

export const GraphNodeSchema = z.object({
  id: z.string().min(1), // always has a prefix ("repo:", "dir:", ...), so never empty
  kind: NodeKindSchema,
  name: z.string(),
  qualifiedName: z.string().optional(),
  language: LanguageIdSchema.optional(),
  file: z.string().optional(),
  span: SpanSchema.optional(),
  signature: z.string().max(MAX_SIGNATURE_LENGTH).optional(),
  parentId: z.string().optional(),
  meta: NodeMetaSchema.optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const EdgeMetaSchema = z
  .object({
    alias: z.string().optional(),
    importedNames: z.array(z.string()).optional(),
    isDynamic: z.boolean().optional(),
    callCount: z.number().int().min(1).optional(),
    lines: z.array(z.number().int()).optional(),
  })
  .loose();
export type EdgeMeta = z.infer<typeof EdgeMetaSchema>;

export const GraphEdgeSchema = z.object({
  src: z.string(),
  dst: z.string(),
  kind: EdgeKindSchema,
  confidence: ConfidenceSchema,
  line: z.number().int().min(1).optional(),
  meta: EdgeMetaSchema.optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** Max number of call-site lines kept in `meta.lines` when merging duplicates. */
export const MAX_EDGE_LINES = 50;

/**
 * Merge duplicate edges: same (src, dst, kind) become one edge with
 * `meta.callCount`, `meta.lines` (capped) and the highest confidence seen.
 * Pure function; input order decides which `line` is kept (the first).
 */
export function mergeEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.kind}\u0000${edge.src}\u0000${edge.dst}`;
    const existing = merged.get(key);
    if (!existing) {
      const lines = edge.line !== undefined ? [edge.line] : [];
      merged.set(key, {
        ...edge,
        meta: { ...edge.meta, callCount: edge.meta?.callCount ?? 1, lines },
      });
      continue;
    }
    const meta = existing.meta ?? {};
    meta.callCount = (meta.callCount ?? 1) + (edge.meta?.callCount ?? 1);
    if (edge.line !== undefined && (meta.lines?.length ?? 0) < MAX_EDGE_LINES) {
      meta.lines = [...(meta.lines ?? []), edge.line];
    }
    if (CONFIDENCE_RANK[edge.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = edge.confidence;
    }
    existing.meta = meta;
  }
  return [...merged.values()];
}
