import {
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
import { isExportedName } from "./packages.ts";
import { parseResultType } from "./signature.ts";

/**
 * Evaluation of the receiver type hints made by the Go spec (see spec/receiver-type.ts):
 *
 * - `Server`, `pkg.Client`: a type name.
 * - `call:NewT`, `call:pkg.NewT`: the first result type of that function.
 * - `base/f:field/m:Method`: a base followed by struct field and method-result steps.
 * - `pkgvar:name`: a package-level variable (of this package, or `pkgvar:pkg/f:Var` of an
 *   imported one), typed from the hint stored in `meta["go.vars"]`.
 * - `a|b`: alternatives, accepted only when every alternative names the same type.
 */

const CONSTRUCTOR_PREFIX = "call:";
const PKGVAR_PREFIX = "pkgvar:";
const MAX_DEPTH = 8;

const isFunctionNode = (n: { kind: string }): boolean => n.kind === "function";

/** First result type of a function or method node, looked up where it is declared. */
function resultType(
  state: ResolveState,
  callee: { id: string; file?: string | undefined; signature?: string | undefined },
): TypeLookup | undefined {
  const signature = callee.signature ?? state.defById.get(callee.id)?.signature;
  const result = signature === undefined ? undefined : parseResultType(signature);
  const file = callee.file === undefined ? undefined : state.files.get(callee.file);
  if (result === undefined || file === undefined) return undefined;
  return lookupType(file, result);
}

/** Result type of method `name` called on `type`. */
function methodResult(state: ResolveState, type: TypeLookup, name: string): TypeLookup | undefined {
  if (type.kind === "external") return type;
  if (type.kind !== "type") return undefined;
  const hit = findMethod(state, type.node, name);
  if (hit.kind === "external") return { kind: "external" };
  return hit.kind === "method" ? resultType(state, hit.node) : undefined;
}

function fieldType(state: ResolveState, type: TypeLookup, name: string): TypeLookup | undefined {
  if (type.kind === "external") return type;
  if (type.kind !== "type") return undefined;
  const field = findFieldType(state, type.node, name);
  const ownerFile = field?.owner.file === undefined ? undefined : state.files.get(field.owner.file);
  if (field === undefined || ownerFile === undefined) return undefined;
  return lookupTypeText(ownerFile, field.text);
}

/** Type of package-level variable `name` of the package of `fi`, or of the imported `other`. */
function packageVarType(
  state: ResolveState,
  fi: FileInfo,
  name: string,
  other: FileInfo["dir"] | undefined,
  depth: number,
): TypeLookup | undefined {
  let declared: { file: string; hint: string } | undefined;
  if (other !== undefined) {
    if (isExportedName(name)) declared = other.primary?.vars.get(name);
  } else {
    declared = fi.pkg.vars.get(name);
    if (declared === undefined && fi.isTest) declared = fi.dir.primary?.vars.get(name);
  }
  const declaringFile = declared === undefined ? undefined : state.files.get(declared.file);
  if (declared === undefined || declaringFile === undefined) return undefined;
  return hintType(state, declaringFile, declared.hint, depth + 1);
}

interface Start {
  type: TypeLookup | undefined;
  /** How many leading steps the base itself consumed. */
  consumed: number;
}

/** The type a chain starts with, from its base (`call:...`, `pkgvar:...` or a type name). */
function baseType(
  state: ResolveState,
  fi: FileInfo,
  base: string,
  steps: string[],
  depth: number,
): Start {
  if (base.startsWith(PKGVAR_PREFIX)) {
    const name = base.slice(PKGVAR_PREFIX.length);
    const binding = fi.imports.bindings.get(name);
    if (binding === undefined) {
      return { type: packageVarType(state, fi, name, undefined, depth), consumed: 0 };
    }
    if (binding.kind === "external") return { type: { kind: "external" }, consumed: 0 };
    const first = steps[0];
    if (first === undefined || !first.startsWith("f:")) return { type: undefined, consumed: 0 };
    return {
      type: packageVarType(state, fi, first.slice(2), binding.dir, depth),
      consumed: 1,
    };
  }
  if (!base.startsWith(CONSTRUCTOR_PREFIX)) return { type: lookupTypeText(fi, base), consumed: 0 };

  // call:NewT, call:pkg.NewT, or call:var.Method (a method of a package-level variable).
  const spec = base.slice(CONSTRUCTOR_PREFIX.length);
  const dot = spec.lastIndexOf(".");
  const qualifier = dot < 0 ? undefined : spec.slice(0, dot);
  const name = dot < 0 ? spec : spec.slice(dot + 1);
  if (qualifier === undefined) {
    const callee = lookupTopLevel(fi, name, isFunctionNode);
    if (callee !== undefined) return { type: resultType(state, callee), consumed: 0 };
    // T(x) with a repository type T is a conversion: the value has type T.
    const conversion = lookupTopLevel(fi, name, isTypeNode);
    const type: TypeLookup | undefined =
      conversion === undefined ? undefined : { kind: "type", node: conversion };
    return { type, consumed: 0 };
  }
  const binding = fi.imports.bindings.get(qualifier);
  if (binding === undefined) {
    const owner = packageVarType(state, fi, qualifier, undefined, depth);
    return {
      type: owner === undefined ? undefined : methodResult(state, owner, name),
      consumed: 0,
    };
  }
  if (binding.kind === "external") return { type: { kind: "external" }, consumed: 0 };
  const callee = exportedIn(binding.dir, name).find(isFunctionNode);
  return { type: callee === undefined ? undefined : resultType(state, callee), consumed: 0 };
}

function singleHintType(
  state: ResolveState,
  fi: FileInfo,
  hint: string,
  depth: number,
): TypeLookup | undefined {
  const [base, ...steps] = hint.split("/");
  if (base === undefined) return undefined;
  const start = baseType(state, fi, base, steps, depth);
  let type = start.type;
  for (const step of steps.slice(start.consumed)) {
    if (type === undefined || type.kind === "missing") return undefined;
    const name = step.slice(2);
    type = step.startsWith("f:") ? fieldType(state, type, name) : methodResult(state, type, name);
  }
  return type;
}

/**
 * The type a receiver hint stands for, or undefined when it cannot be determined. Alternatives
 * (`a|b`) must all give the same repository type (or all be external).
 */
export function hintType(
  state: ResolveState,
  fi: FileInfo,
  hint: string,
  depth: number,
): TypeLookup | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let agreed: TypeLookup | undefined;
  for (const alternative of hint.split("|")) {
    const type = singleHintType(state, fi, alternative, depth);
    if (type === undefined || type.kind === "missing") return undefined;
    if (agreed === undefined) agreed = type;
    else if (agreed.kind !== type.kind) return undefined;
    else if (agreed.kind === "type" && type.kind === "type" && agreed.node.id !== type.node.id) {
      return undefined;
    }
  }
  return agreed;
}
