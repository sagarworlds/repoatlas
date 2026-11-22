import { createDirRepoView, type LanguagePlugin, looksLikeTestPath } from "@repoatlas/plugin-api";
import {
  type AnalysisStats,
  type GraphEdge,
  type GraphNode,
  type LanguageId,
  mergeEdges,
  type Unresolved,
} from "@repoatlas/schema";
import { assignFilesToPlugins, languageOfPath } from "../detect/index.ts";
import { AnalysisError } from "../errors.ts";
import { computeRollups } from "../rollups/index.ts";
import { buildStructure, type StructureFile } from "../structure/index.ts";
import { buildSymbolIndex } from "../symbol-index.ts";
import type { FetchedRepo, Limits, PipelineResult, ProgressCallback } from "../types.ts";
import { walkRepo } from "../walk/index.ts";
import { createPipelineContext } from "./context.ts";
import { createDiagnostics } from "./diagnostics.ts";
import { type ParseProgress, type PluginRun, runPluginExtraction } from "./extract.ts";
import { readClaimedFiles } from "./read-sources.ts";
import {
  type ReferenceCounts,
  type ReferenceLookup,
  referenceCountsByLanguage,
} from "./reference-stats.ts";
import { resolvePlugin, type SanitizedResolution } from "./resolution.ts";
import { buildStats } from "./stats.ts";
import { buildSymbolNodes } from "./symbols.ts";
import { compareCodeUnits } from "./util.ts";
import { validateEdges } from "./validate.ts";
import { MAX_EDGES, MAX_NODES } from "./version.ts";

export interface PipelineInput {
  fetched: FetchedRepo;
  plugins: LanguagePlugin[];
  limits: Limits;
  onProgress?: ProgressCallback | undefined;
  signal?: AbortSignal | undefined;
  /** Overrides for the graph size caps (tests). Defaults: 500k nodes, 2M edges. */
  caps?: { maxNodes?: number; maxEdges?: number } | undefined;
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    compareCodeUnits(a.kind, b.kind) ||
    compareCodeUnits(a.src, b.src) ||
    compareCodeUnits(a.dst, b.dst) ||
    (a.line ?? 0) - (b.line ?? 0)
  );
}

function compareUnresolved(a: Unresolved, b: Unresolved): number {
  return (
    compareCodeUnits(a.file, b.file) ||
    a.line - b.line ||
    compareCodeUnits(a.name, b.name) ||
    compareCodeUnits(a.kind, b.kind)
  );
}

/** Per-file facts needed for file nodes and the language statistics. */
interface FileFacts extends StructureFile {
  pluginTier: 1 | 2 | 3;
  parseErrors: number;
}

function collectFileFacts(runs: PluginRun[]): FileFacts[] {
  const facts: FileFacts[] = [];
  for (const run of runs) {
    const byFile = new Map(run.extractions.map((e) => [e.file, e]));
    for (const file of run.files) {
      const extraction = byFile.get(file.path);
      const flaggedByPlugin =
        extraction?.meta?.isTest === true ||
        extraction?.definitions.some((d) => d.meta?.isTest === true) === true;
      facts.push({
        path: file.path,
        bytes: file.bytes,
        loc: file.loc,
        isTest: looksLikeTestPath(file.path) || flaggedByPlugin,
        language: extraction?.language ?? languageOfPath(file.path) ?? run.plugin.languages[0],
        pluginTier: run.plugin.tier,
        parseErrors: extraction?.parseErrors ?? 0,
      });
    }
  }
  return facts;
}

function languageStats(
  facts: FileFacts[],
  references: ReadonlyMap<LanguageId, ReferenceCounts>,
): AnalysisStats["languages"] {
  const languages: AnalysisStats["languages"] = {};
  for (const f of facts) {
    const language: LanguageId | undefined = f.language;
    if (language === undefined) continue;
    const entry = languages[language] ?? { files: 0, bytes: 0, pluginTier: f.pluginTier };
    entry.files++;
    entry.bytes += f.bytes;
    languages[language] = entry;
  }
  for (const entry of Object.values(languages)) entry.references = { total: 0, resolved: 0 };
  for (const [language, counts] of references) {
    const entry = languages[language];
    if (entry) entry.references = { total: counts.total, resolved: counts.resolved };
  }
  return languages;
}

