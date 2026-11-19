import type { AnalysisRecord, GraphStore } from "@repoatlas/store";
import { z } from "zod";
import { apiError } from "../errors.ts";
import { decodeError } from "../jobs/storage.ts";

/** `:id` path parameter. Ids are opaque; an unknown or malformed one is simply not found. */
export const AnalysisIdParams = z.object({ id: z.string().min(1).max(64) });

/**
 * Looks up an analysis that must be finished. 404 if unknown, 409 if still running or failed.
 * Graph, node, callflow, deps, search and source all go through this.
 */
export function requireDoneAnalysis(store: GraphStore, id: string): AnalysisRecord {
  const analysis = store.getAnalysis(id);
  if (!analysis) throw apiError("ANALYSIS_NOT_FOUND", "Analysis not found.");
  if (analysis.status === "failed") {
    throw apiError("ANALYSIS_NOT_READY", "The analysis failed; there is no graph to query.");
  }
  if (analysis.status !== "done") {
    throw apiError("ANALYSIS_NOT_READY", `The analysis is not finished yet (${analysis.status}).`);
  }
  return analysis;
}

/** Public JSON of an analysis (docs/API.md `GET /api/analyses/:id`). */
export function toAnalysisJson(record: AnalysisRecord) {
  return {
    id: record.id,
    owner: record.owner,
    repo: record.repo,
    ref: record.ref,
    commitSha: record.commitSha,
    status: record.status,
    progress: record.progress,
    stats: record.stats,
    error: decodeError(record.error),
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
  };
}

/** Comma-separated list of allowed values, e.g. `edgeKinds=imports,calls`. */
export function csvOf<T extends string>(allowed: readonly T[]) {
  return z
    .string()
    .max(300)
    .transform((value, ctx): T[] => {
      const parts = value
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const result: T[] = [];
      for (const part of parts) {
        const match = allowed.find((a) => a === part);
        if (match === undefined) {
          ctx.addIssue({ code: "custom", message: `unknown value "${part.slice(0, 40)}"` });
          return z.NEVER;
        }
        result.push(match);
      }
      return result;
    });
}

/** `true` / `false` query flag. */
export const queryFlag = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v === "true");

/** Integer query parameter that is clamped into [min, max] instead of rejected. */
export function clampedInt(min: number, max: number, def: number) {
  return z.coerce
    .number()
    .int()
    .optional()
    .transform((v) => Math.min(max, Math.max(min, v ?? def)));
}

/** A node id or file path passed as a query parameter. */
export const idParam = z.string().min(1).max(1000).refine(hasNoControlChars, {
  message: "Control characters are not allowed.",
});

/** True when the text contains no control characters (U+0000 to U+001F). */
export function hasNoControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x20) return false;
  }
  return true;
}
