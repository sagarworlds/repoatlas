import type {
  LanguagePlugin,
  PluginProjectInfo,
  ProjectContext,
  RepoFile,
  RepoView,
  SourceFile,
} from "@repoatlas/plugin-api";
import { type FileExtraction, FileExtractionSchema, type LanguageId } from "@repoatlas/schema";
import { languageOfPath } from "../detect/index.ts";
import { AnalysisError } from "../errors.ts";
import type { PipelineContext } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { ExtractionCache } from "./extraction-cache.ts";
import { type CacheCounts, isCacheable, planCache } from "./extraction-cache-step.ts";
import type { LoadedFile } from "./read-sources.ts";
import { mapLimit } from "./util.ts";
import { acceptExtraction } from "./workers/accept.ts";
import { type ExtractPoolSettings, openPooledExtractor } from "./workers/pooled-extractor.ts";

const EXTRACT_CONCURRENCY = 8;
/** Files kept queued per worker thread, so a worker never waits for the main thread. */
const POOL_QUEUE_PER_WORKER = 3;

/** What one plugin produced for its files. */
export interface PluginRun {
  plugin: LanguagePlugin;
  /** Files that stay in the graph (a file whose extraction failed is removed). */
  files: LoadedFile[];
  info: PluginProjectInfo;
  extractions: FileExtraction[];
  /**
   * Set when the resolution is already known: `analyzeProject` ran, or it failed and we fell
   * back to extraction only (empty resolution). Raw value, sanitized later. When undefined,
   * core calls `plugin.resolve`.
   */
  resolution: unknown;
  /** Extraction cache hits and misses; present only when the cache was used for this plugin. */
  cache?: CacheCounts;
}

/** Optional services for extraction (everything works without them). */
export interface ExtractOptions {
  /** Per-file extraction cache; used for Tier 1 plugins only. */
  cache?: ExtractionCache | undefined;
  /**
   * Worker-thread extraction for Tier 1 plugins. Undefined (the default, also in tests) keeps
   * everything on the main thread, which is also the debugging path.
   */
  pool?: ExtractPoolSettings | undefined;
}

/** Shared progress counter for the "parsing" phase. */
export interface ParseProgress {
  done: number;
  total: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof AnalysisError && (err.code === "CANCELLED" || err.code === "TIMEOUT");
}

/** Keeps extractions that match the schema and belong to a claimed file (first one wins). */
function validateExtractions(
  plugin: LanguagePlugin,
  raw: unknown,
  files: LoadedFile[],
  diagnostics: Diagnostics,
): FileExtraction[] {
  if (!Array.isArray(raw)) {
    diagnostics.addPluginError(
      plugin.id,
      "extract",
      "analyzeProject returned no extractions array",
    );
    return [];
  }
  const claimed = new Set(files.map((f) => f.path));
  const seen = new Set<string>();
  const valid: FileExtraction[] = [];
  for (const item of raw as unknown[]) {
    const parsed = FileExtractionSchema.safeParse(item);
    if (!parsed.success || !claimed.has(parsed.data.file) || seen.has(parsed.data.file)) {
      diagnostics.addSkip("invalid-extraction");
      continue;
    }
    seen.add(parsed.data.file);
    valid.push(parsed.data);
  }
  return valid;
}

/**
 * Extracts one file with the plugin. Returns undefined (and counts a skip) when the plugin
 * fails or returns invalid output; only cancellation and timeouts are re-thrown.
 */
async function extractFile(
  plugin: LanguagePlugin,
  file: LoadedFile,
  language: LanguageId | undefined,
  info: PluginProjectInfo,
  diagnostics: Diagnostics,
): Promise<FileExtraction | undefined> {
  if (language === undefined) {
    diagnostics.addSkip("extract-error");
    return undefined;
  }
  const source: SourceFile = {
    path: file.path,
    bytes: file.bytes,
    content: file.content,
    language,
  };
  try {
    const accepted = acceptExtraction(await plugin.extract(source, info), file.path);
    if (accepted) return accepted;
    diagnostics.addSkip("invalid-extraction");
  } catch (err) {
    if (isAbortError(err)) throw err;
    diagnostics.addSkip("extract-error");
  }
  return undefined;
}

