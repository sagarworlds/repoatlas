import type { Definition, FileExtraction, GraphNode } from "@repoatlas/schema";
import { symbolId } from "@repoatlas/schema";
import { DEFAULT_MAX_INHERITANCE_DEPTH, type ResolveContext } from "./types.ts";

/** Super types of a class: the index's list followed by the context overlay, no duplicates. */
export function superTypesOf(ctx: ResolveContext, classId: string): string[] {
  const fromIndex = ctx.index.superTypesOf(classId);
  const fromOverlay = ctx.superTypes?.get(classId) ?? [];
  if (fromOverlay.length === 0) return fromIndex;
  return [...new Set([...fromIndex, ...fromOverlay])];
}

export interface MemberHit {
  node: GraphNode;
  /** True when found on the class itself, not on a super type. */
  direct: boolean;
}

function searchMember(
  ctx: ResolveContext,
  classId: string,
  name: string,
  visited: Set<string>,
  depth: number,
): MemberHit | undefined {
  const maxDepth = ctx.maxInheritanceDepth ?? DEFAULT_MAX_INHERITANCE_DEPTH;
  if (depth > maxDepth || visited.has(classId)) return undefined;
  visited.add(classId);
  const own = ctx.index.membersOf(classId).find((m) => m.name === name);
  if (own) return { node: own, direct: depth === 0 };
  // Depth-first, left-to-right over the declared bases.
  for (const superId of superTypesOf(ctx, classId)) {
    const hit = searchMember(ctx, superId, name, visited, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Member lookup on a class, then its super types (depth-first, left-to-right, cycle-safe). */
export function lookupMember(
  ctx: ResolveContext,
  classId: string,
  name: string,
): MemberHit | undefined {
  return searchMember(ctx, classId, name, new Set(), 0);
}

/** Member lookup in the super types of a class only (for `super().x()`). */
export function lookupInSuperTypes(
  ctx: ResolveContext,
  classId: string,
  name: string,
): MemberHit | undefined {
  const visited = new Set<string>([classId]);
  for (const superId of superTypesOf(ctx, classId)) {
    const hit = searchMember(ctx, superId, name, visited, 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Per-file lookup tables, cached per extraction object. */
export interface FileScope {
  byLocalId: Map<string, Definition>;
  /** parentLocalId ("" for top level) -> children in source order. */
  children: Map<string, Definition[]>;
}

const scopeCache = new WeakMap<FileExtraction, FileScope>();

export function fileScope(extraction: FileExtraction): FileScope {
  const cached = scopeCache.get(extraction);
  if (cached) return cached;
  const byLocalId = new Map<string, Definition>();
  const children = new Map<string, Definition[]>();
  for (const def of extraction.definitions) {
    byLocalId.set(def.localId, def);
    const key = def.parentLocalId ?? "";
    const list = children.get(key);
    if (list) list.push(def);
    else children.set(key, [def]);
  }
  const scope = { byLocalId, children };
  scopeCache.set(extraction, scope);
  return scope;
}

/** The innermost class/interface that encloses (or is) the definition `fromLocalId`. */
export function enclosingClass(
  extraction: FileExtraction,
  fromLocalId: string | undefined,
): Definition | undefined {
  if (fromLocalId === undefined) return undefined;
  const scope = fileScope(extraction);
  let current = scope.byLocalId.get(fromLocalId);
  // The loop is bounded by the number of definitions, so a bad parent cycle cannot hang.
  for (let steps = 0; current && steps <= extraction.definitions.length; steps++) {
    if (current.kind === "class" || current.kind === "interface") return current;
    current =
      current.parentLocalId === undefined ? undefined : scope.byLocalId.get(current.parentLocalId);
  }
  return undefined;
}

export function nodeIdOf(extraction: FileExtraction, def: Definition): string {
  return symbolId(extraction.file, def.localId);
}

/**
 * Lexical lookup of an unqualified name inside one file: innermost function scope first,
 * then enclosing function scopes, then module level. Class bodies are skipped because class
 * members are not visible unqualified. A later duplicate definition wins (rebinding).
 */
export function lookupLexical(
  extraction: FileExtraction,
  fromLocalId: string | undefined,
  name: string,
): Definition | undefined {
  const scope = fileScope(extraction);
  const lastNamed = (key: string): Definition | undefined => {
    const list = scope.children.get(key) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const def = list[i];
      if (def && def.name === name) return def;
    }
    return undefined;
  };
  let current = fromLocalId === undefined ? undefined : scope.byLocalId.get(fromLocalId);
  for (let steps = 0; current && steps <= extraction.definitions.length; steps++) {
    if (current.kind === "function" || current.kind === "method") {
      const hit = lastNamed(current.localId);
      if (hit) return hit;
    }
    current =
      current.parentLocalId === undefined ? undefined : scope.byLocalId.get(current.parentLocalId);
  }
  return lastNamed("");
}
