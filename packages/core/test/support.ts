import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguagePlugin, ResolveInput, SourceFile } from "@repoatlas/plugin-api";
import type { FileExtraction, GraphEdge, ResolutionResult } from "@repoatlas/schema";
import {
  type AnalyzeRepositoryOptions,
  analyzeRepository,
  DEFAULT_LIMITS,
  type Fetcher,
  LocalDirFetcher,
  type PipelineResult,
} from "../src/index.ts";

/** Fixtures are located from this file, never from process.cwd(). */
export const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures", import.meta.url));
export const TS_FIXTURE_REPO = join(FIXTURES_DIR, "typescript", "repo");
export const PY_FIXTURE_REPO = join(FIXTURES_DIR, "python", "repo");
export const PY_EXPECTED = join(FIXTURES_DIR, "python", "expected-edges.json");
export const POLYGLOT_FIXTURE_REPO = join(FIXTURES_DIR, "polyglot", "repo");
export const POLYGLOT_EXPECTED = join(FIXTURES_DIR, "polyglot", "expected-edges.json");
export const TS_EXPECTED = join(FIXTURES_DIR, "typescript", "expected-edges.json");

/** Creates a temp directory holding `files` (path -> content). Call `cleanup` when done. */
export async function makeTempRepo(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "repoatlas-pipeline-"));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

type AnalyzeOverrides = Partial<AnalyzeRepositoryOptions>;

/** Runs analyzeRepository over a local directory and returns the pipeline result. */
export async function analyzeDir(
  dir: string,
  plugins: LanguagePlugin[],
  overrides: AnalyzeOverrides = {},
): Promise<PipelineResult> {
  const out = await analyzeRepository({
    fetcher: new LocalDirFetcher({ dir, owner: "acme", repo: "demo" }),
    request: { owner: "acme", repo: "demo" },
    limits: DEFAULT_LIMITS,
    plugins,
    destDirFor: () => dir,
    ...overrides,
  });
  if (out.status !== "analyzed") throw new Error("expected the repository to be analyzed");
  return out.result;
}

/** Same result without the (non-deterministic) timings. */
export function withoutTimings(result: PipelineResult): unknown {
  return { ...result, stats: { ...result.stats, timingsMs: {} } };
}

export interface FakePluginOptions {
  id?: string;
  tier?: 1 | 2 | 3;
  /** Files with this suffix are claimed. Fake files are python-flavoured (".py"). */
  suffix?: string;
  extract?: (file: SourceFile) => Promise<FileExtraction>;
  resolve?: (input: ResolveInput) => Promise<ResolutionResult>;
  analyzeProject?: LanguagePlugin["analyzeProject"];
}

/** Default extraction: one function `f` per file. */
export function simpleExtraction(file: SourceFile): FileExtraction {
  return {
    file: file.path,
    language: "python",
    definitions: [
      { localId: "f", kind: "function", name: "f", span: { startLine: 1, endLine: 1 } },
    ],
    imports: [],
    references: [],
    parseErrors: 0,
  };
}

export function emptyResolution(): ResolutionResult {
  return { imports: [], edges: [], externals: [], unresolved: [] };
}

export function fakePlugin(options: FakePluginOptions = {}): LanguagePlugin {
  const suffix = options.suffix ?? ".py";
  const plugin: LanguagePlugin = {
    id: options.id ?? "fake",
    version: "1",
    languages: ["python"],
    tier: options.tier ?? 2,
    detect: (files) => files.filter((f) => f.path.endsWith(suffix)),
    extract: options.extract ?? (async (file) => simpleExtraction(file)),
    resolve: options.resolve ?? (async () => emptyResolution()),
  };
  if (options.analyzeProject) plugin.analyzeProject = options.analyzeProject;
  return plugin;
}

export function callEdge(src: string, dst: string, line: number): GraphEdge {
  return { src, dst, kind: "calls", confidence: "exact", line };
}

/** A fetcher wrapper that counts calls, to prove the cache short-circuit skips fetching. */
export function countingFetcher(inner: Fetcher): Fetcher & { resolves: number; fetches: number } {
  const counter = {
    resolves: 0,
    fetches: 0,
    resolve(...args: Parameters<Fetcher["resolve"]>) {
      counter.resolves++;
      return inner.resolve(...args);
    },
    fetch(...args: Parameters<Fetcher["fetch"]>) {
      counter.fetches++;
      return inner.fetch(...args);
    },
  };
  return counter;
}
