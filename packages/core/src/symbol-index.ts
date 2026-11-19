import type { SymbolIndex } from "@repoatlas/plugin-api";
import type { GraphNode } from "@repoatlas/schema";

/** SymbolIndex plus the mutators core uses while the pipeline fills it in. */
export interface MutableSymbolIndex extends SymbolIndex {
  /** Records that `subId` extends/implements `superId` (deduplicated, insertion ordered). */
  addSuperType(subId: string, superId: string): void;
  /** Registers files for a language-specific module key (deduplicated, sorted). */
  setModuleFiles(key: string, files: string[]): void;
}

const SYMBOL_KINDS: ReadonlySet<GraphNode["kind"]> = new Set([
  "class",
  "interface",
  "function",
  "method",
]);

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic order: file, then start line, then id. */
function compareSymbols(a: GraphNode, b: GraphNode): number {
  return (
    compareCodeUnits(a.file ?? "", b.file ?? "") ||
    (a.span?.startLine ?? 0) - (b.span?.startLine ?? 0) ||
    compareCodeUnits(a.id, b.id)
  );
}

function pushTo(map: Map<string, GraphNode[]>, key: string, node: GraphNode): void {
  const list = map.get(key);
  if (list) list.push(node);
  else map.set(key, [node]);
}

/**
 * Builds the global symbol index from graph nodes. Only class/interface/function/method
 * nodes are indexed. Short-name lookups mix languages, so callers must filter by
 * `node.language` (the language is kept on every node).
 */
export function buildSymbolIndex(nodes: readonly GraphNode[]): MutableSymbolIndex {
  const symbols = nodes.filter((n) => SYMBOL_KINDS.has(n.kind)).sort(compareSymbols);

  const byId = new Map<string, GraphNode>();
  const byFile = new Map<string, GraphNode[]>();
  const byQualifiedName = new Map<string, GraphNode[]>();
  const byShortName = new Map<string, GraphNode[]>();
  const members = new Map<string, GraphNode[]>();

  for (const node of symbols) {
    byId.set(node.id, node);
    if (node.file !== undefined) pushTo(byFile, node.file, node);
    if (node.qualifiedName !== undefined) pushTo(byQualifiedName, node.qualifiedName, node);
    pushTo(byShortName, node.name, node);
    if (node.parentId !== undefined) pushTo(members, node.parentId, node);
  }

  const superTypes = new Map<string, string[]>();
  const moduleToFiles = new Map<string, string[]>();

  return {
    byId,
    byFile,
    byQualifiedName,
    byShortName,
    moduleToFiles,
    membersOf: (classId) => members.get(classId) ?? [],
    superTypesOf: (classId) => superTypes.get(classId) ?? [],
    addSuperType(subId, superId) {
      const list = superTypes.get(subId);
      if (!list) superTypes.set(subId, [superId]);
      else if (!list.includes(superId)) list.push(superId);
    },
    setModuleFiles(key, files) {
      moduleToFiles.set(key, [...new Set(files)].sort(compareCodeUnits));
    },
  };
}
