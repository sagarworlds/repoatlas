import { findMethods, mayHaveHiddenMember } from "./methods.ts";
import type { ClassInfo, MethodInfo } from "./model.ts";
import {
  type FileScope,
  lookupTypeName,
  type ResolveState,
  supersOf,
  type TypeResult,
  UNKNOWN_TYPE,
} from "./scope.ts";

/**
 * Types of call chains such as `new Foo().a().b()` or `Truth.assertThat(x).isEqualTo(y)`.
 * The receiver text of a call is parsed into segments; the type of the first segment comes
 * from the file's names (or the extractor's type hint for a variable) and each call after it
 * takes the declared return type of the method it resolves to. Anything we cannot follow
 * (fields, generics, overloads with different return types) gives "unknown".
 */

export interface ChainSegment {
  kind: "name" | "call" | "new" | "paren";
  /** Identifier, or the type name of `new` (generics removed); empty for a parenthesised root. */
  name: string;
  argCount: number;
}

const EXTERNAL_JDK: TypeResult = { kind: "external", key: "jdk" };

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[\w$]/.test(c);
}

/** Cursor over the receiver text. */
class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string {
    return this.text.charAt(this.pos);
  }

  skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c !== "" && /\s/.test(c)) this.pos++;
      else if (this.text.startsWith("//", this.pos)) {
        const end = this.text.indexOf("\n", this.pos);
        this.pos = end < 0 ? this.text.length : end + 1;
      } else if (this.text.startsWith("/*", this.pos)) {
        const end = this.text.indexOf("*/", this.pos + 2);
        this.pos = end < 0 ? this.text.length : end + 2;
      } else return;
    }
  }

  /** Skips a string or char literal starting at the cursor. */
  skipLiteral(): void {
    if (this.text.startsWith('"""', this.pos)) {
      const end = this.text.indexOf('"""', this.pos + 3);
      this.pos = end < 0 ? this.text.length : end + 3;
      return;
    }
    const quote = this.peek();
    this.pos++;
    while (!this.atEnd() && this.peek() !== quote) {
      if (this.peek() === "\\") this.pos++;
      this.pos++;
    }
    this.pos++;
  }

  /**
   * Skips a balanced group starting at the cursor (which is on the opening bracket) and
   * returns the number of top-level arguments (commas + 1, or 0 when the group is blank).
   * Returns undefined when the brackets do not balance.
   */
  skipGroup(): number | undefined {
    const opening = this.peek();
    let depth = 0;
    let angle = 0;
    let commas = 0;
    let content = false;
    const start = this.pos;
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === '"' || c === "'") {
        this.skipLiteral();
        content = true;
        continue;
      }
      if (this.text.startsWith("//", this.pos) || this.text.startsWith("/*", this.pos)) {
        this.skipSpace();
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          this.pos++;
          return opening === "(" && content ? commas + 1 : 0;
        }
      } else if (c === "<" && this.opensGenerics(start)) angle++;
      else if (c === ">" && angle > 0) angle--;
      else if (c === "," && depth === 1 && angle === 0) commas++;
      if (depth === 1 && !/\s/.test(c)) content = true;
      this.pos++;
    }
    return undefined;
  }

  /** `Map<String, X>`: a `<` right after a capitalised word and before an upper case letter. */
  private opensGenerics(groupStart: number): boolean {
    let i = this.pos - 1;
    while (i > groupStart && isIdentPart(this.text.charAt(i))) i--;
    const word = this.text.slice(i + 1, this.pos);
    const next = this.text.charAt(this.pos + 1);
    return /^[A-Z]/.test(word) && /[A-Z?]/.test(next);
  }

  readIdentifier(): string | undefined {
    if (!isIdentStart(this.peek())) return undefined;
    const start = this.pos;
    while (isIdentPart(this.peek())) this.pos++;
    return this.text.slice(start, this.pos);
  }
}

/** A `new` expression's type name (generics removed), cursor left on the `(`. */
function readNewType(sc: Scanner): string | undefined {
  sc.skipSpace();
  let name = "";
  for (;;) {
    sc.skipSpace();
    const part = sc.readIdentifier();
    if (part === undefined) return undefined;
    name += part;
    sc.skipSpace();
    if (sc.peek() === "<") {
      let depth = 0;
      while (!sc.atEnd()) {
        const c = sc.peek();
        if (c === "<") depth++;
        else if (c === ">") depth--;
        sc.pos++;
        if (depth === 0) break;
      }
      sc.skipSpace();
    }
    if (sc.peek() === ".") {
      name += ".";
      sc.pos++;
      continue;
    }
    return sc.peek() === "(" ? name : undefined;
  }
}

