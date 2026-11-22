import type { Confidence, FileExtraction, GraphNode, RawReference } from "@repoatlas/schema";
import { nameMatchCandidates } from "../helpers.ts";
import { isStoplisted } from "../stoplist.ts";
import { isExternalId } from "./bindings.ts";
import {
  enclosingClass,
  lookupInSuperTypes,
  lookupLexical,
  lookupMember,
  nodeIdOf,
} from "./members.ts";
import {
  EXTERNAL_RESULT,
  filesOfModuleId,
  findInFile,
  isTypeNode,
  lookupType,
  resolveTypeName,
} from "./type-name.ts";
import type { ResolutionStep, ResolveContext, ResolvedRef } from "./types.ts";

const isAny = (): boolean => true;

/**
 * Turns a found node into a result. A class that is called (`User()`) maps to its
 * constructor when the plugin names constructors and one exists (searching super types);
 * otherwise the class itself is returned with `asReference`.
 */
function finish(
  ctx: ResolveContext,
  ref: RawReference,
  node: GraphNode,
  confidence: Confidence,
  step: ResolutionStep,
): ResolvedRef {
  const isConstruction = ref.kind === "call" || ref.kind === "instantiate";
  if (node.kind === "class" && isConstruction) {
    for (const ctorName of ctx.constructorNames ?? []) {
      const ctor = lookupMember(ctx, node.id, ctorName);
      if (ctor) return { targets: [{ nodeId: ctor.node.id, confidence }], step };
    }
    return { targets: [{ nodeId: node.id, confidence }], asReference: true, step };
  }
  return { targets: [{ nodeId: node.id, confidence }], step };
}

/** Step 1: `self.x()` */
function resolveSelf(
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
): ResolvedRef | undefined {
  const cls = enclosingClass(extraction, ref.fromLocalId);
  if (!cls) return undefined;
  const hit = lookupMember(ctx, nodeIdOf(extraction, cls), ref.name);
  if (!hit) return undefined;
  const confidence = ctx.exactSelf === true && hit.direct ? "exact" : "inferred";
  return finish(ctx, ref, hit.node, confidence, "self");
}

/** Step 2: `super().x()` */
function resolveSuper(
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
): ResolvedRef | undefined {
  const cls = enclosingClass(extraction, ref.fromLocalId);
  if (!cls) return undefined;
  const hit = lookupInSuperTypes(ctx, nodeIdOf(extraction, cls), ref.name);
  return hit ? finish(ctx, ref, hit.node, "inferred", "super") : undefined;
}

/** Step 3: `f()` with no receiver. */
function resolveUnqualified(
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
): ResolvedRef | undefined {
  const def = lookupLexical(extraction, ref.fromLocalId, ref.name);
  if (def) {
    const node = ctx.index.byId.get(nodeIdOf(extraction, def));
    if (node) return finish(ctx, ref, node, "inferred", "local");
  }

  const binding = ctx.bindings.get(extraction.file)?.get(ref.name);
  if (binding) {
    // Calling an external name makes no edge: the file-level imports edge covers it.
    if (isExternalId(binding.nodeId)) return EXTERNAL_RESULT;
    const node = ctx.index.byId.get(binding.nodeId);
    if (node) return finish(ctx, ref, node, binding.confidence, "binding");
  }

  const scoped = ctx.sameScopeLookup?.(ref.name, extraction)[0];
  if (scoped) return finish(ctx, ref, scoped, "inferred", "same-scope");
  return undefined;
}

/** Step 4: `mod.f()` where `mod` is bound by an import to a module or external package. */
function resolveImportReceiver(
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
  receiver: string,
): ResolvedRef | undefined {
  const binding = ctx.bindings.get(extraction.file)?.get(receiver);
  if (!binding) return undefined;
  if (isExternalId(binding.nodeId)) return EXTERNAL_RESULT;
  for (const file of filesOfModuleId(ctx, binding.nodeId)) {
    const found = findInFile(ctx, file, ref.name, isAny);
    if (found && "external" in found) return EXTERNAL_RESULT;
    if (found) return finish(ctx, ref, found.node, "inferred", "import-member");
  }
  return undefined;
}

/** Looks `ref.name` up as a member of the class that `typeName` names (steps 5 and 6). */
function resolveMemberOfType(
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
  typeName: string,
  step: ResolutionStep,
): ResolvedRef | undefined {
  const type = lookupType(ctx, extraction, typeName, undefined, false);
  if (type.reason === "external") return type;
  const owner = type.targets[0];
  if (!owner) return undefined;
  const node = ctx.index.byId.get(owner.nodeId);
  if (!node || !isTypeNode(node)) return undefined;
  const hit = lookupMember(ctx, node.id, ref.name);
  return hit ? finish(ctx, ref, hit.node, "inferred", step) : undefined;
}

/** Step 7: global name-match. */
function nameMatch(ctx: ResolveContext, ref: RawReference, hasReceiver: boolean): ResolvedRef {
  const candidates = nameMatchCandidates(
    ctx.index,
    ref.name,
    ctx.language,
    hasReceiver,
    ctx.stoplistExtra,
  );
  if (candidates.length > 0) {
    const targets = candidates
      .map((n) => ({ nodeId: n.id, confidence: "name-match" as const }))
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    return { targets, step: "name-match" };
  }
  const anyCallable = (ctx.index.byShortName.get(ref.name) ?? []).some(
    (n) => n.language === ctx.language && (n.kind === "function" || n.kind === "method"),
  );
  const reason =
    anyCallable && !isStoplisted(ref.name, ctx.stoplistExtra) ? "ambiguous" : "no-candidate";
  return { targets: [], unresolved: true, reason };
}

function resolveCallLike(
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
): ResolvedRef {
  const kind = ref.receiverKind;
  const hasReceiver = ref.receiver !== undefined || kind !== undefined;
  let result: ResolvedRef | undefined;

  if (kind === "self") {
    result = resolveSelf(ctx, extraction, ref);
  } else if (kind === "super") {
    // A missed `super().m()` is never name-matched: the name would most likely match the
    // calling method itself (`def m(self): super().m()`) or an unrelated class.
    return (
      resolveSuper(ctx, extraction, ref) ?? {
        targets: [],
        unresolved: true,
        reason: "no-candidate",
      }
    );
  } else if (!hasReceiver) {
    result = resolveUnqualified(ctx, extraction, ref);
  } else {
    const receiver = ref.receiver;
    const isIdentifier = receiver !== undefined && (kind === undefined || kind === "identifier");
    if (isIdentifier) {
      result =
        resolveImportReceiver(ctx, extraction, ref, receiver) ??
        resolveMemberOfType(ctx, extraction, ref, receiver, "static");
    }
    if (!result && ref.receiverTypeHint !== undefined) {
      result = resolveMemberOfType(ctx, extraction, ref, ref.receiverTypeHint, "type-hint");
    }
  }
  return result ?? nameMatch(ctx, ref, hasReceiver);
}

/**
 * Resolves one reference following LANGUAGE_PLUGINS §5 and stopping at the first hit.
 * Pure: never mutates its inputs. See `ResolvedRef` for the result conventions.
 */
export function resolveReference(
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
): ResolvedRef {
  if (ref.kind === "extends" || ref.kind === "implements" || ref.kind === "type") {
    return resolveTypeName(ctx, extraction, ref.name, ref.receiver);
  }
  return resolveCallLike(ctx, extraction, ref);
}
