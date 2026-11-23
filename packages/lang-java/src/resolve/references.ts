import type { ResolvedRef, ResolvedTarget } from "@repoatlas/plugin-api";
import { isStoplisted, nameMatchCandidates } from "@repoatlas/plugin-api";
import type { FileExtraction, RawReference } from "@repoatlas/schema";
import { type ChainEnv, chainType, isCallChain, parseChain } from "./chains.ts";
import { isCapitalised, JAVA_STOPLIST } from "./java-names.ts";
import {
  chooseOverload,
  findMethods,
  fittingConstructors,
  type MethodChoice,
  mayHaveHiddenMember,
} from "./methods.ts";
import { type ClassInfo, classChain, type MethodInfo } from "./model.ts";
import { narrowByTypes } from "./overloads.ts";
import {
  type FileScope,
  hierarchyOf,
  lookupTypeName,
  type ResolveState,
  supersOf,
  type TypeResult,
} from "./scope.ts";

/** Calls into things outside the repository: no edge, and not counted as unresolved. */
export const EXTERNAL_RESULT: ResolvedRef = { targets: [], unresolved: true, reason: "external" };
const NO_CANDIDATE: ResolvedRef = { targets: [], unresolved: true, reason: "no-candidate" };

export function typeText(ref: RawReference): string {
  return ref.receiver === undefined ? ref.name : `${ref.receiver}.${ref.name}`;
}

/** `T`, `E`, `K2`: almost certainly a type parameter, which can never be found. */
export function looksLikeTypeVariable(name: string): boolean {
  return (
    name.length <= 2 &&
    name === name.toUpperCase() &&
    name.charAt(0) >= "A" &&
    name.charAt(0) <= "Z"
  );
}

function classResult(cls: ClassInfo, step: ResolvedRef["step"]): ResolvedRef {
  const target: ResolvedTarget = { nodeId: cls.id, confidence: "inferred" };
  return step === undefined ? { targets: [target] } : { targets: [target], step };
}

/** Maps a type lookup to a `ResolvedRef` (class: one target; external: silent; unknown: unresolved). */
export function typeToResolved(type: TypeResult, scope: FileScope, name: string): ResolvedRef {
  if (type.kind === "class") return classResult(type.cls, "type-name");
  if (type.kind === "external") return EXTERNAL_RESULT;
  if (scope.hasExternalWildcard || looksLikeTypeVariable(name)) return EXTERNAL_RESULT;
  return NO_CANDIDATE;
}

function choiceToResolved(choice: MethodChoice, step: ResolvedRef["step"]): ResolvedRef {
  if (choice.targets.length === 0) {
    return { targets: [], unresolved: true, reason: "ambiguous" };
  }
  const result: ResolvedRef = {
    targets: choice.targets.map((t) => ({ nodeId: t.method.id, confidence: t.confidence })),
  };
  if (step !== undefined) result.step = step;
  return result;
}

/** Everything one reference needs: its file, scope and enclosing classes. */
export interface RefEnv {
  state: ResolveState;
  extraction: FileExtraction;
  scope: FileScope;
  /** Argument types of calls (from `java.callArgs`); a reference without an entry has none. */
  args: ReadonlyMap<RawReference, readonly string[]>;
  /** Unqualified calls inside anonymous classes: the type names those classes extend. */
  anonSupers: ReadonlyMap<RawReference, readonly string[]>;
  /** Names of local classes declared in this file (`java.localTypes`): they have no node. */
  localTypes: ReadonlySet<string>;
}

/** Overloads that fit `ref` best by argument types (all of them when the types say nothing). */
function narrow(env: RefEnv, ref: RawReference, methods: readonly MethodInfo[]): MethodInfo[] {
  return narrowByTypes(env.state, methods, env.args.get(ref));
}

function lookupType(env: RefEnv, chain: readonly ClassInfo[], text: string): TypeResult {
  return lookupTypeName(env.state, env.scope, chain, text);
}