/**
 * Per-file extraction with bounded concurrency; one failing file never fails the run.
 * Steps: (1) one batched cache lookup, (2) extract the misses, (3) one batched cache store.
 */
async function extractPerFile(
  plugin: LanguagePlugin,
  files: LoadedFile[],
  info: PluginProjectInfo,
  ctx: PipelineContext,
  diagnostics: Diagnostics,
  progress: ParseProgress,
  options: ExtractOptions,
): Promise<{ files: LoadedFile[]; extractions: FileExtraction[]; cache?: CacheCounts }> {
  const languages = files.map((f) => languageOfPath(f.path) ?? plugin.languages[0]);
  const plan =
    options.cache && isCacheable(plugin)
      ? planCache(plugin, files, languages, options.cache, ctx, diagnostics)
      : undefined;

  // Files that need real extraction go to worker threads when configured (and worthwhile);
  // otherwise, or if the pool breaks, they are extracted on the main thread.
  const mainThread = (file: LoadedFile, language: LanguageId | undefined) =>
    extractFile(plugin, file, language, info, diagnostics);
  const pooled = openPooledExtractor({
    settings: options.pool,
    plugin,
    info,
    fileCount: plan ? plan.counts().misses : files.length,
    signal: ctx.signal,
    diagnostics,
    fallback: mainThread,
  });
  const concurrency = pooled ? pooled.workerCount * POOL_QUEUE_PER_WORKER : EXTRACT_CONCURRENCY;

  let outcomes: (FileExtraction | undefined)[];
  try {
    outcomes = await mapLimit(files, concurrency, async (file, i) => {
      ctx.check();
      let extraction = plan?.hit(i);
      if (extraction === undefined) {
        extraction = await (pooled
          ? pooled.extract(file, languages[i])
          : mainThread(file, languages[i]));
        ctx.check(); // a cancelled pool answers "aborted"; stop instead of counting it
      }
      progress.done++;
      ctx.progress("parsing", progress.done, progress.total);
      return extraction;
    });
  } finally {
    pooled?.close();
  }
  plan?.storeFresh(outcomes);

  const kept: LoadedFile[] = [];
  const extractions: FileExtraction[] = [];
  outcomes.forEach((extraction, i) => {
    if (extraction) {
      kept.push(files[i] as LoadedFile);
      extractions.push(extraction);
    }
  });
  return plan ? { files: kept, extractions, cache: plan.counts() } : { files: kept, extractions };
}

/** Runs prepare + extraction (+ whole-project analysis) for one plugin. */
export async function runPluginExtraction(
  plugin: LanguagePlugin,
  files: LoadedFile[],
  allFiles: RepoFile[],
  repo: RepoView,
  ctx: PipelineContext,
  diagnostics: Diagnostics,
  progress: ParseProgress,
  options: ExtractOptions = {},
): Promise<PluginRun> {
  const projectCtx: ProjectContext = {
    files: files.map((f) => ({ path: f.path, bytes: f.bytes })),
    allFiles,
    repo,
  };

  let info: PluginProjectInfo = {};
  if (plugin.prepare) {
    try {
      info = await plugin.prepare(projectCtx);
    } catch (err) {
      if (isAbortError(err)) throw err;
      diagnostics.addPluginError(plugin.id, "prepare", err);
    }
  }
  ctx.check();

  if (plugin.analyzeProject) {
    try {
      const out = await plugin.analyzeProject(projectCtx, info);
      ctx.check();
      progress.done += files.length;
      ctx.progress("parsing", progress.done, progress.total);
      return {
        plugin,
        files,
        info,
        extractions: validateExtractions(plugin, out.extractions, files, diagnostics),
        resolution: out.resolution,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      diagnostics.addPluginError(plugin.id, "analyze", err);
      ctx.check();
      // Fall through to per-file extraction with an empty resolution.
      const fallback = await extractPerFile(
        plugin,
        files,
        info,
        ctx,
        diagnostics,
        progress,
        options,
      );
      return { plugin, info, ...fallback, resolution: {} };
    }
  }

  const result = await extractPerFile(plugin, files, info, ctx, diagnostics, progress, options);
  return { plugin, info, ...result, resolution: undefined };
}
