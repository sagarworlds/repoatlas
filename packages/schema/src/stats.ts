import { z } from "zod";
import { ConfidenceSchema, EdgeKindSchema, LanguageIdSchema, NodeKindSchema } from "./graph.ts";

export const AnalysisStatsSchema = z.object({
  schemaVersion: z.number().int(),
  analyzerVersion: z.string(),
  commitSha: z.string(),
  // Partial: only the languages detected in the repository are present.
  languages: z.partialRecord(
    LanguageIdSchema,
    z.object({
      files: z.number().int(),
      bytes: z.number().int(),
      pluginTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      // Optional so analyses stored before this field existed still validate.
      references: z.object({ total: z.number().int(), resolved: z.number().int() }).optional(),
    }),
  ),
  nodesByKind: z.partialRecord(NodeKindSchema, z.number().int()),
  edgesByKind: z.partialRecord(EdgeKindSchema, z.number().int()),
  edgesByConfidence: z.record(ConfidenceSchema, z.number().int()),
  references: z.object({
    total: z.number().int(),
    resolved: z.number().int(),
    unresolved: z.number().int(),
  }),
  skippedFiles: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  parseErrorFiles: z.number().int(),
  droppedInvalidEdges: z.number().int(),
  pluginErrors: z.array(z.object({ plugin: z.string(), stage: z.string(), message: z.string() })),
  truncated: z.boolean().optional(),
  timingsMs: z.record(z.string(), z.number()),
  // Per-file extraction cache counters; absent when the analysis ran without a cache.
  cache: z.object({ hits: z.number().int(), misses: z.number().int() }).optional(),
});
export type AnalysisStats = z.infer<typeof AnalysisStatsSchema>;

export const ANALYSIS_STATUSES = [
  "queued",
  "fetching",
  "parsing",
  "resolving",
  "persisting",
  "done",
  "failed",
] as const;
export const AnalysisStatusSchema = z.enum(ANALYSIS_STATUSES);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

export const ProgressSchema = z.object({
  phase: z.string(),
  filesDone: z.number().int(),
  filesTotal: z.number().int(),
});
export type Progress = z.infer<typeof ProgressSchema>;

/** Rollup rows for zoomed-out views (GRAPH_SCHEMA §6). */
export const RollupLevelSchema = z.enum(["dir", "file"]);
export type RollupLevel = z.infer<typeof RollupLevelSchema>;

export const RollupRowSchema = z.object({
  level: RollupLevelSchema,
  src: z.string(),
  dst: z.string(),
  kind: z.enum(["imports", "calls"]),
  weight: z.number().int().min(1),
  /**
   * Which edges the row counts. Omitted = all edges (includeTests true, minConfidence
   * "name-match"). `includeTests: false` skips edges touching a test file;
   * `minConfidence` counts only edges at or above that confidence.
   */
  includeTests: z.boolean().optional(),
  minConfidence: ConfidenceSchema.optional(),
});
export type RollupRow = z.infer<typeof RollupRowSchema>;
