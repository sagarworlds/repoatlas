import type { GraphEdge, LanguageId, Unresolved } from "@repoatlas/schema";
import type { PluginRun } from "./extract.ts";

export interface ReferenceCounts {
  total: number;
  resolved: number;
  unresolved: number;
}

/** Everything needed to attribute a plugin's edges and unresolved entries to a language. */
export interface ReferenceLookup {
  /** File path -> language, for every file kept in the graph. */
  languageOfFile: ReadonlyMap<string, LanguageId | undefined>;
  /** Node id -> repo-relative file path (symbol and file nodes). */
  fileOfNode: ReadonlyMap<string, string>;
}

function bump(map: Map<LanguageId, ReferenceCounts>, language: LanguageId): ReferenceCounts {
  const entry = map.get(language) ?? { total: 0, resolved: 0, unresolved: 0 };
  map.set(language, entry);
  return entry;
}

/**
 * Reference statistics of one plugin run, split by language.
 *
 * - resolved: surviving `calls` edges before merging (one per call site, `callCount`),
 *   attributed to the language of the edge's source file.
 * - unresolved: unresolved entries of kind "call", attributed to the entry's file.
 * - total: resolved + unresolved, for every tier. References that cannot be resolved inside
 *   the repository by design are left out of both numbers: calls into external packages,
 *   builtins and builtin-type methods (len, print, dict.get, ...) and calls through a
 *   parameter. They are neither resolved nor unresolved, so the rate measures how many of
 *   the references that *could* be found in the repository were found.
 */
export function referenceCountsByLanguage(
  run: PluginRun,
  keptEdges: readonly GraphEdge[],
  unresolved: readonly Unresolved[],
  lookup: ReferenceLookup,
): Map<LanguageId, ReferenceCounts> {
  const fallback = run.plugin.languages[0];
  const out = new Map<LanguageId, ReferenceCounts>();
  if (fallback === undefined) return out;
  const languageOfPath = (path: string | undefined): LanguageId =>
    (path === undefined ? undefined : lookup.languageOfFile.get(path)) ?? fallback;

  for (const edge of keptEdges) {
    if (edge.kind !== "calls") continue;
    bump(out, languageOfPath(lookup.fileOfNode.get(edge.src))).resolved +=
      edge.meta?.callCount ?? 1;
  }
  for (const entry of unresolved) {
    if (entry.kind === "call") bump(out, languageOfPath(entry.file)).unresolved++;
  }

  for (const entry of out.values()) entry.total = entry.resolved + entry.unresolved;
  // Languages that have files but no call references still get an entry (all zeros).
  for (const extraction of run.extractions) bump(out, languageOfPath(extraction.file));
  return out;
}