/** Methods of `cls` (and its super types) matching the call, or undefined when it has none. */
function callIn(
  env: RefEnv,
  classes: readonly ClassInfo[],
  ref: RawReference,
  step: ResolvedRef["step"],
): ResolvedRef | undefined {
  const found = findMethods(env.state, classes, ref.name, ref.argCount);
  if (found === undefined) return undefined;
  const methods = found.arityMismatch ? found.methods : narrow(env, ref, found.methods);
  return choiceToResolved(chooseOverload(methods, ref.argCount, found.arityMismatch), step);
}

/** What a missed member lookup on `cls` means: hidden (external) or really unresolved. */
function missIn(env: RefEnv, classes: readonly ClassInfo[], name: string): ResolvedRef {
  for (const cls of classes) if (mayHaveHiddenMember(env.state, cls, name)) return EXTERNAL_RESULT;
  return NO_CANDIDATE;
}

function nameMatch(env: RefEnv, ref: RawReference, hasReceiver: boolean): ResolvedRef {
  const index = env.state.index;
  const candidates = nameMatchCandidates(index, ref.name, "java", hasReceiver, JAVA_STOPLIST);
  if (candidates.length > 0) {
    const targets = candidates
      .map((n) => ({ nodeId: n.id, confidence: "name-match" as const }))
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    return { targets, step: "name-match" };
  }
  const anyCallable = (index.byShortName.get(ref.name) ?? []).some(
    (n) => n.language === "java" && n.kind === "method",
  );
  const stoplisted = isStoplisted(ref.name, JAVA_STOPLIST);
  return {
    targets: [],
    unresolved: true,
    reason: anyCallable && !stoplisted ? "ambiguous" : "no-candidate",
  };
}

/** Static imports: `import static a.B.m` and `import static a.B.*`. */
function resolveStaticImport(env: RefEnv, ref: RawReference): ResolvedRef | undefined {
  const named = env.scope.staticNames.get(ref.name);
  if (named !== undefined) {
    const classes: ClassInfo[] = [];
    for (const binding of named) {
      if ("externalKey" in binding) return EXTERNAL_RESULT;
      classes.push(binding.cls);
    }
    const hit = callIn(env, classes, ref, "static");
    if (hit !== undefined) return hit;
  }
  for (const entry of env.scope.staticWildcards) {
    const found = findMethods(env.state, [entry.cls], ref.name, ref.argCount);
    if (found === undefined) continue;
    // The wildcard import was needed: remember the file it brought in (for the imports edge).
    const owner = env.state.model.byId.get(found.methods[0]?.ownerId ?? "");
    if (owner !== undefined && owner.file !== env.scope.file) {
      const previous = env.scope.wildcardUses.get(owner.file);
      if (previous === undefined || entry.line < previous)
        env.scope.wildcardUses.set(owner.file, entry.line);
    }
    const methods = found.arityMismatch ? found.methods : narrow(env, ref, found.methods);
    return choiceToResolved(chooseOverload(methods, ref.argCount, found.arityMismatch), "static");
  }
  return undefined;
}

/** `this(...)` and `super(...)` inside a constructor. */
function resolveConstructorChain(
  env: RefEnv,
  ref: RawReference,
  chain: readonly ClassInfo[],
): ResolvedRef {
  const cls = chain[0];
  if (cls === undefined) return NO_CANDIDATE;
  let target: ClassInfo | undefined = cls;
  if (ref.name === "super") {
    target = supersOf(env.state, cls).find((s) => s.kind === "class");
    // An external or unknown super class has no constructor node to point at.
    if (target === undefined) return EXTERNAL_RESULT;
  }
  const fitting = fittingConstructors(target, ref.argCount);
  if (target.ctors.length === 0) return EXTERNAL_RESULT; // implicit default constructor
  const choice = chooseOverload(
    fitting.length > 0 ? narrow(env, ref, fitting) : target.ctors,
    ref.argCount,
    fitting.length === 0,
  );
  return choiceToResolved(choice, ref.name === "super" ? "super" : "self");
}

