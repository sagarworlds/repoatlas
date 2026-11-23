import { performance } from "node:perf_hooks";
import type { LanguagePlugin } from "@repoatlas/plugin-api";
import type { FileExtraction, LanguageId } from "@repoatlas/schema";
import type { PipelineContext } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { ExtractionCache } from "./extraction-cache.ts";
import { extractionKeyForFile } from "./extraction-cache-key.ts";
import type { LoadedFile } from "./read-sources.ts";

/** Hit and miss counts of one plugin run (misses include files that failed to extract). */
export interface CacheCounts {
  hits: number;
  misses: number;
}

/** What the cache knows about the files of one plugin run. */
export interface CachePlan {
  /** Validated cached extraction for the file at `index`, or undefined (a miss). */
  hit(index: number): FileExtraction | undefined;
  counts(): CacheCounts;
  /** Stores the freshly extracted files (not the hits) in one batch. Never throws. */
  storeFresh(outcomes: readonly (FileExtraction | undefined)[]): void;
}

/** Only per-file Tier 1 plugins are cacheable: whole-project (Tier 3) output is not per file. */
export function isCacheable(plugin: LanguagePlugin): boolean {
  return plugin.tier === 1 && plugin.analyzeProject === undefined;
}

/** Adds elapsed milliseconds to a phase that can be entered several times (once per plugin). */
function addTiming(ctx: PipelineContext, phase: string, startedAt: number): void {
  const elapsed = performance.now() - startedAt;
  ctx.timings[phase] = Math.round(((ctx.timings[phase] ?? 0) + elapsed) * 100) / 100;
}

/**
 * Looks all files up in one batch. A cache that throws is treated as empty (the error is
 * recorded as a plugin error with stage "cache") so a broken cache never fails an analysis.
 * A cached row is only used when it describes exactly this file and language.
 */
export function planCache(
  plugin: LanguagePlugin,
  files: readonly LoadedFile[],
  languages: readonly (LanguageId | undefined)[],
  cache: ExtractionCache,
  ctx: PipelineContext,
  diagnostics: Diagnostics,
): CachePlan {
  const startedAt = performance.now();
  const keys: (string | undefined)[] = files.map((file, i) => {
    const language = languages[i];
    return language === undefined
      ? undefined
      : extractionKeyForFile(plugin, language, file.path, file.content);
  });
  const hits = new Map<number, FileExtraction>();
  let usable = true;
  try {
    const wanted = keys.filter((k): k is string => k !== undefined);
    const found = cache.getMany(wanted);
    keys.forEach((key, i) => {
      const cached = key === undefined ? undefined : found.get(key);
      const file = files[i];
      if (cached !== undefined && file !== undefined && cached.file === file.path) {
        if (cached.language === languages[i]) hits.set(i, cached);
      }
    });
  } catch (err) {
    usable = false;
    diagnostics.addPluginError(plugin.id, "cache", err);
  }
  addTiming(ctx, "cacheLookup", startedAt);

  return {
    hit: (index) => hits.get(index),
    counts: () => ({ hits: hits.size, misses: files.length - hits.size }),
    storeFresh(outcomes) {
      if (!usable) return;
      const writeStartedAt = performance.now();
      const entries: { key: string; extraction: FileExtraction }[] = [];
      outcomes.forEach((extraction, i) => {
        const key = keys[i];
        // A file with parse errors may come from a plugin that failed transiently (for
        // example a grammar that could not load): never cache it, so it is retried.
        if (extraction === undefined || key === undefined || hits.has(i)) return;
        if (extraction.parseErrors > 0) return;
        entries.push({ key, extraction });
      });
      try {
        if (entries.length > 0) cache.setMany(entries);
      } catch (err) {
        diagnostics.addPluginError(plugin.id, "cache", err);
      }
      addTiming(ctx, "cacheStore", writeStartedAt);
    },
  };
}