/**
 * Splits the receiver text of a call into segments, or returns undefined when it is not a
 * plain chain (casts, array access, lambdas, ternaries and so on).
 */
export function parseChain(text: string): ChainSegment[] | undefined {
  const sc = new Scanner(text);
  const segments: ChainSegment[] = [];
  sc.skipSpace();
  if (/^new\s/.test(text.slice(sc.pos))) {
    sc.pos += 3;
    const name = readNewType(sc);
    if (name === undefined) return undefined;
    const argCount = sc.skipGroup();
    if (argCount === undefined) return undefined;
    sc.skipSpace();
    if (sc.peek() === "{") {
      if (sc.skipGroup() === undefined) return undefined; // anonymous class body
    }
    segments.push({ kind: "new", name, argCount });
  } else if (sc.peek() === "(") {
    if (sc.skipGroup() === undefined) return undefined;
    segments.push({ kind: "paren", name: "", argCount: 0 });
  } else {
    const first = readSegment(sc);
    if (first === undefined) return undefined;
    segments.push(first);
  }
  for (;;) {
    sc.skipSpace();
    if (sc.atEnd()) return segments;
    if (sc.peek() !== ".") return undefined;
    sc.pos++;
    sc.skipSpace();
    if (sc.peek() === "<") {
      // explicit type arguments: `Foo.<T>bar()`
      let depth = 0;
      while (!sc.atEnd()) {
        const c = sc.peek();
        if (c === "<") depth++;
        else if (c === ">") depth--;
        sc.pos++;
        if (depth === 0) break;
      }
      sc.skipSpace();
    }
    const next = readSegment(sc);
    if (next === undefined) return undefined;
    segments.push(next);
  }
}

function readSegment(sc: Scanner): ChainSegment | undefined {
  const name = sc.readIdentifier();
  if (name === undefined) return undefined;
  sc.skipSpace();
  if (sc.peek() === "(") {
    const argCount = sc.skipGroup();
    return argCount === undefined ? undefined : { kind: "call", name, argCount };
  }
  if (sc.peek() === "[") return undefined;
  return { kind: "name", name, argCount: 0 };
}

/** True when the segments are a chain worth typing: a call somewhere, or a `new` root. */
export function isCallChain(segments: readonly ChainSegment[]): boolean {
  return segments.some((s) => s.kind === "call" || s.kind === "new");
}

/** What the chain evaluator needs to know about the place of the reference. */
export interface ChainEnv {
  state: ResolveState;
  scope: FileScope;
  /** Classes enclosing the reference, innermost first. */
  chain: readonly ClassInfo[];
  /** The extractor's hint for the type of the chain's root, when it knew one. */
  rootHint: string | undefined;
}

function chainOfClass(cls: ClassInfo): ClassInfo[] {
  const chain: ClassInfo[] = [];
  for (let c: ClassInfo | undefined = cls; c !== undefined && chain.length < 32; c = c.outer) {
    chain.push(c);
  }
  return chain;
}

/** Type of a declared return type, looked up where the method is declared. */
function returnTypeOf(state: ResolveState, methods: readonly MethodInfo[]): TypeResult {
  const first = methods[0];
  if (first === undefined) return UNKNOWN_TYPE;
  const returns = first.returns;
  if (returns === undefined || returns === "?") return UNKNOWN_TYPE;
  if (methods.some((m) => m.returns !== returns)) return UNKNOWN_TYPE;
  // void, primitives and arrays have no members we could point at.
  if (returns === "void" || returns.endsWith("[]") || /^[a-z]+$/.test(returns)) return EXTERNAL_JDK;
  const owner = state.model.byId.get(first.ownerId);
  const scope = owner === undefined ? undefined : state.scopes.get(owner.file);
  if (owner === undefined || scope === undefined) return UNKNOWN_TYPE;
  return lookupTypeName(state, scope, chainOfClass(owner), returns);
}

/** Type of `cls.name(...)`: its return type, external when the method may be inherited from outside. */
function callOn(state: ResolveState, cls: ClassInfo, segment: ChainSegment): TypeResult {
  const found = findMethods(state, [cls], segment.name, segment.argCount);
  if (found !== undefined) return returnTypeOf(state, found.methods);
  return mayHaveHiddenMember(state, cls, segment.name) ? EXTERNAL_JDK : UNKNOWN_TYPE;
}

