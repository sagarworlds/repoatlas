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
import { goPrepare } from "../../src/prepare/index.ts";
import { type GoResolution, resolveGoDetailed } from "../../src/resolve/index.ts";

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
    files: all.filter((f) => f.path.endsWith(".go")),
    allFiles: all,
    repo: memoryRepo(files),
  };
}

type DefKind = Definition["kind"];
export type DefSpec =
  | DefKind
  | { kind: DefKind; signature?: string; meta?: Record<string, unknown> };

export interface GoFileSpec {
  /** Package clause; default: the directory's last segment ("main" at the root). */
  pkg?: string;
  /** `"Server.Start": "method"`: receiver Server, name Start; parent only if `Server` is in defs. */
  defs?: Record<string, DefSpec>;
  imports?: Partial<RawImport>[];
  refs?: Partial<RawReference>[];
}

function dirName(file: string): string {
  const parts = file.split("/");
  return parts.length > 1 ? (parts[parts.length - 2] as string) : "main";
}

/** Hand-built extraction of a Go file, following the conventions of the extractor. */
export function goFile(file: string, spec: GoFileSpec = {}): FileExtraction {
  let line = 500;
  const entries = Object.entries(spec.defs ?? {});
  const localIds = new Set(entries.map(([id]) => id));
  const definitions: Definition[] = entries.map(([localId, raw]) => {
    const { kind, signature, meta } = typeof raw === "string" ? { kind: raw } : raw;
    const dot = localId.indexOf(".");
    const name = dot > 0 ? localId.slice(dot + 1) : localId;
    const def: Definition = { localId, kind, name, span: { startLine: line, endLine: line + 1 } };
    if (signature !== undefined) def.signature = signature;
    const allMeta: Record<string, unknown> = { ...meta };
    if (kind === "method" && dot > 0) {
      const receiver = localId.slice(0, dot);
      allMeta["go.receiver"] = receiver;
      if (localIds.has(receiver)) def.parentLocalId = receiver;
    }
    if (Object.keys(allMeta).length > 0) def.meta = allMeta;
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
  const meta: Record<string, unknown> = { "go.package": spec.pkg ?? dirName(file) };
  if (file.endsWith("_test.go")) meta["go.test"] = true;
  return { file, language: "go", definitions, imports, references, parseErrors: 0, meta };
}

export interface TestIndex extends SymbolIndex {
  addSuperType(sub: string, sup: string): void;
}

/** A SymbolIndex like core's, built from the extractions' definitions. */
export function buildIndex(extractions: FileExtraction[]): TestIndex {
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
        language: "go",
        file: ex.file,
        span: def.span,
        parentId:
          def.parentLocalId !== undefined ? symbolId(ex.file, def.parentLocalId) : fileId(ex.file),
      };
      if (def.signature !== undefined) node.signature = def.signature;
      byId.set(node.id, node);
      push(byFile, ex.file, node);
      push(byShortName, node.name, node);
      if (node.parentId !== undefined) push(members, node.parentId, node);
    }
  }
  return {
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
}

export interface RunOutput extends GoResolution {
  input: ResolveInput;
}

/** Runs `goPrepare` on an in-memory repo whose Go files are the extractions, then resolves. */
export async function run(
  extractions: FileExtraction[],
  extra: Record<string, string> = {},
): Promise<RunOutput> {
  const files: Record<string, string> = { ...extra };
  for (const ex of extractions) files[ex.file] = "";
  const ctx = projectContext(files);
  const info = await goPrepare(ctx);
  const input: ResolveInput = {
    extractions,
    index: buildIndex(extractions),
    info,
    repo: ctx.repo,
  };
  return { ...(await resolveGoDetailed(input)), input };
}

export const sym = symbolId;
export const file = fileId;

export const edgeBetween = (edges: GraphEdge[], src: string, dst: string): GraphEdge | undefined =>
  edges.find((e) => e.src === src && e.dst === dst);
