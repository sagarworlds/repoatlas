import type { ResolveContext, ResolvedRef, SymbolIndex } from "@repoatlas/plugin-api";
import { superTypesOf } from "@repoatlas/plugin-api";
import type { Definition, FileExtraction, GraphNode } from "@repoatlas/schema";
import type { FileImports } from "./imports.ts";
import { type DirData, isExportedName, type PackageData } from "./packages.ts";
import { parseTypeName, type TypeName } from "./signature.ts";
import { GO_PREDECLARED_TYPES } from "./stoplist.ts";

/** Everything the lookups know about one file. */
export interface FileInfo {
  extraction: FileExtraction;
  pkg: PackageData;
  dir: DirData;
  isTest: boolean;
  imports: FileImports;
  defs: Map<string, Definition>;
}

export interface ResolveState {
  ctx: ResolveContext;
  index: SymbolIndex;
  files: Map<string, FileInfo>;
  /** Symbol node id -> its definition (for meta and signature). */
  defById: Map<string, Definition>;
  /** Names of every function and method defined in the Go files (for "can this exist here"). */
  callableNames: Set<string>;
  /** Types with an embedded type that is not a repository type (methods may come from it). */
  externalEmbeds: Set<string>;
}

/** A call that cannot be resolved inside the repository by design: not counted either way. */
export const EXTERNAL: ResolvedRef = { targets: [], unresolved: true, reason: "external" };

export const isTypeNode = (n: GraphNode): boolean => n.kind === "class" || n.kind === "interface";

function pickNode(nodes: readonly GraphNode[] | undefined, file: string): GraphNode | undefined {
  if (nodes === undefined || nodes.length === 0) return undefined;
  return nodes.find((n) => n.file === file) ?? nodes[0];
}

/** Exported top-level name of a directory's importable package. */
export function exportedIn(dir: DirData, name: string): GraphNode[] {
  if (!isExportedName(name)) return [];
  return dir.primary?.topNonTest.get(name) ?? [];
}

/** Same-package top-level lookup. Test files also see the non-test package of the directory. */
export function scopeLookup(fi: FileInfo, name: string): GraphNode[] {
  const own = (fi.isTest ? fi.pkg.topAll : fi.pkg.topNonTest).get(name);
  if (own !== undefined && own.length > 0) return own;
  if (fi.isTest && fi.dir.primary !== undefined && fi.dir.primary !== fi.pkg) {
    return fi.dir.primary.topNonTest.get(name) ?? [];
  }
  return [];
}

export function dotLookup(fi: FileInfo, name: string): GraphNode[] {
  for (const dir of fi.imports.dots) {
    const hit = exportedIn(dir, name);
    if (hit.length > 0) return hit;
  }
  return [];
}

/** First same-package or dot-imported top-level node named `name` that satisfies `accept`. */
export function lookupTopLevel(
  fi: FileInfo,
  name: string,
  accept: (n: GraphNode) => boolean,
): GraphNode | undefined {
  const file = fi.extraction.file;
  return (
    pickNode(scopeLookup(fi, name).filter(accept), file) ??
    pickNode(dotLookup(fi, name).filter(accept), file)
  );
}

export type TypeLookup =
  | { kind: "type"; node: GraphNode }
  | { kind: "external" }
  | { kind: "missing"; qualifiedMiss: boolean };

/** Looks a (possibly package-qualified) type name up from the point of view of `fi`. */
export function lookupType(fi: FileInfo, type: TypeName): TypeLookup {
  if (type.qualifier !== undefined) {
    const binding = fi.imports.bindings.get(type.qualifier);
    if (binding === undefined) return { kind: "missing", qualifiedMiss: false };
    if (binding.kind === "external") return { kind: "external" };
    const hit = exportedIn(binding.dir, type.name).find(isTypeNode);
    return hit ? { kind: "type", node: hit } : { kind: "missing", qualifiedMiss: true };
  }
  const own = lookupTopLevel(fi, type.name, isTypeNode);
  if (own) return { kind: "type", node: own };
  if (GO_PREDECLARED_TYPES.has(type.name) || fi.imports.externalDot) return { kind: "external" };
  return { kind: "missing", qualifiedMiss: false };
}

/** Looks up type text such as `*pkg.Server[T]`; undefined when it names no single type. */
export function lookupTypeText(fi: FileInfo, text: string): TypeLookup | undefined {
  const parsed = parseTypeName(text);
  return parsed === undefined ? undefined : lookupType(fi, parsed);
}

export type MethodHit =
  | { kind: "method"; node: GraphNode }
  | { kind: "interface" }
  | { kind: "external" }
  | { kind: "none" };

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Method `name` on a type: its own method set (methods may sit in any file of the type's
 * package), then the embedded types in declaration order (depth first, cycle safe), using
 * the super types recorded by `applySuperTypes`. A method found on an interface (declared
 * in `meta["go.methods"]`) has no node; an unresolvable embedded type may hide the method.
 */
export function findMethod(state: ResolveState, type: GraphNode, name: string): MethodHit {
  const visited = new Set<string>();
  let sawExternal = false;
  const search = (node: GraphNode, depth: number): MethodHit | undefined => {
    if (depth > 32 || visited.has(node.id)) return undefined;
    visited.add(node.id);
    if (state.externalEmbeds.has(node.id)) sawExternal = true;
    const def = state.defById.get(node.id);
    if (def?.kind === "interface") {
      const declared = def.meta?.["go.methods"];
      if (isStringList(declared) && declared.includes(name)) return { kind: "interface" };
    }
    const pkg = node.file === undefined ? undefined : state.files.get(node.file)?.pkg;
    const own = pkg?.methods.get(node.name)?.get(name);
    if (own) return { kind: "method", node: own };
    for (const superId of superTypesOf(state.ctx, node.id)) {
      const superNode = state.index.byId.get(superId);
      const hit = superNode === undefined ? undefined : search(superNode, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return search(type, 0) ?? (sawExternal ? { kind: "external" } : { kind: "none" });
}

/** Type text of struct field `field`, looked up on the struct and its embedded types. */
export function findFieldType(
  state: ResolveState,
  struct: GraphNode,
  field: string,
): { owner: GraphNode; text: string } | undefined {
  const visited = new Set<string>();
  const search = (
    node: GraphNode,
    depth: number,
  ): { owner: GraphNode; text: string } | undefined => {
    if (depth > 32 || visited.has(node.id)) return undefined;
    visited.add(node.id);
    const fields = state.defById.get(node.id)?.meta?.["go.fields"];
    if (typeof fields === "object" && fields !== null && !Array.isArray(fields)) {
      const text = (fields as Record<string, unknown>)[field];
      if (typeof text === "string") return { owner: node, text };
    }
    for (const superId of superTypesOf(state.ctx, node.id)) {
      const superNode = state.index.byId.get(superId);
      const hit = superNode === undefined ? undefined : search(superNode, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return search(struct, 0);
}