/** Type of `name(...)` with no receiver: a method of an enclosing class or a static import. */
function rootCall(env: ChainEnv, segment: ChainSegment): TypeResult {
  const { state, scope, chain } = env;
  const own = findMethods(state, chain, segment.name, segment.argCount);
  if (own !== undefined) return returnTypeOf(state, own.methods);
  const named = scope.staticNames.get(segment.name);
  const classes: ClassInfo[] = [];
  for (const binding of named ?? []) {
    if ("externalKey" in binding) return EXTERNAL_JDK;
    classes.push(binding.cls);
  }
  for (const cls of classes) {
    const found = findMethods(state, [cls], segment.name, segment.argCount);
    if (found !== undefined) return returnTypeOf(state, found.methods);
  }
  for (const entry of scope.staticWildcards) {
    const found = findMethods(state, [entry.cls], segment.name, segment.argCount);
    if (found !== undefined) return returnTypeOf(state, found.methods);
  }
  if (scope.hasExternalStaticWildcard) return EXTERNAL_JDK;
  for (const cls of chain) if (mayHaveHiddenMember(state, cls, segment.name)) return EXTERNAL_JDK;
  return UNKNOWN_TYPE;
}

/** Applies one `.name(...)` or `.field` to the type so far. */
function step(env: ChainEnv, current: TypeResult, segment: ChainSegment): TypeResult {
  if (segment.kind === "name" && segment.name === "class") return EXTERNAL_JDK; // `Foo.class`
  if (current.kind === "external") return current;
  if (current.kind !== "class") return UNKNOWN_TYPE;
  if (segment.kind === "call") return callOn(env.state, current.cls, segment);
  if (segment.name === "class") return EXTERNAL_JDK; // `Foo.class` is a java.lang.Class
  return UNKNOWN_TYPE; // a field: its type is not recorded
}

/** The type of the root: everything before the first call that follows it. */
function rootType(
  env: ChainEnv,
  segments: readonly ChainSegment[],
): { type: TypeResult; consumed: number } {
  const first = segments[0] as ChainSegment;
  const { state, scope, chain } = env;
  switch (first.kind) {
    case "new":
      return { type: lookupTypeName(state, scope, chain, first.name), consumed: 1 };
    case "paren":
      return {
        type:
          env.rootHint === undefined
            ? UNKNOWN_TYPE
            : lookupTypeName(state, scope, chain, env.rootHint),
        consumed: 1,
      };
    case "call":
      return { type: rootCall(env, first), consumed: 1 };
    case "name":
      break;
  }
  if (first.name === "this") {
    if (segments[1]?.kind === "name" && env.rootHint !== undefined) {
      // `this.repo.find()`: the extractor knows the declared type of the field.
      return { type: lookupTypeName(state, scope, chain, env.rootHint), consumed: 2 };
    }
    const own = chain[0];
    return { type: own === undefined ? UNKNOWN_TYPE : { kind: "class", cls: own }, consumed: 1 };
  }
  if (first.name === "super") {
    const own = chain[0];
    if (own === undefined) return { type: UNKNOWN_TYPE, consumed: 1 };
    const superClass = supersOf(state, own).find((s) => s.kind === "class");
    return {
      type: superClass === undefined ? EXTERNAL_JDK : { kind: "class", cls: superClass },
      consumed: 1,
    };
  }
  if (env.rootHint !== undefined) {
    return { type: lookupTypeName(state, scope, chain, env.rootHint), consumed: 1 };
  }
  // A type name, possibly qualified (`a.b.Foo`, `Outer.Inner`): the longest plain prefix that resolves.
  let plain = 0;
  while (plain < segments.length && segments[plain]?.kind === "name") plain++;
  for (let n = plain; n >= 1; n--) {
    const text = segments
      .slice(0, n)
      .map((s) => s.name)
      .join(".");
    const found = lookupTypeName(state, scope, chain, text);
    if (found.kind !== "unknown") return { type: found, consumed: n };
  }
  return { type: UNKNOWN_TYPE, consumed: 1 };
}

/** Type of the whole receiver expression, or "unknown". */
export function chainType(env: ChainEnv, segments: readonly ChainSegment[]): TypeResult {
  if (segments.length === 0) return UNKNOWN_TYPE;
  const root = rootType(env, segments);
  let current = root.type;
  for (let i = root.consumed; i < segments.length; i++) {
    current = step(env, current, segments[i] as ChainSegment);
  }
  return current;
}
