import { z } from "zod";
import { ConfidenceSchema, EdgeKindSchema, LanguageIdSchema, NodeKindSchema } from "./graph.ts";

export const AnalysisStatsSchema = z.object({
  schemaVersion: z.number().int(),
  analyzerVersion: z.string(),
  commitSha: z.string(),
  languages: z.record(
    LanguageIdSchema,
    z.object({
      files: z.number().int(),
      bytes: z.number().int(),
      pluginTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
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
});
// `languages` is a partial map in practice (only detected languages are present).
export type AnalysisStats = Omit<z.infer<typeof AnalysisStatsSchema>, "languages"> & {
  languages: Partial<z.infer<typeof AnalysisStatsSchema>["languages"]>;
};

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
});
export type RollupRow = z.infer<typeof RollupRowSchema>;