/** Files mentioned by edges that are not claimed source files (e.g. an imported .json). */
function referencedExtraFiles(
  edges: readonly GraphEdge[],
  claimed: ReadonlySet<string>,
  walked: ReadonlyMap<string, number>,
): StructureFile[] {
  const extra = new Map<string, StructureFile>();
  for (const edge of edges) {
    for (const id of [edge.src, edge.dst]) {
      if (!id.startsWith("file:")) continue;
      const path = id.slice("file:".length);
      const bytes = walked.get(path);
      if (bytes !== undefined && !claimed.has(path)) extra.set(path, { path, bytes });
    }
  }
  return [...extra.values()];
}

/**
 * Runs pipeline stages 3-9 and 11 over an extracted repository (docs/ARCHITECTURE section 3):
 * walk, detect, read, extract (+resolve), symbol index, structure, edge validation,
 * duplicate merging, rollups and stats. Persisting (stage 10) is done by the caller.
 *
 * Failures are isolated: a file that cannot be read or parsed is skipped and counted, a
 * plugin that throws is recorded in `stats.pluginErrors`, invalid edges are dropped and
 * counted. Only cancellation, the timeout and "nothing to analyze" abort the run.
 *
 * The result is deterministic: nodes and edges are sorted, so the same input always gives
 * identical JSON (the timings in the stats aside).
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { fetched, plugins, limits } = input;
  const maxNodes = input.caps?.maxNodes ?? MAX_NODES;
  const maxEdges = input.caps?.maxEdges ?? MAX_EDGES;
  const ctx = createPipelineContext(limits.analysisTimeoutMs, input.signal, input.onProgress);
  const diagnostics = createDiagnostics();
  const startedAt = performance.now();
  let truncated = false;

  // Stage 3: walk and filter.
  const walk = await ctx.time("walk", () => walkRepo(fetched.rootDir, limits, ctx.signal));
  ctx.check();

  // Stage 4: detect.
  const assigned = await ctx.time("detect", () => assignFilesToPlugins(walk.files, plugins));
  for (const err of assigned.errors) diagnostics.addPluginError(err.plugin, "detect", err.message);
  const claimedCount = [...assigned.assignments.values()].reduce((n, files) => n + files.length, 0);
  if (claimedCount === 0) {
    throw new AnalysisError(
      "NO_SUPPORTED_LANGUAGES",
      "No files in a supported language were found",
    );
  }

  const loaded = await ctx.time("read", () =>
    readClaimedFiles(fetched.rootDir, assigned.assignments, plugins, ctx, diagnostics),
  );
  const readCount = [...loaded.values()].reduce((n, files) => n + files.length, 0);
  if (readCount === 0) {
    throw new AnalysisError("NO_SUPPORTED_LANGUAGES", "No analyzable source files were found");
  }

  // Stage 5 (and 7 for whole-project plugins): prepare + extract.
  const repo = createDirRepoView(fetched.rootDir);
  const progress: ParseProgress = { done: 0, total: readCount };
  ctx.progress("parsing", 0, readCount);
  const runs: PluginRun[] = [];
  await ctx.time("extract", async () => {
    for (const plugin of plugins) {
      const files = loaded.get(plugin.id) ?? [];
      if (files.length === 0) continue;
      runs.push(
        await runPluginExtraction(plugin, files, walk.files, repo, ctx, diagnostics, progress),
      );
    }
  });

  // Symbol nodes + contains edges, then the global symbol index (stage 6).
  const allExtractions = runs.flatMap((r) => r.extractions);
  const symbols = buildSymbolNodes(allExtractions, maxNodes);
  if (symbols.truncated) truncated = true;
  const index = await ctx.time("index", () => buildSymbolIndex(symbols.nodes));

  // Stage 7: resolve.
  ctx.progress("resolving", 0, readCount);
  const resolutions: SanitizedResolution[] = [];
  await ctx.time("resolve", async () => {
    for (const run of runs) {
      resolutions.push(await resolvePlugin(run, index, repo, ctx, diagnostics));
    }
  });
  ctx.progress("resolving", readCount, readCount);

  // Stage 8: structure nodes (also for non-source files that imports point to).
  const facts = collectFileFacts(runs);
  const structure = await ctx.time("structure", () => {
    const claimed = new Set(facts.map((f) => f.path));
    const walked = new Map(walk.files.map((f) => [f.path, f.bytes]));
    const extras = referencedExtraFiles(
      resolutions.flatMap((r) => r.edges),
      claimed,
      walked,
    );
    const built = buildStructure({ repoName: fetched.repo, files: [...facts, ...extras] });
    // Record parse errors on the file node (the structure builder does not know about them).
    const parseErrors = new Map(
      facts.filter((f) => f.parseErrors > 0).map((f) => [f.path, f.parseErrors]),
    );
    for (const node of built.nodes) {
      const count = node.kind === "file" && node.file ? parseErrors.get(node.file) : undefined;
      if (count !== undefined) node.meta = { ...node.meta, parseErrors: count };
    }
    return built;
  });

  // Collect external/module nodes (deduplicated by id, first one wins).
  const nodeById = new Map<string, GraphNode>();
  for (const node of [...structure.nodes, ...symbols.nodes]) nodeById.set(node.id, node);
  const pluginNodes = new Map<string, GraphNode>();
  for (const r of resolutions) {
    for (const node of r.nodes) if (!nodeById.has(node.id)) pluginNodes.set(node.id, node);
  }
  for (const node of [...pluginNodes.values()].sort((a, b) => compareCodeUnits(a.id, b.id))) {
    nodeById.set(node.id, node);
  }
  let nodes = [...nodeById.values()];
  if (nodes.length > maxNodes) {
    nodes = nodes.slice(0, maxNodes); // structure and symbols come first, externals last
    truncated = true;
  }
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Validation (drop invalid edges), reference statistics and duplicate merging.
  const finished = await ctx.time("validate", () => {
    let dropped = 0;
    const references = { total: 0, resolved: 0, unresolved: 0 };
    const perLanguage = new Map<LanguageId, ReferenceCounts>();
    const lookup: ReferenceLookup = {
      languageOfFile: new Map(facts.map((f) => [f.path, f.language])),
      fileOfNode: new Map(
        nodes.flatMap((n) => (n.file !== undefined ? [[n.id, n.file] as const] : [])),
      ),
    };
    const pluginEdges: GraphEdge[] = [];
    const unresolved: Unresolved[] = [];
    runs.forEach((run, i) => {
      const resolution = resolutions[i] as SanitizedResolution;
      const { kept, dropped: bad } = validateEdges(resolution.edges, nodeIds, true);
      dropped += bad + resolution.invalidEdges;
      pluginEdges.push(...kept);
      unresolved.push(...resolution.unresolved);

      // Reference statistics (rules in reference-stats.ts), per language and in total.
      const byLanguage = referenceCountsByLanguage(run, kept, resolution.unresolved, lookup);
      for (const [language, counts] of byLanguage) {
        const entry = perLanguage.get(language) ?? { total: 0, resolved: 0, unresolved: 0 };
        entry.total += counts.total;
        entry.resolved += counts.resolved;
        entry.unresolved += counts.unresolved;
        perLanguage.set(language, entry);
        references.total += counts.total;
        references.resolved += counts.resolved;
        references.unresolved += counts.unresolved;
      }
    });

    const contains = validateEdges([...structure.edges, ...symbols.edges], nodeIds, false);
    dropped += contains.dropped;

    // Sort first so mergeEdges keeps the same `line` and meta whatever the plugin order was.
    const merged = mergeEdges(pluginEdges.sort(compareEdges)).sort(compareEdges);
    let edges = [...contains.kept, ...merged];
    if (edges.length > maxEdges) {
      edges = edges.slice(0, maxEdges);
      truncated = true;
    }
    unresolved.sort(compareUnresolved);
    return { dropped, references, perLanguage, edges, unresolved };
  });
  ctx.check();

  // Stage 9: rollups.
  const rollups = await ctx.time("rollups", () => computeRollups(nodes, finished.edges));

  // Stage 11: statistics.
  ctx.timings.total = Math.round((performance.now() - startedAt) * 100) / 100;
  const stats = buildStats({
    commitSha: fetched.commitSha,
    languages: languageStats(facts, finished.perLanguage),
    nodes,
    edges: finished.edges,
    references: finished.references,
    skippedFiles: diagnostics.skippedFiles(fetched.skippedFiles, walk.skipped),
    parseErrorFiles: allExtractions.filter((e) => e.parseErrors > 0).length,
    droppedInvalidEdges: finished.dropped,
    pluginErrors: diagnostics.pluginErrors,
    truncated,
    timingsMs: ctx.timings,
  });

  return { nodes, edges: finished.edges, rollups, unresolved: finished.unresolved, stats };
}
