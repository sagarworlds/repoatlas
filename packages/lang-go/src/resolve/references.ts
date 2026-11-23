import type { ResolvedRef } from "@repoatlas/plugin-api";
import { isStoplisted, nameMatchCandidates } from "@repoatlas/plugin-api";
import type { Definition, GraphNode, RawReference } from "@repoatlas/schema";
import { hintType } from "./hint-types.ts";
import {
  EXTERNAL,
  exportedIn,
  type FileInfo,
  findFieldType,
  findMethod,
  isTypeNode,
  lookupTopLevel,
  lookupType,
  lookupTypeText,
  type ResolveState,
  type TypeLookup,
} from "./lookup.ts";
import { receiverOf } from "./packages.ts";
import { parseTypeName } from "./signature.ts";
import { GO_STOPLIST } from "./stoplist.ts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A found function or type. A type that is "called" (a conversion) is only a reference. */
function callHit(node: GraphNode, step: ResolvedRef["step"]): ResolvedRef {
  const target = { nodeId: node.id, confidence: "inferred" as const };
  if (isTypeNode(node)) return { targets: [target], asReference: true, step };
  return { targets: [target], step };
}

function noCandidate(): ResolvedRef {
  return { targets: [], unresolved: true, reason: "no-candidate" };
}

/**
 * A method name that no function or method in the repository has cannot be found by any
 * lookup: the call goes to an external package or a function value, so it is not counted.
 */
function missResult(state: ResolveState, name: string): ResolvedRef {
  return state.callableNames.has(name) ? noCandidate() : EXTERNAL;
}

/** Name-match for `x.M()` with an unknown receiver type: methods only, 1 to 3 candidates. */
function nameMatchReceiver(state: ResolveState, ref: RawReference): ResolvedRef {
  if (isStoplisted(ref.name, GO_STOPLIST)) return EXTERNAL;
  const candidates = nameMatchCandidates(state.index, ref.name, "go", true, GO_STOPLIST).filter(
    (n) => n.kind === "method",
  );
  if (candidates.length > 0) {
    const targets = candidates
      .map((n) => ({ nodeId: n.id, confidence: "name-match" as const }))
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    return { targets, step: "name-match" };
  }
  const anyMethod = (state.index.byShortName.get(ref.name) ?? []).some(
    (n) => n.language === "go" && n.kind === "method",
  );
  return anyMethod ? { targets: [], unresolved: true, reason: "ambiguous" } : EXTERNAL;
}

/** The method definition that encloses `fromLocalId` (the reference's source), if any. */
function enclosingMethod(fi: FileInfo, fromLocalId: string | undefined): Definition | undefined {
  let current = fromLocalId === undefined ? undefined : fi.defs.get(fromLocalId);
  for (let steps = 0; current !== undefined && steps <= fi.defs.size; steps++) {
    if (current.kind === "method") return current;
    current = current.parentLocalId === undefined ? undefined : fi.defs.get(current.parentLocalId);
  }
  return undefined;
}

/** Resolves `x.M()` once the receiver's type is known. Undefined when the type is unknown. */
function resolveByType(
  state: ResolveState,
  ref: RawReference,
  type: TypeLookup | undefined,
  step: ResolvedRef["step"],
): ResolvedRef | undefined {
  if (type === undefined || type.kind === "missing") return undefined;
  if (type.kind === "external") return EXTERNAL;
  const hit = findMethod(state, type.node, ref.name);
  switch (hit.kind) {
    case "method":
      return { targets: [{ nodeId: hit.node.id, confidence: "inferred" }], step };
    case "interface":
      // Interfaces are satisfied implicitly: no implements edges, so fall back to name-match.
      return nameMatchReceiver(state, ref);
    case "external":
      return EXTERNAL;
    case "none":
      return missResult(state, ref.name);
  }
}

/**
 * `s.repo.Find()` inside a method: the receiver variable gives the first type (needs
 * `meta["go.receiverVar"]` on the method), each following name is looked up in the struct
 * field table `meta["go.fields"]` of the previous type. Undefined when any step is unknown.
 */
