import { MAX_NAME_MATCH_CANDIDATES } from "@repoatlas/plugin-api";
import type { Confidence } from "@repoatlas/schema";
import { ENUM_METHODS, GENERATING_ANNOTATIONS, OBJECT_METHODS } from "./java-names.ts";
import type { ClassInfo, MethodInfo } from "./model.ts";
import { hierarchyOf, type ResolveState } from "./scope.ts";

export interface MethodTarget {
  method: MethodInfo;
  confidence: Confidence;
}

/** Overload choice for one call: the targets (possibly several) or why there are none. */
export interface MethodChoice {
  targets: MethodTarget[];
  /** True when several overloads fit and none could be preferred. */
  ambiguous: boolean;
}

/** A method accepts `argCount` arguments (unknown counts accept anything). */
function acceptsArity(method: MethodInfo, argCount: number | undefined): boolean {
  if (argCount === undefined || method.params === undefined) return true;
  if (method.varargs) return argCount >= method.params - 1;
  return method.params === argCount;
}

/**
 * Methods named `name` in the first class of the hierarchy (the class, then its super types
 * depth-first) that declares one the call can match. A subclass declaration therefore hides
 * an overridden one. When some class declares the name but no declaration accepts the
 * argument count, those declarations are returned with `arityMismatch`.
 */
export function findMethods(
  state: ResolveState,
  classes: readonly ClassInfo[],
  name: string,
  argCount: number | undefined,
): { methods: MethodInfo[]; arityMismatch: boolean } | undefined {
  let firstNamed: MethodInfo[] | undefined;
  for (const start of classes) {
    for (const cls of hierarchyOf(state, start)) {
      const named = cls.methods.get(name);
      if (named === undefined || named.length === 0) continue;
      const fitting = named.filter((m) => acceptsArity(m, argCount));
      if (fitting.length > 0) return { methods: fitting, arityMismatch: false };
      firstNamed ??= named;
    }
  }
  return firstNamed === undefined ? undefined : { methods: firstNamed, arityMismatch: true };
}

/** Constructors of `cls` that accept `argCount` arguments. */
export function fittingConstructors(cls: ClassInfo, argCount: number | undefined): MethodInfo[] {
  return cls.ctors.filter((c) => acceptsArity(c, argCount));
}

/**
 * Overload picking by argument count. One fitting method: it. Several: the single one with
 * exactly that many (non-varargs) parameters, else the single varargs one. Anything else is
 * ambiguous: up to three candidates become `name-match` targets, more become none.
 */
export function chooseOverload(
  methods: readonly MethodInfo[],
  argCount: number | undefined,
  arityMismatch: boolean,
): MethodChoice {
  const sorted = [...methods].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const only = sorted.length === 1 ? sorted[0] : undefined;
  if (only !== undefined && !arityMismatch) {
    return { targets: [{ method: only, confidence: "inferred" }], ambiguous: false };
  }
  if (!arityMismatch && argCount !== undefined) {
    const exact = sorted.filter((m) => m.params === argCount && !m.varargs);
    const exactOne = exact.length === 1 ? exact[0] : undefined;
    // A fixed-arity method only beats a varargs one when the argument types say so; that was
    // decided before (narrowByTypes), so an undecided pair stays ambiguous.
    if (exactOne !== undefined && !sorted.some((m) => m.varargs)) {
      return { targets: [{ method: exactOne, confidence: "inferred" }], ambiguous: false };
    }
    if (exact.length === 0) {
      const varargs = sorted.filter((m) => m.varargs);
      const varargsOne = varargs.length === 1 ? varargs[0] : undefined;
      if (varargsOne !== undefined) {
        return { targets: [{ method: varargsOne, confidence: "inferred" }], ambiguous: false };
      }
    }
  }
  if (sorted.length > MAX_NAME_MATCH_CANDIDATES) return { targets: [], ambiguous: true };
  return {
    targets: sorted.map((method) => ({ method, confidence: "name-match" as const })),
    ambiguous: true,
  };
}

/**
 * True when a member that cannot be found on `cls` may still exist: a super type lies
 * outside the repository, a record component accessor or Lombok-generated member is possible,
 * or the name is one every object or enum has. Such misses are neither resolved nor unresolved.
 */
export function mayHaveHiddenMember(state: ResolveState, cls: ClassInfo, name: string): boolean {
  if (OBJECT_METHODS.has(name)) return true;
  for (const c of hierarchyOf(state, cls)) {
    if (c.opaqueSupers) return true;
    if (c.javaKind === "record") return true;
    if (c.javaKind === "enum" && ENUM_METHODS.has(name)) return true;
    if (c.annotations.some((a) => GENERATING_ANNOTATIONS.has(a))) return true;
  }
  return false;
}
