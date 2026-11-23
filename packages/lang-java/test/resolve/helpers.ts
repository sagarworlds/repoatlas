import type { ProjectContext, RepoView, ResolveInput, SymbolIndex } from "@repoatlas/plugin-api";
import type {
  Definition,
  FileExtraction,
  GraphEdge,
  GraphNode,
  RawImport,
  RawReference,
} from "@repoatlas/schema";
import { fileId, symbolId } from "@repoatlas/schema";
import { javaPrepare } from "../../src/prepare/index.ts";
import { javaResolve, resolveJavaDetailed } from "../../src/resolve/index.ts";

/** In-memory repository: path -> content. */
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
    files: all.filter((f) => f.path.endsWith(".java")),
    allFiles: all,
    repo: memoryRepo(files),
  };
}

/**
 * Definition spec. A string is the kind. An object adds Java meta:
 * `{ kind: "method", params: 2, varargs: true, ctor: true, javaKind: "enum", annotations: [...] }`.
 * The parent is the dotted prefix of the key; a collision suffix `@12` is allowed after a name.
 */
export type DefValue =
  | Definition["kind"]
  | {
      kind: Definition["kind"];
      params?: number;
      varargs?: boolean;
      ctor?: boolean;
      isStatic?: boolean;
      javaKind?: string;
      annotations?: string[];
    };

export interface ExtractionSpec {
  pkg?: string;
  defs?: Record<string, DefValue>;
  imports?: Partial<RawImport>[];
  refs?: Partial<RawReference>[];
}

export function extraction(file: string, spec: ExtractionSpec = {}): FileExtraction {
  let line = 500;
  const definitions: Definition[] = Object.entries(spec.defs ?? {}).map(([localId, value]) => {
    const v = typeof value === "string" ? { kind: value } : value;
    const parts = localId.split(".");
    const last = (parts[parts.length - 1] ?? localId).split("@")[0] as string;
    const def: Definition = {
      localId,
      kind: v.kind,
      name: last,
      span: { startLine: line, endLine: line + 1 },
    };
    if (parts.length > 1) def.parentLocalId = parts.slice(0, -1).join(".");
    const meta: Record<string, unknown> = {};
    if (v !== undefined && "params" in v && v.params !== undefined) meta["java.params"] = v.params;
    if ("varargs" in v && v.varargs === true) meta["java.varargs"] = true;
    if ("ctor" in v && v.ctor === true) meta["isConstructor"] = true;
    if ("isStatic" in v && v.isStatic === true) meta["isStatic"] = true;
    if ("javaKind" in v && v.javaKind !== undefined) meta["java.kind"] = v.javaKind;
    if ("annotations" in v && v.annotations !== undefined) meta["java.annotations"] = v.annotations;
    if (Object.keys(meta).length > 0) def.meta = meta;
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
    language: "java",
    definitions,
    imports,
    references,
    parseErrors: 0,
  };
  if (spec.pkg !== undefined) result.meta = { "java.package": spec.pkg };
  return result;
}

/** A SymbolIndex built from the definitions, like core does (without the rest). */
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
        language: "java",
        file: ex.file,
        span: def.span,
      };
      node.parentId =
        def.parentLocalId !== undefined ? symbolId(ex.file, def.parentLocalId) : fileId(ex.file);
      byId.set(node.id, node);
      push(byFile, ex.file, node);
      push(byShortName, node.name, node);
      push(members, node.parentId, node);
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

export async function run(extractions: FileExtraction[], extra: Record<string, string> = {}) {
  const files: Record<string, string> = { ...extra };
  for (const ex of extractions) files[ex.file] = "";
  const ctx = projectContext(files);
  const info = await javaPrepare(ctx);
  const input: ResolveInput = { extractions, index: buildIndex(extractions), info, repo: ctx.repo };
  const detailed = await resolveJavaDetailed(input);
  return { ...detailed, info, input, resolve: () => javaResolve(input) };
}

export const sym = symbolId;
export const file = fileId;

/** Edges of one kind as `src -> dst (confidence)` strings, for compact assertions. */
export function show(edges: GraphEdge[], kind?: GraphEdge["kind"]): string[] {
  return edges
    .filter((e) => kind === undefined || e.kind === kind)
    .map((e) => `${e.src} -> ${e.dst} (${e.confidence})`);
}
