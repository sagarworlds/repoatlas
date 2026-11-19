import type { FileExtraction, GraphNode, LanguageId, ResolutionResult } from "@repoatlas/schema";

/** A candidate source file. `path` is POSIX and repo-relative. */
export interface RepoFile {
  path: string;
  bytes: number;
}

export interface SourceFile extends RepoFile {
  content: string;
  language: LanguageId;
}

/** Read-only view of the extracted repository. Plugins must never write or execute anything. */
export interface RepoView {
  exists(path: string): boolean;
  isDir(path: string): boolean;
  read(path: string): Promise<string | undefined>;
  /** Synchronous read for APIs that need it (e.g. the TypeScript CompilerHost). */
  readSync(path: string): string | undefined;
  /** Names (not paths) of the entries directly inside `dir` ("" = repo root). */
  list(dir: string): string[];
}

/** Everything a plugin needs before extraction. */
export interface ProjectContext {
  /** Only the files this plugin claimed via `detect`. */
  files: RepoFile[];
  /** Every file in the repo (after filtering), for manifest lookups. */
  allFiles: RepoFile[];
  repo: RepoView;
}

/** Plugin-private data computed by `prepare` (package roots, module paths, ...). */
export type PluginProjectInfo = Record<string, unknown>;

/**
 * Global index of symbol nodes, built by core after extraction (LANGUAGE_PLUGINS §3).
 * `byShortName` lookups must always be filtered by language.
 */
export interface SymbolIndex {
  byId: Map<string, GraphNode>;
  /** Symbols defined in a file, keyed by repo-relative path. */
  byFile: Map<string, GraphNode[]>;
  byQualifiedName: Map<string, GraphNode[]>;
  byShortName: Map<string, GraphNode[]>;
  /** Methods/fields of a class. */
  membersOf(classId: string): GraphNode[];
  /** Filled after the extends/implements pass; empty until then. */
  superTypesOf(classId: string): string[];
  /** Language-specific module key -> files. */
  moduleToFiles: Map<string, string[]>;
}

export interface ResolveInput {
  /** Only this plugin's files. */
  extractions: FileExtraction[];
  index: SymbolIndex;
  info: PluginProjectInfo;
  repo: RepoView;
}

export interface LanguagePlugin {
  /** e.g. "typescript" */
  id: string;
  /** Bump when output changes (part of extraction cache keys). */
  version: string;
  languages: LanguageId[];
  tier: 1 | 2 | 3;

  /** Claim files. Called once with all candidate paths; return the ones this plugin handles. */
  detect(files: RepoFile[]): RepoFile[];

  /** Optional project-level setup: read manifests only. Must never execute repo code. */
  prepare?(ctx: ProjectContext): Promise<PluginProjectInfo>;

  /** Pure, per-file. Must not throw on bad syntax; count parse errors instead. */
  extract(file: SourceFile, info: PluginProjectInfo): Promise<FileExtraction>;

  /** Turns raw imports/references into edges using the whole-repo index. */
  resolve(input: ResolveInput): Promise<ResolutionResult>;

  /** Optional whole-project mode (Tier 3): extraction and resolution together. */
  analyzeProject?(
    ctx: ProjectContext,
    info: PluginProjectInfo,
  ): Promise<{ extractions: FileExtraction[]; resolution: ResolutionResult }>;
}