/** `new Foo(args)`: the constructor picked by argument count, else a reference to the class. */
function resolveInstantiate(
  env: RefEnv,
  ref: RawReference,
  chain: readonly ClassInfo[],
): ResolvedRef {
  const type = lookupType(env, chain, typeText(ref));
  if (type.kind !== "class") return typeToResolved(type, env.scope, ref.name);
  const cls = type.cls;
  const fitting = fittingConstructors(cls, ref.argCount);
  if (cls.ctors.length === 0 || fitting.length === 0) {
    return { ...classResult(cls, "type-name"), asReference: true };
  }
  const choice = chooseOverload(narrow(env, ref, fitting), ref.argCount, false);
  if (choice.ambiguous) {
    // Several constructors fit: pointing at the class is honest, guessing one is not.
    return { ...classResult(cls, "type-name"), asReference: true };
  }
  return choiceToResolved(choice, "type-name");
}

/** Calls whose receiver is a type name or an expression of a known declared type. */
function resolveOnType(
  env: RefEnv,
  ref: RawReference,
  type: TypeResult,
  step: ResolvedRef["step"],
): ResolvedRef | undefined {
  if (type.kind === "external") return EXTERNAL_RESULT;
  if (type.kind !== "class") return undefined;
  return callIn(env, [type.cls], ref, step) ?? missIn(env, [type.cls], ref.name);
}

/** A chain's type: a class (look the method up), external (silent) or unknown (undefined). */
function resolveOnChainType(
  env: RefEnv,
  ref: RawReference,
  type: TypeResult,
): ResolvedRef | undefined {
  if (type.kind === "external") return EXTERNAL_RESULT;
  if (type.kind !== "class") return undefined;
  return callIn(env, [type.cls], ref, "type-hint") ?? missIn(env, [type.cls], ref.name);
}

