import type { ClassInfo, MethodInfo } from "./model.ts";
import { hierarchyOf, type ResolveState } from "./scope.ts";

/**
 * Overload picking by argument types. The extractor gives the static type of each argument
 * when it is cheap to know (literals, declared variables, `new Foo()`, casts, `X.class`).
 * A parameter fits an argument in one of these ways, best first: exactly, by widening or
 * subtyping, by boxing, "maybe" (we cannot tell), or not at all. A method with any argument
 * that cannot fit is dropped; of the rest the best fit wins when it is unique.
 */
export type Fit = "exact" | "widen" | "box" | "maybe" | "no";

const NUMERIC_RANK: Record<string, number> = {
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
};
const BOXES: Record<string, string> = {
  Byte: "byte",
  Short: "short",
  Integer: "int",
  Long: "long",
  Float: "float",
  Double: "double",
  Character: "char",
  Boolean: "boolean",
};
const PRIMITIVES = new Set([...Object.keys(NUMERIC_RANK), "char", "boolean"]);
/** Types every boxed primitive or String is assignable to besides itself. */
const UNIVERSAL = new Set(["Object", "Serializable", "Comparable", "Constable"]);
const STRING_SUPERS = new Set([...UNIVERSAL, "CharSequence", "ConstantDesc"]);
const CLASS_SUPERS = new Set([...UNIVERSAL, "Type", "GenericDeclaration", "AnnotatedElement"]);

const FIT_SCORE: Record<Fit, number> = { exact: 4, widen: 3, box: 2, maybe: 1, no: 0 };

function simpleName(type: string): string {
  const base = type.replace(/(\[\])+$/, "");
  return base.slice(base.lastIndexOf(".") + 1);
}

function arrayDepth(type: string): number {
  return (type.match(/\[\]/g) ?? []).length;
}

function isTypeVariable(name: string): boolean {
  return name.length <= 2 && name === name.toUpperCase() && /^[A-Z]/.test(name);
}

function classesNamed(state: ResolveState, name: string): ClassInfo[] {
  let table = nameTables.get(state);
  if (table === undefined) {
    table = new Map();
    for (const cls of state.model.classes) {
      const list = table.get(cls.name);
      if (list === undefined) table.set(cls.name, [cls]);
      else list.push(cls);
    }
    nameTables.set(state, table);
  }
  return table.get(name) ?? [];
}
const nameTables = new WeakMap<ResolveState, Map<string, ClassInfo[]>>();

function primitiveFit(arg: string, param: string): Fit {
  if (PRIMITIVES.has(param)) {
    if (arg === param) return "exact";
    const ra = arg === "char" ? 3 : NUMERIC_RANK[arg];
    const rp = NUMERIC_RANK[param];
    if (ra === undefined || rp === undefined) return "no";
    // char widens to int and above; nothing widens to char.
    return ra < rp ? "widen" : "no";
  }
  const boxed = BOXES[param];
  if (boxed !== undefined) return boxed === arg ? "box" : "no";
  if (param === "Number") return arg in NUMERIC_RANK ? "box" : "no";
  if (UNIVERSAL.has(param)) return "box";
  return isTypeVariable(param) ? "maybe" : "no";
}

function referenceFit(state: ResolveState, arg: string, param: string): Fit {
  if (param === "Object") return "widen";
  const known = classesNamed(state, arg);
  const target = classesNamed(state, param);
  if (arg === "String")
    return STRING_SUPERS.has(param) ? "widen" : isTypeVariable(param) ? "maybe" : "no";
  if (arg === "Class")
    return CLASS_SUPERS.has(param) ? "widen" : isTypeVariable(param) ? "maybe" : "no";
  if (BOXES[arg] !== undefined) {
    const unboxed = BOXES[arg] as string;
    if (PRIMITIVES.has(param)) return primitiveFit(unboxed, param) === "no" ? "no" : "box";
    if (param === "Number") return unboxed in NUMERIC_RANK ? "widen" : "no";
    if (UNIVERSAL.has(param)) return "widen";
    return isTypeVariable(param) ? "maybe" : "no";
  }
  if (PRIMITIVES.has(param) || BOXES[param] !== undefined) return "no";
  if (param === "String" || param === "Class") return "no";
  if (known.length === 1 && target.length > 0) {
    const names = hierarchyOf(state, known[0] as ClassInfo).map((c) => c.name);
    if (names.includes(param)) return "widen";
    const hidden = hierarchyOf(state, known[0] as ClassInfo).some((c) => c.opaqueSupers);
    return hidden ? "maybe" : "no";
  }
  if (known.length === 0 && target.length > 0 && !isTypeVariable(arg)) {
    // An outside type cannot extend a class of this repository.
    return target.some((c) => c.name === param) ? "no" : "maybe";
  }
  return "maybe";
}

