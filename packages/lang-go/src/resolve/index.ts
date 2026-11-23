import type { BindingMap, ResolveContext, ResolvedRef, ResolveInput } from "@repoatlas/plugin-api";
import {
  addBinding,
  applySuperTypes,
  type ResolutionSummary,
  summariseResolution,
  toEdges,
  toUnresolved,
} from "@repoatlas/plugin-api";
import type {
  Definition,
  FileExtraction,
  GraphEdge,
  GraphNode,
  RawReference,
  ResolutionResult,
  Unresolved,
} from "@repoatlas/schema";
import { moduleId, symbolId } from "@repoatlas/schema";
import {
  compareCodeUnits,
  dirOf,
  type GoPackageTable,
  type GoProjectInfo,
  readGoProjectInfo,
  tableFromDirs,
  withDirs,
} from "../prepare/project-info.ts";
import { analyzeImports } from "./imports.ts";
import { EXTERNAL, type FileInfo, type ResolveState } from "./lookup.ts";
import { buildDirs, type DirData, isGoTestFile } from "./packages.ts";
import { resolveGoReference, resolveTypeReference } from "./references.ts";
import { GO_STOPLIST } from "./stoplist.ts";

export { classifyImport, packageNameGuesses } from "./imports.ts";
export { parseResultType, parseTypeName } from "./signature.ts";
export { GO_PREDECLARED_TYPES, GO_STOPLIST } from "./stoplist.ts";

/** Called once per reference with its outcome. */
export type ReferenceObserver = (
  extraction: FileExtraction,
  ref: RawReference,
  resolved: ResolvedRef,
) => void;

export interface GoResolution {
  result: ResolutionResult;
  /** Counts of resolved and unresolved references (silent external ones count as unresolved/external). */
  summary: ResolutionSummary;
}

function compareFiles(a: FileExtraction, b: FileExtraction): number {
  return compareCodeUnits(a.file, b.file);
}

/** Last import path segment, skipping a trailing `/vN`; "." (module-less root) stays ".". */
function moduleName(importPath: string): string {
  const segments = importPath.split("/");
  const last = segments[segments.length - 1] ?? importPath;
  if (segments.length > 1 && /^v\d+$/.test(last)) return segments[segments.length - 2] ?? last;
  return last;
}

function moduleNodes(dirs: ReadonlyMap<string, DirData>, table: GoPackageTable): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const dir of [...dirs.keys()].sort(compareCodeUnits)) {
    const data = dirs.get(dir);
    const importPath = table.dirToImportPath.get(dir);
    if (data === undefined || importPath === undefined) continue;
    const packageName = (data.primary ?? data.groups[0])?.name;
    nodes.push({
      id: moduleId("go", importPath),
      kind: "module",
      name: moduleName(importPath),
      qualifiedName: importPath,
      language: "go",
      meta: {
        language: "go",
        "go.dir": dir,
        ...(packageName === undefined ? {} : { "go.package": packageName }),
      },
    });
  }
  return nodes;
}

/** Builds the per-file lookup records and the cross-file tables of the resolve state. */
function buildState(
  extractions: readonly FileExtraction[],
  input: ResolveInput,
  dirs: ReadonlyMap<string, DirData>,
  files: ReturnType<typeof analyzeImports>["files"],
): ResolveState {
  const bindings = new Map<string, BindingMap>();
  const fileInfos = new Map<string, FileInfo>();
  const defById = new Map<string, Definition>();
  const callableNames = new Set<string>();
  for (const extraction of extractions) {
    const dirData = dirs.get(dirOf(extraction.file));
    const imports = files.get(extraction.file);
    const pkg = dirData?.groups.find((g) => g.extractions.includes(extraction));
    for (const def of extraction.definitions) {
      defById.set(symbolId(extraction.file, def.localId), def);
      if (def.kind === "function" || def.kind === "method") {
        callableNames.add(def.name.slice(def.name.lastIndexOf(".") + 1));
      }
    }
    if (!dirData || !imports || !pkg) continue;
    fileInfos.set(extraction.file, {
      extraction,
      pkg,
      dir: dirData,
      isTest: isGoTestFile(extraction),
      imports,
      defs: new Map(extraction.definitions.map((d) => [d.localId, d])),
    });
    const map: BindingMap = new Map();
    for (const [name, b] of imports.bindings) {
      const nodeId = b.kind === "internal" ? moduleId("go", b.importPath) : b.id;
      addBinding(map, name, { nodeId, confidence: "inferred", via: "import" });
    }
    bindings.set(extraction.file, map);
  }
  const ctx: ResolveContext = {
    index: input.index,
    bindings,
    language: "go",
    stoplistExtra: GO_STOPLIST,
    // No constructorNames: Go has no constructors; `Foo{}` and `Foo(x)` are references.
  };
  return {
    ctx,
    index: input.index,
    files: fileInfos,
    defById,
    callableNames,
    externalEmbeds: new Set(),
  };
}

/**
 * Like `goResolve`, but also returns the resolution summary and can report every outcome to
 * an observer (used by tests and stats).
 */
export async function resolveGoDetailed(
  input: ResolveInput,
  info?: GoProjectInfo,
  observer?: ReferenceObserver,
): Promise<GoResolution> {
  const extractions = [...input.extractions].sort(compareFiles);
  const fileDirs = extractions.map((e) => dirOf(e.file));
  const base = readGoProjectInfo(info ?? input.info) ?? tableFromDirs(fileDirs);
  const table = withDirs(base, fileDirs);

  const dirs = buildDirs(extractions, input.index);
  const analysis = analyzeImports(extractions, dirs, table);
  const state = buildState(extractions, input, dirs, analysis.files);

  // Embedding first: promoted methods are found through the recorded super types.
  applySuperTypes(state.ctx, extractions, (_ctx, extraction, ref) => {
    const fi = state.files.get(extraction.file);
    const resolved = fi === undefined ? EXTERNAL : resolveTypeReference(fi, ref);
    if (resolved.targets.length === 0 && ref.fromLocalId !== undefined) {
      state.externalEmbeds.add(symbolId(extraction.file, ref.fromLocalId));
    }
    return resolved;
  });

  const edges: GraphEdge[] = [];
  const unresolved: Unresolved[] = [...analysis.unresolved];
  const results: ResolvedRef[] = [];
  for (const extraction of extractions) {
    const fi = state.files.get(extraction.file);
    if (fi === undefined) continue;
    for (const ref of extraction.references) {
      const resolved = resolveGoReference(state, fi, ref);
      results.push(resolved);
      observer?.(extraction, ref, resolved);
      for (const edge of toEdges(extraction, ref, resolved)) {
        // A type that mentions itself (`next *Node`) is not worth an edge; recursion is.
        if (ref.kind !== "call" && edge.src === edge.dst) continue;
        edges.push(edge);
      }
      if (resolved.targets.length === 0 && resolved.unresolved === true) {
        if (resolved.reason !== "external") unresolved.push(toUnresolved(extraction, ref));
      }
    }
  }

  return {
    result: {
      imports: analysis.imports,
      edges,
      externals: analysis.externals,
      modules: moduleNodes(dirs, table),
      unresolved,
    },
    summary: summariseResolution(results),
  };
}

/**
 * Plugin `resolve` step. `info` defaults to `input.info`, the `GoProjectInfo` from
 * `goPrepare`; when it is missing or malformed, import paths are derived from the extracted
 * file paths as in a module-less repository.
 */
export async function goResolve(
  input: ResolveInput,
  info?: GoProjectInfo,
): Promise<ResolutionResult> {
  return (await resolveGoDetailed(input, info)).result;
}
