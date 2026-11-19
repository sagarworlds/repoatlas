import { z } from "zod";
import {
  GraphEdgeSchema,
  GraphNodeSchema,
  LanguageIdSchema,
  NodeMetaSchema,
  SpanSchema,
} from "./graph.ts";

/** Types emitted by language plugins (GRAPH_SCHEMA §4). */

export const DefinitionSchema = z.object({
  localId: z.string().min(1),
  kind: z.enum(["class", "interface", "function", "method"]),
  name: z.string(),
  parentLocalId: z.string().optional(),
  span: SpanSchema,
  signature: z.string().optional(),
  meta: NodeMetaSchema.optional(),
});
export type Definition = z.infer<typeof DefinitionSchema>;

export const RawImportSchema = z.object({
  line: z.number().int().min(1),
  specifier: z.string(),
  kind: z.enum(["module", "named", "wildcard", "side-effect", "dynamic"]),
  names: z.array(z.object({ name: z.string(), alias: z.string().optional() })).optional(),
  alias: z.string().optional(),
  isRelative: z.boolean().optional(),
});
export type RawImport = z.infer<typeof RawImportSchema>;

export const RawReferenceSchema = z.object({
  line: z.number().int().min(1),
  kind: z.enum(["call", "extends", "implements", "type", "instantiate"]),
  fromLocalId: z.string().optional(),
  name: z.string(),
  receiver: z.string().optional(),
  receiverKind: z.enum(["self", "super", "identifier", "member-chain", "call", "other"]).optional(),
  argCount: z.number().int().min(0).optional(),
});
export type RawReference = z.infer<typeof RawReferenceSchema>;

export const FileExtractionSchema = z.object({
  file: z.string(),
  language: LanguageIdSchema,
  definitions: z.array(DefinitionSchema),
  imports: z.array(RawImportSchema),
  references: z.array(RawReferenceSchema),
  parseErrors: z.number().int().min(0),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type FileExtraction = z.infer<typeof FileExtractionSchema>;

export const UnresolvedSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  name: z.string(),
  kind: z.string(),
});
export type Unresolved = z.infer<typeof UnresolvedSchema>;

export const ResolutionResultSchema = z.object({
  imports: z.array(GraphEdgeSchema),
  edges: z.array(GraphEdgeSchema),
  externals: z.array(GraphNodeSchema),
  modules: z.array(GraphNodeSchema).optional(),
  unresolved: z.array(UnresolvedSchema),
});
export type ResolutionResult = z.infer<typeof ResolutionResultSchema>;
