import type {
  LanguagePlugin,
  PluginProjectInfo,
  ProjectContext,
  RepoFile,
  RepoView,
  SourceFile,
} from "@repoatlas/plugin-api";
import { type FileExtraction, FileExtractionSchema } from "@repoatlas/schema";
import { languageOfPath } from "../detect/index.ts";
import { AnalysisError } from "../errors.ts";
import type { PipelineContext } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { LoadedFile } from "./read-sources.ts";
import { mapLimit } from "./util.ts";

const EXTRACT_CONCURRENCY = 8;

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

/** Per-file extraction with bounded concurrency; one failing file never fails the run. */
async function extractPerFile(
  plugin: LanguagePlugin,
  files: LoadedFile[],
  info: PluginProjectInfo,
  ctx: PipelineContext,
  diagnostics: Diagnostics,
  progress: ParseProgress,
): Promise<{ files: LoadedFile[]; extractions: FileExtraction[] }> {
  const outcomes = await mapLimit(files, EXTRACT_CONCURRENCY, async (file) => {
    ctx.check();
    const language = languageOfPath(file.path) ?? plugin.languages[0];
    let extraction: FileExtraction | undefined;
    if (language === undefined) {
      diagnostics.addSkip("extract-error");
    } else {
      const source: SourceFile = {
        path: file.path,
        bytes: file.bytes,
        content: file.content,
        language,
      };
      try {
        const parsed = FileExtractionSchema.safeParse(await plugin.extract(source, info));
        if (parsed.success && parsed.data.file === file.path) extraction = parsed.data;
        else diagnostics.addSkip("invalid-extraction");
      } catch (err) {
        if (isAbortError(err)) throw err;
        diagnostics.addSkip("extract-error");
      }
    }
    progress.done++;
    ctx.progress("parsing", progress.done, progress.total);
    return extraction;
  });
  const kept: LoadedFile[] = [];
  const extractions: FileExtraction[] = [];
  outcomes.forEach((extraction, i) => {
    if (extraction) {
      kept.push(files[i] as LoadedFile);
      extractions.push(extraction);
    }
  });
  return { files: kept, extractions };
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
      const fallback = await extractPerFile(plugin, files, info, ctx, diagnostics, progress);
      return { plugin, info, ...fallback, resolution: {} };
    }
  }

  const result = await extractPerFile(plugin, files, info, ctx, diagnostics, progress);
  return { plugin, info, ...result, resolution: undefined };
}
