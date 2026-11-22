import type { Definition, FileExtraction, GraphNode, LanguageId } from "@repoatlas/schema";
import { fileId, symbolId } from "@repoatlas/schema";
import type { BindingMap } from "./bindings.ts";
import type { MutableSymbolIndexLike, ResolveContext } from "./types.ts";

/** Test helper: hand-made files and index. Not exported from the package. */
export type DefKind = Definition["kind"];

/** `"User.save": "method"` puts method `save` under class `User` (parent = dotted prefix). */
export type FileSpec = Record<string, DefKind>;

export function makeExtraction(
  file: string,
  spec: FileSpec,
  language: LanguageId = "python",
): FileExtraction {
  let line = 1;
  const definitions: Definition[] = Object.entries(spec).map(([localId, kind]) => {
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
  return { file, language, definitions, imports: [], references: [], parseErrors: 0 };
}

export function makeIndex(
  extractions: FileExtraction[],
  extraNodes: GraphNode[] = [],
): MutableSymbolIndexLike {
  const byId = new Map<string, GraphNode>();
  const byFile = new Map<string, GraphNode[]>();
  const byShortName = new Map<string, GraphNode[]>();
  const members = new Map<string, GraphNode[]>();
  const push = (map: Map<string, GraphNode[]>, key: string, n: GraphNode): void => {
    map.set(key, [...(map.get(key) ?? []), n]);
  };
  const add = (n: GraphNode): void => {
    byId.set(n.id, n);
    if (n.file !== undefined) push(byFile, n.file, n);
    push(byShortName, n.name, n);
    if (n.parentId !== undefined) push(members, n.parentId, n);
  };
  for (const ex of extractions) {
    for (const def of ex.definitions) {
      const node: GraphNode = {
        id: symbolId(ex.file, def.localId),
        kind: def.kind,
        name: def.name,
        language: ex.language,
        file: ex.file,
        span: def.span,
      };
      // Like the pipeline: a top-level symbol's parent is the file node.
      node.parentId =
        def.parentLocalId !== undefined ? symbolId(ex.file, def.parentLocalId) : fileId(ex.file);
      add(node);
    }
  }
  for (const n of extraNodes) add(n);
  const supers = new Map<string, string[]>();
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

export function makeContext(
  extractions: FileExtraction[],
  bindings: Record<string, BindingMap> = {},
  overrides: Partial<ResolveContext> = {},
): ResolveContext {
  return {
    index: makeIndex(extractions),
    bindings: new Map(Object.entries(bindings)),
    language: "python",
    constructorNames: ["__init__"],
    ...overrides,
  };
}

export const sym = symbolId;