/** How well an argument of static type `arg` fits a parameter declared as `param`. */
export function paramFit(state: ResolveState, arg: string, param: string): Fit {
  if (arg === "?" || param === "?") return "maybe";
  if (arg.startsWith("~")) {
    // A guess (`Modifier.PUBLIC`): it can only confirm a parameter of that type, never rule one out.
    const guessed = arg.slice(1);
    const element = simpleName(param);
    return element === guessed && arrayDepth(param) <= 1 ? "exact" : "maybe";
  }
  if (arg === "->") {
    if (PRIMITIVES.has(param) || BOXES[param] !== undefined || param === "String") return "no";
    return arrayDepth(param) > 0 ? "no" : "maybe";
  }
  if (arg === "null") return PRIMITIVES.has(param) ? "no" : "widen";

  const argDepth = arrayDepth(arg);
  const paramDepth = arrayDepth(param);
  if (argDepth > 0 || paramDepth > 0) {
    if (argDepth === 0)
      return isTypeVariable(simpleName(param)) && paramDepth === 0 ? "maybe" : "no";
    if (paramDepth === 0) {
      return param === "Object" || UNIVERSAL.has(simpleName(param))
        ? "widen"
        : isTypeVariable(param)
          ? "maybe"
          : "no";
    }
    if (argDepth !== paramDepth) return simpleName(param) === "Object" ? "widen" : "no";
    const a = simpleName(arg);
    const p = simpleName(param);
    if (PRIMITIVES.has(a) || PRIMITIVES.has(p)) return a === p ? "exact" : "no";
    return a === p ? "exact" : referenceFit(state, a, p) === "no" ? "no" : "maybe";
  }

  const a = simpleName(arg);
  const p = simpleName(param);
  if (a === p) return "exact";
  if (isTypeVariable(p)) return "maybe";
  if (PRIMITIVES.has(a)) return primitiveFit(a, p);
  return referenceFit(state, a, p);
}

interface Score {
  total: number;
  /** Number of arguments whose fit is only "maybe". */
  maybes: number;
}

/** Fits of every argument against one method; undefined when the method cannot take them. */
function methodScore(
  state: ResolveState,
  method: MethodInfo,
  args: readonly string[],
): Score | undefined {
  const params = method.paramTypes;
  if (params === undefined || params.length === 0) {
    return args.length === 0 ? { total: 0, maybes: 0 } : undefined;
  }
  let total = 0;
  let maybes = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    let fit: Fit;
    const fixed = i < params.length - (method.varargs ? 1 : 0);
    if (fixed) {
      fit = paramFit(state, arg, params[i] as string);
    } else if (method.varargs) {
      const last = params[params.length - 1] as string;
      const element = last.endsWith("[]") ? last.slice(0, -2) : last;
      const asElement = paramFit(state, arg, element);
      const asArray = args.length === params.length ? paramFit(state, arg, last) : "no";
      fit = FIT_SCORE[asElement] >= FIT_SCORE[asArray] ? asElement : asArray;
    } else {
      return undefined;
    }
    if (fit === "no") return undefined;
    if (fit === "maybe") maybes++;
    total += FIT_SCORE[fit];
  }
  return { total, maybes };
}

/**
 * Narrows overloads that all accept the argument count to the ones the argument types allow,
 * keeping only the best-scoring ones. Returns `methods` unchanged when nothing is known or
 * when the types rule out every method (our type guess must then be wrong).
 */
export function narrowByTypes(
  state: ResolveState,
  methods: readonly MethodInfo[],
  args: readonly string[] | undefined,
): MethodInfo[] {
  if (args === undefined || methods.length < 2) return [...methods];
  const scored: { method: MethodInfo; score: number }[] = [];
  const found: { method: MethodInfo; score: Score }[] = [];
  for (const method of methods) {
    const score = methodScore(state, method, args);
    if (score !== undefined) found.push({ method, score });
  }
  // A varargs method is only used when no fixed-arity method certainly fits: it loses ties then.
  const certain = found.some((f) => !f.method.varargs && f.score.maybes === 0);
  for (const f of found) {
    const penalty = certain && f.method.varargs ? 0.5 : 0;
    scored.push({ method: f.method, score: f.score.total - penalty });
  }
  if (scored.length === 0) return [...methods];
  const best = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === best).map((s) => s.method);
}
