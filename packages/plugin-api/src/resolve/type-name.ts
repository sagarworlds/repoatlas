import type { FileExtraction, GraphNode } from "@repoatlas/schema";
import { isStoplisted, MAX_NAME_MATCH_CANDIDATES } from "../stoplist.ts";
import { isExternalId, isFileId, isModuleId, isTopLevelSymbol } from "./bindings.ts";
import { lookupMember, nodeIdOf } from "./members.ts";
import type { ResolveContext, ResolvedRef } from "./types.ts";

export const isTypeNode = (n: GraphNode): boolean => n.kind === "class" || n.kind === "interface";

export const EXTERNAL_RESULT: ResolvedRef = { targets: [], unresolved: true, reason: "external" };

/** Files a module-like binding target stands for ("file:a/b.py" or "mod:python:a.b"). */
export function filesOfModuleId(ctx: ResolveContext, nodeId: string): string[] {
  if (isFileId(nodeId)) return [nodeId.slice("file:".length)];
  if (isModuleId(nodeId)) {
    const key = nodeId.split(":").slice(2).join(":");
    return ctx.index.moduleToFiles.get(key) ?? [];
  }
  return [];
}

export type FileMemberResult = { node: GraphNode } | { external: true } | undefined;

/**
 * Looks `name` up among the top-level symbols of `file`, then follows ONE level of
 * re-export through that file's binding map (a re-exported name bound to a symbol).
 */
export function findInFile(
  ctx: ResolveContext,
  file: string,
  name: string,
  accept: (n: GraphNode) => boolean,
): FileMemberResult {
  const own = (ctx.index.byFile.get(file) ?? []).find(
    (n) => isTopLevelSymbol(n) && n.name === name && accept(n),
  );
  if (own) return { node: own };
  const binding = ctx.bindings.get(file)?.get(name);
  if (!binding) return undefined;
  if (isExternalId(binding.nodeId)) return { external: true };
  const target = ctx.index.byId.get(binding.nodeId);
  return target && accept(target) ? { node: target } : undefined;
}

/** Name-match for type names: 1..3 same-language classes/interfaces, never stoplisted. */
function typeNameMatch(ctx: ResolveContext, name: string): ResolvedRef {
  if (isStoplisted(name, ctx.stoplistExtra)) {
    return { targets: [], unresolved: true, reason: "no-candidate" };
  }
  const pool = (ctx.index.byShortName.get(name) ?? []).filter(
    (n) => n.language === ctx.language && isTypeNode(n),
  );
  if (pool.length === 0) return { targets: [], unresolved: true, reason: "no-candidate" };
  if (pool.length > MAX_NAME_MATCH_CANDIDATES) {
    return { targets: [], unresolved: true, reason: "ambiguous" };
  }
  const targets = pool
    .map((n) => ({ nodeId: n.id, confidence: "name-match" as const }))
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return { targets, step: "name-match" };
}

/** Same-file class/interface named `name`: module level preferred, else any nested one. */
function sameFileType(
  ctx: ResolveContext,
  extraction: FileExtraction,
  name: string,
): GraphNode | undefined {
  const candidates = extraction.definitions.filter((d) => d.name === name);
  const topLevel = candidates.filter((d) => d.parentLocalId === undefined);
  // Later top-level duplicates win (rebinding), then nested ones in source order.
  const ordered = [
    ...topLevel.reverse(),
    ...candidates.filter((d) => d.parentLocalId !== undefined),
  ];
  for (const def of ordered) {
    const node = ctx.index.byId.get(nodeIdOf(extraction, def));
    if (node && isTypeNode(node)) return node;
  }
  return undefined;
}

function typeHit(node: GraphNode, confidence: "exact" | "inferred" | "name-match"): ResolvedRef {
  return { targets: [{ nodeId: node.id, confidence }], step: "type-name" };
}

/** Resolves `receiver.name` (qualified type) through the receiver's binding. */
function qualifiedType(
  ctx: ResolveContext,
  extraction: FileExtraction,
  receiver: string,
  name: string,
): ResolvedRef | undefined {
  const fileBindings = ctx.bindings.get(extraction.file);
  const firstSegment = receiver.split(".")[0] ?? receiver;
  const binding = fileBindings?.get(receiver) ?? fileBindings?.get(firstSegment);
  if (!binding) return undefined;
  if (isExternalId(binding.nodeId)) return EXTERNAL_RESULT;
  for (const file of filesOfModuleId(ctx, binding.nodeId)) {
    const found = findInFile(ctx, file, name, isTypeNode);
    if (found && "external" in found) return EXTERNAL_RESULT;
    if (found) return typeHit(found.node, "inferred");
  }
  const owner = ctx.index.byId.get(binding.nodeId);
  if (owner && isTypeNode(owner)) {
    const nested = lookupMember(ctx, owner.id, name);
    if (nested && isTypeNode(nested.node)) return typeHit(nested.node, "inferred");
  }
  return undefined;
}

/**
 * Looks a type name up. With `allowNameMatch` false, a miss is reported as unresolved
 * without falling back to a global name search (used for receivers and type hints).
 */
export function lookupType(
  ctx: ResolveContext,
  extraction: FileExtraction,
  name: string,
  receiver: string | undefined,
  allowNameMatch: boolean,
): ResolvedRef {
  let typeName = name;
  let qualifier = receiver;
  if (qualifier === undefined && name.includes(".")) {
    const dot = name.lastIndexOf(".");
    qualifier = name.slice(0, dot);
    typeName = name.slice(dot + 1);
  }

  if (qualifier !== undefined) {
    const found = qualifiedType(ctx, extraction, qualifier, typeName);
    if (found) return found;
  } else {
    const local = sameFileType(ctx, extraction, typeName);
    if (local) return typeHit(local, "inferred");

    const binding = ctx.bindings.get(extraction.file)?.get(typeName);
    if (binding) {
      if (isExternalId(binding.nodeId)) return EXTERNAL_RESULT;
      const target = ctx.index.byId.get(binding.nodeId);
      if (target && isTypeNode(target)) return typeHit(target, binding.confidence);
    }

    const scoped = ctx.sameScopeLookup?.(typeName, extraction).find(isTypeNode);
    if (scoped) return typeHit(scoped, "inferred");
  }

  if (allowNameMatch) return typeNameMatch(ctx, typeName);
  return { targets: [], unresolved: true, reason: "no-candidate" };
}

/**
 * Resolves a type name used by extends/implements/type references:
 * same file -> imports -> sameScopeLookup -> name-match. `receiver` is the qualifier of
 * `pkg.Base` style names (a dotted `name` is split automatically).
 */
export function resolveTypeName(
  ctx: ResolveContext,
  extraction: FileExtraction,
  name: string,
  receiver?: string,
): ResolvedRef {
  return lookupType(ctx, extraction, name, receiver, true);
}
