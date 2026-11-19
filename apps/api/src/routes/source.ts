import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RouteContext, ZodApp } from "../context.ts";
import { ApiError, apiError } from "../errors.ts";
import { sourcesDirFor } from "../jobs/storage.ts";
import { AnalysisIdParams, idParam, requireDoneAnalysis } from "./helpers.ts";

/** The source endpoint never returns more than this (docs/API.md: max 1 MB). */
export const MAX_SOURCE_BYTES = 1_048_576;

const SourceQuery = z.object({
  file: idParam,
  start: z.coerce.number().int().min(1).optional(),
  end: z.coerce.number().int().min(1).optional(),
});

const notFound = () => apiError("FILE_NOT_FOUND", "File not found in this analysis.");

/** Cheap pre-filter. The database lookup below is the real authority. */
function looksLikeRepoPath(file: string): boolean {
  if (file.includes("\0") || file.includes("\\") || file.startsWith("/")) return false;
  return file.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function registerSourceRoutes(app: ZodApp, ctx: RouteContext): void {
  const { store, config } = ctx;

  app.get(
    "/api/analyses/:id/source",
    { schema: { params: AnalysisIdParams, querystring: SourceQuery } },
    async (request) => {
      const analysis = requireDoneAnalysis(store, request.params.id);
      const { file, start, end } = request.query;

      // 1. Only files that are `file` nodes of THIS analysis can be served.
      if (!looksLikeRepoPath(file)) throw notFound();
      const fileNode = store.getFileNode(analysis.id, file);
      if (!fileNode || !analysis.commitSha) throw notFound();

      // 2. Only then is the path built, and it must stay inside the sources directory.
      const root = sourcesDirFor(config.dataDir, analysis.commitSha);
      const absolute = path.resolve(root, ...file.split("/"));
      if (!isInside(root, absolute)) throw notFound();

      let text: string;
      try {
        // realpath defeats symlinks (the extractor never creates any, but be defensive).
        const real = await realpath(absolute);
        if (!isInside(await realpath(root), real)) throw notFound();
        const info = await stat(real);
        if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw notFound();
        text = await readFile(real, "utf8");
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw notFound(); // missing file (e.g. sources evicted) or unreadable
      }

      const lines = text.split(/\r\n|\r|\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
      const totalLines = lines.length;

      const startLine = start ?? 1;
      const endLine = Math.min(end ?? totalLines, totalLines);
      if (totalLines > 0 && (startLine > endLine || startLine > totalLines)) {
        throw apiError(
          "VALIDATION_ERROR",
          "Invalid request. start must not exceed end or the file length.",
        );
      }
      const slice = totalLines === 0 ? [] : lines.slice(startLine - 1, endLine);

      return {
        file,
        language: fileNode.language ?? null,
        startLine: totalLines === 0 ? 0 : startLine,
        endLine: totalLines === 0 ? 0 : endLine,
        totalLines,
        // Line endings are normalized to \n.
        content: slice.join("\n"),
      };
    },
  );
}
