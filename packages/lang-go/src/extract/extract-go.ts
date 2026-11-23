import type { FileExtraction } from "@repoatlas/schema";
import { type ExtractOptions, extractWithSpec } from "@repoatlas/treesitter";
import { goSpec } from "../spec/go-spec.ts";

/**
 * Extracts definitions, imports and references from one Go file (Tier 1, tree-sitter).
 * Never throws for bad syntax: broken code gives `parseErrors > 0` and best-effort results.
 * A leading byte-order mark is removed before parsing.
 */
export async function extractGo(
  file: { path: string; content: string },
  options: ExtractOptions = {},
): Promise<FileExtraction> {
  const content = file.content.startsWith("﻿") ? file.content.slice(1) : file.content;
  return extractWithSpec(goSpec, { path: file.path, content }, options);
}