function resolveWithReceiver(
  env: RefEnv,
  ref: RawReference,
  chain: readonly ClassInfo[],
): ResolvedRef | undefined {
  const receiver = ref.receiver;
  // `Outer.this.m()` and `Iface.super.m()`.
  if (receiver !== undefined && receiver.endsWith(".this")) {
    return resolveOnType(env, ref, lookupType(env, chain, receiver.slice(0, -5)), "self");
  }
  if (receiver !== undefined && receiver.endsWith(".super")) {
    return resolveOnType(env, ref, lookupType(env, chain, receiver.slice(0, -6)), "super");
  }

  // `new Foo().a().b()`, `assertThat(x).isEqualTo(y)`: follow the chain through return types.
  if (receiver !== undefined && receiver.includes("(")) {
    const segments = parseChain(receiver);
    if (segments !== undefined && isCallChain(segments)) {
      const chainEnv: ChainEnv = {
        state: env.state,
        scope: env.scope,
        chain,
        rootHint: ref.receiverTypeHint,
      };
      return resolveOnChainType(env, ref, chainType(chainEnv, segments));
    }
  }

  // `Foo.class.getName()`: a method of java.lang.Class.
  if (receiver !== undefined && /.class$/.test(receiver.trimEnd())) return EXTERNAL_RESULT;
  if (ref.receiverTypeHint !== undefined && env.localTypes.has(ref.receiverTypeHint)) {
    return EXTERNAL_RESULT;
  }

  if (ref.receiverTypeHint === undefined) {
    const inherited = inheritedFieldType(env, chain, receiver);
    if (inherited !== undefined) {
      return inherited.kind === "external"
        ? EXTERNAL_RESULT
        : resolveOnType(env, ref, inherited, "type-hint");
    }
  }

  if (ref.receiverTypeHint !== undefined) {
    const hinted = lookupType(env, chain, ref.receiverTypeHint);
    const result = resolveOnType(env, ref, hinted, "type-hint");
    if (result !== undefined) return result;
    // A hint like `T` names a type parameter: the real type is unknown, matching names would be a guess.
    if (hinted.kind === "unknown" && looksLikeTypeVariable(ref.receiverTypeHint))
      return EXTERNAL_RESULT;
    // A declared type that is neither in the repository nor in scope comes from outside it
    // (an external wildcard import, a missing dependency): the call cannot target a repo class.
    if (hinted.kind === "unknown") return EXTERNAL_RESULT;
  }

  const kind = ref.receiverKind;
  const plainReceiver = kind === undefined || kind === "identifier" || kind === "member-chain";
  if (receiver !== undefined && plainReceiver && ref.receiverTypeHint === undefined) {
    const first = receiver.split(".")[0] ?? receiver;
    const lastSegment = receiver.slice(receiver.lastIndexOf(".") + 1);
    // A type name starts upper case; a package-qualified one starts lower case but ends upper case.
    // Decided by lookup, not by case: classes named DB, IO or U are types too. A constant such
    // as MAX_SIZE is not found as a type, so resolveOnType gives up on it.
    if (isCapitalised(first) || isCapitalised(lastSegment)) {
      const result = resolveOnType(env, ref, lookupType(env, chain, receiver), "static");
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

function inheritedFromOutsideFirst(
  env: RefEnv,
  chain: readonly ClassInfo[],
  ref: RawReference,
): boolean {
  for (let i = 0; i < chain.length - 1; i++) {
    const cls = chain[i] as ClassInfo;
    if (cls.id.startsWith("anon:")) continue;
    if (findMethods(env.state, [cls], ref.name, ref.argCount) !== undefined) return false;
    if (mayHaveHiddenMember(env.state, cls, ref.name)) return true;
  }
  return false;
}

/**
 * `svc.run()` or `this.svc.run()` where `svc` is a field of a super class in the repository:
 * the lexical receiver hint cannot see it, so look it up through the class hierarchy.
 */
function inheritedFieldType(
  env: RefEnv,
  chain: readonly ClassInfo[],
  receiver: string | undefined,
): TypeResult | undefined {
  const name = receiver?.startsWith("this.") ? receiver.slice(5) : receiver;
  if (name === undefined || !/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  for (const cls of chain) {
    for (const c of hierarchyOf(env.state, cls)) {
      const text = c.fields.get(name);
      const scope = env.state.scopes.get(c.file);
      if (text === undefined || scope === undefined) continue;
      const type = lookupTypeName(env.state, scope, [c], text);
      return type.kind === "unknown" ? undefined : type;
    }
  }
  return undefined;
}

/** Resolves a `call` reference. */
export function resolveCall(
  env: RefEnv,
  ref: RawReference,
  chain: readonly ClassInfo[],
): ResolvedRef {
  const kind = ref.receiverKind;
  const hasReceiver = ref.receiver !== undefined || kind !== undefined;
  const isChain =
    (ref.name === "this" || ref.name === "super") && (kind === "self" || kind === "super");
  if (isChain) return resolveConstructorChain(env, ref, chain);

  const own = chain[0];
  if (kind === "self") {
    if (ref.receiver !== undefined && ref.receiver.endsWith(".this")) {
      return resolveWithReceiver(env, ref, chain) ?? nameMatch(env, ref, true);
    }
    if (own === undefined) return nameMatch(env, ref, true);
    return callIn(env, [own], ref, "self") ?? missIn(env, [own], ref.name);
  }
  if (kind === "super") {
    if (own === undefined) return NO_CANDIDATE;
    const supers = supersOf(env.state, own);
    const hit = callIn(env, supers, ref, "super");
    if (hit !== undefined) return hit;
    // A missed `super.m()` is never name-matched: it would find the calling method itself.
    return supers.length === 0 || mayHaveHiddenMember(env.state, own, ref.name)
      ? EXTERNAL_RESULT
      : NO_CANDIDATE;
  }

  if (!hasReceiver) {
    // An inner class that inherits from an outside class gets its inherited members before
    // the methods of the enclosing class do (Java scoping).
    if (inheritedFromOutsideFirst(env, chain, ref)) return EXTERNAL_RESULT;
    const hit = callIn(env, chain, ref, "same-scope") ?? resolveStaticImport(env, ref);
    if (hit !== undefined) return hit;
    for (const cls of chain) {
      if (mayHaveHiddenMember(env.state, cls, ref.name)) return EXTERNAL_RESULT;
    }
    if (env.scope.hasExternalStaticWildcard) return EXTERNAL_RESULT;
    return NO_CANDIDATE;
  }
  return resolveWithReceiver(env, ref, chain) ?? nameMatch(env, ref, true);
}

/**
 * A call inside `new Base() { ... }` may call methods the anonymous class inherits from
 * `Base`. The anonymous class gets a stand-in class (no members of its own, `Base` as its
 * super type) put in front of the enclosing classes, so the usual lookup finds them.
 */
function withAnonymousClasses(
  env: RefEnv,
  ref: RawReference,
  chain: readonly ClassInfo[],
): readonly ClassInfo[] {
  const supers = env.anonSupers.get(ref);
  if (supers === undefined) return chain;
  const standIns: ClassInfo[] = [];
  // Outermost first, so that each type name is looked up from where it is written.
  for (let i = supers.length - 1; i >= 0; i--) {
    const outerChain = [...standIns.slice().reverse(), ...chain];
    const type = lookupType(env, outerChain, supers[i] as string);
    const standIn: ClassInfo = {
      id: `anon:${env.extraction.file}:${ref.line}:${i}`,
      file: env.extraction.file,
      localId: "",
      name: "",
      pkg: env.scope.pkg,
      fqn: "",
      kind: "class",
      javaKind: undefined,
      annotations: [],
      outer: chain[0],
      methods: new Map(),
      ctors: [],
      nested: new Map(),
      opaqueSupers: type.kind !== "class",
      fields: new Map(),
    };
    if (type.kind === "class") env.state.superTypes.set(standIn.id, [type.cls.id]);
    standIns.push(standIn);
  }
  return [...standIns.reverse(), ...chain];
}

/** A simple type name declared as a local class in this file (it has no node to point at). */
function isLocalType(env: RefEnv, ref: RawReference): boolean {
  return ref.receiver === undefined && env.localTypes.has(ref.name);
}

/** A type that cannot be found may be a member type inherited from a super type outside the repository. */
function inheritedTypeMiss(
  env: RefEnv,
  chain: readonly ClassInfo[],
  result: ResolvedRef,
): ResolvedRef {
  if (result.targets.length > 0 || result.reason !== "no-candidate") return result;
  for (const cls of chain) {
    if (hierarchyOf(env.state, cls).some((c) => c.opaqueSupers)) return EXTERNAL_RESULT;
  }
  return result;
}

/** Resolves any reference of a file. `fromLocalId` decides the enclosing classes. */
export function resolveJavaReference(env: RefEnv, ref: RawReference): ResolvedRef {
  const inheritance = ref.kind === "extends" || ref.kind === "implements";
  const chain = classChain(env.state.model, env.extraction, ref.fromLocalId, !inheritance);
  switch (ref.kind) {
    case "extends":
    case "implements":
    case "type":
      if (isLocalType(env, ref)) return EXTERNAL_RESULT;
      return inheritedTypeMiss(
        env,
        chain,
        typeToResolved(lookupType(env, chain, typeText(ref)), env.scope, ref.name),
      );
    case "instantiate":
      if (isLocalType(env, ref)) return EXTERNAL_RESULT;
      return inheritedTypeMiss(env, chain, resolveInstantiate(env, ref, chain));
    case "call":
      return resolveCall(env, ref, withAnonymousClasses(env, ref, chain));
  }
}
