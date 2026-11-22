import type { ProjectContext, RepoView, ResolveInput, SymbolIndex } from "@repoatlas/plugin-api";
import type {
  Definition,
  FileExtraction,
  GraphNode,
  RawImport,
  RawReference,
} from "@repoatlas/schema";
import { fileId, symbolId } from "@repoatlas/schema";
import { pythonPrepare } from "../../src/prepare/index.ts";
import { pythonResolve, resolvePythonDetailed } from "../../src/resolve/index.ts";

/** In-memory repository: path -> content. Directories are derived from the paths. */
export function memoryRepo(files: Record<string, string>): RepoView {
  const paths = Object.keys(files);
  const dirs = new Set<string>([""]);
  for (const p of paths) {
    const parts = p.split("/");
    for (let n = 1; n < parts.length; n++) dirs.add(parts.slice(0, n).join("/"));
  }
  return {
    exists: (p) => p in files || dirs.has(p),
    isDir: (p) => dirs.has(p),
    read: async (p) => files[p],
    readSync: (p) => files[p],
    list: (dir) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = new Set<string>();
      for (const p of paths) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0] as string);
      }
      return [...names];
    },
  };
}

export function projectContext(files: Record<string, string>): ProjectContext {
  const all = Object.entries(files).map(([path, content]) => ({ path, bytes: content.length }));
  return {
    files: all.filter((f) => f.path.endsWith(".py")),
    allFiles: all,
    repo: memoryRepo(files),
  };
}

type DefKind = Definition["kind"];

/** `{ "User.save": "method" }`: parent is the dotted prefix. Spans are made up. */
export type DefSpec = Record<string, DefKind>;

export interface ExtractionSpec {
  defs?: DefSpec;
  imports?: Partial<RawImport>[];
  refs?: Partial<RawReference>[];
  meta?: Record<string, unknown>;
}

export function extraction(file: string, spec: ExtractionSpec = {}): FileExtraction {
  let line = 500; // after the made-up import and reference lines
  const definitions: Definition[] = Object.entries(spec.defs ?? {}).map(([localId, kind]) => {
    const parts = localId.split(".");
    const def: Definition = {
      localId,
      kind,
      name: parts[parts.length - 1] ?? localId,
      span: { startLine: line, endLine: line + 1 },
    };
    if (parts.length > 1) def.parentLocalId = parts.slice(0, -1).join(".");
    line += 2;
    return def;
  });
  const imports: RawImport[] = (spec.imports ?? []).map((imp, i) => ({
    line: i + 1,
    specifier: "",
    kind: "module",
    ...imp,
  }));
  const references: RawReference[] = (spec.refs ?? []).map((ref, i) => ({
    line: 100 + i,
    kind: "call",
    name: "",
    ...ref,
  }));
  const result: FileExtraction = {
    file,
    language: "python",
    definitions,
    imports,
    references,
    parseErrors: 0,
  };
  if (spec.meta !== undefined) result.meta = spec.meta;
  return result;
}

/** A SymbolIndex built from the extractions' definitions (like core does, minus the rest). */
export function buildIndex(extractions: FileExtraction[]): SymbolIndex {
  const byId = new Map<string, GraphNode>();
  const byFile = new Map<string, GraphNode[]>();
  const byShortName = new Map<string, GraphNode[]>();
  const members = new Map<string, GraphNode[]>();
  const supers = new Map<string, string[]>();
  const push = (map: Map<string, GraphNode[]>, key: string, node: GraphNode): void => {
    const list = map.get(key);
    if (list) list.push(node);
    else map.set(key, [node]);
  };
  for (const ex of extractions) {
    for (const def of ex.definitions) {
      const node: GraphNode = {
        id: symbolId(ex.file, def.localId),
        kind: def.kind,
        name: def.name,
        language: "python",
        file: ex.file,
        span: def.span,
      };
      // Like the pipeline: a top-level symbol's parent is the file node.
      node.parentId =
        def.parentLocalId !== undefined ? symbolId(ex.file, def.parentLocalId) : fileId(ex.file);
      byId.set(node.id, node);
      push(byFile, ex.file, node);
      push(byShortName, node.name, node);
      if (node.parentId !== undefined) push(members, node.parentId, node);
    }
  }
  const index: SymbolIndex & { addSuperType(sub: string, sup: string): void } = {
    byId,
    byFile,
    byQualifiedName: new Map(),
    byShortName,
    moduleToFiles: new Map(),
    membersOf: (id) => members.get(id) ?? [],
    superTypesOf: (id) => supers.get(id) ?? [],
    addSuperType(sub, sup) {
      supers.set(sub, [...(supers.get(sub) ?? []), sup]);
    },
  };
  return index;
}

/**
 * Runs prepare on an in-memory repo whose Python files are all in `extractions`, then resolve.
 * `extra` adds non-Python files (pyproject.toml, setup.cfg) or raw sources to the repo.
 */
export async function run(
  extractions: FileExtraction[],
  extra: Record<string, string> = {},
  sources: Record<string, string> = {},
) {
  const files: Record<string, string> = { ...extra };
  for (const ex of extractions) files[ex.file] = sources[ex.file] ?? "";
  const ctx = projectContext(files);
  const info = await pythonPrepare(ctx);
  const input: ResolveInput = {
    extractions,
    index: buildIndex(extractions),
    info,
    repo: ctx.repo,
  };
  const detailed = await resolvePythonDetailed(input);
  return { ...detailed, info, input, resolve: () => pythonResolve(input) };
}

export const sym = symbolId;
