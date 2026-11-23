import { type FileExtraction, FileExtractionSchema } from "@repoatlas/schema";

/**
 * Checks plugin output against the schema and against the file it was produced for.
 * Used for results from the main thread and (most importantly) from worker threads, whose
 * output is never trusted. Returns undefined for anything invalid.
 */
export function acceptExtraction(raw: unknown, filePath: string): FileExtraction | undefined {
  const parsed = FileExtractionSchema.safeParse(raw);
  return parsed.success && parsed.data.file === filePath ? parsed.data : undefined;
}