function resolveChain(
  state: ResolveState,
  fi: FileInfo,
  ref: RawReference,
  receiver: string,
): ResolvedRef | undefined {
  const segments = receiver.split(".");
  const first = segments[0];
  if (first === undefined || !segments.every((s) => IDENTIFIER.test(s))) return undefined;
  const binding = fi.imports.bindings.get(first);
  if (binding !== undefined) return binding.kind === "external" ? EXTERNAL : undefined;
  const method = enclosingMethod(fi, ref.fromLocalId);
  if (method === undefined || method.meta?.["go.receiverVar"] !== first) return undefined;
  let type: TypeLookup = lookupType(fi, { qualifier: undefined, name: receiverOf(method) });
  for (const segment of segments.slice(1)) {
    if (type.kind === "external") return EXTERNAL;
    if (type.kind !== "type") return undefined;
    const field = findFieldType(state, type.node, segment);
    const ownerFile =
      field?.owner.file === undefined ? undefined : state.files.get(field.owner.file);
    if (field === undefined || ownerFile === undefined) return undefined;
    const next = lookupTypeText(ownerFile, field.text);
    if (next === undefined) return undefined;
    type = next;
  }
  return resolveByType(state, ref, type, "type-hint");
}

/** `foo()`: same package (any file), then dot imports. Anything else is a local function value. */
function resolveBareCall(fi: FileInfo, ref: RawReference): ResolvedRef {
  const hit = lookupTopLevel(fi, ref.name, () => true);
  if (hit) return callHit(hit, "same-scope");
  // Go scopes are closed: a bare name that is not in the package or a dot import can only be
  // a builtin, a parameter or local variable holding a function, or a dot-imported external.
  return EXTERNAL;
}

function resolveCall(state: ResolveState, fi: FileInfo, ref: RawReference): ResolvedRef {
  const { receiver, receiverKind: kind } = ref;
  if (kind === "self") {
    const method = enclosingMethod(fi, ref.fromLocalId);
    if (method !== undefined) {
      const type = lookupType(fi, { qualifier: undefined, name: receiverOf(method) });
      const resolved = resolveByType(state, ref, type, "self");
      if (resolved) return resolved;
    }
    return nameMatchReceiver(state, ref);
  }
  if (receiver === undefined && kind === undefined) return resolveBareCall(fi, ref);

  // A receiver bound locally (hint other than "pkgvar:") shadows an imported package name.
  const hint = ref.receiverTypeHint;
  const shadowed = hint !== undefined && !hint.startsWith("pkgvar:");
  if (!shadowed && receiver !== undefined && (kind === undefined || kind === "identifier")) {
    const binding = fi.imports.bindings.get(receiver);
    if (binding?.kind === "external") return EXTERNAL;
    if (binding?.kind === "internal") {
      const node = exportedIn(binding.dir, ref.name)[0];
      return node ? callHit(node, "import-member") : noCandidate();
    }
  }
  if (ref.receiverTypeHint !== undefined) {
    const resolved = resolveByType(
      state,
      ref,
      hintType(state, fi, ref.receiverTypeHint, 0),
      "type-hint",
    );
    if (resolved) return resolved;
  }
  if (receiver?.includes(".")) {
    const resolved = resolveChain(state, fi, ref, receiver);
    if (resolved) return resolved;
  }
  // An unbound identifier in a file with an unaliased third-party import may be that package
  // (its real name differs from the guess): the call cannot target a repository method.
  if (
    receiver !== undefined &&
    kind === "identifier" &&
    hint === `pkgvar:${receiver}` &&
    fi.imports.guessedExternal
  ) {
    return EXTERNAL;
  }
  return nameMatchReceiver(state, ref);
}

/** extends (embedding), type references and instantiation: a lookup of a type name. */
export function resolveTypeReference(fi: FileInfo, ref: RawReference): ResolvedRef {
  const parsed =
    ref.receiver !== undefined
      ? { qualifier: ref.receiver, name: ref.name }
      : (parseTypeName(ref.name) ?? { qualifier: undefined, name: ref.name });
  const type = lookupType(fi, parsed);
  if (type.kind === "type") {
    return {
      targets: [{ nodeId: type.node.id, confidence: "exact" }],
      asReference: true,
      step: "type-name",
    };
  }
  if (type.kind === "missing" && type.qualifiedMiss) return noCandidate();
  // Type parameters, local types and predeclared types are not repository symbols.
  return EXTERNAL;
}

/**
 * Resolves one reference of a Go file (see docs in LANGUAGE_PLUGINS section 6, Go). Pure:
 * reads `state`, never changes it.
 */
export function resolveGoReference(
  state: ResolveState,
  fi: FileInfo,
  ref: RawReference,
): ResolvedRef {
  if (ref.kind === "call") return resolveCall(state, fi, ref);
  return resolveTypeReference(fi, ref);
}
