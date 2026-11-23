import type { SymbolIndex } from "@repoatlas/plugin-api";
import type { FileExtraction } from "@repoatlas/schema";
import { externalKeyFor, isCapitalised, JAVA_LANG_TYPES, packagePartOf } from "./java-names.ts";
import { type ClassInfo, classByFqn, classInPackage, type JavaModel } from "./model.ts";

/** State shared by every lookup of one resolution run. */
export interface ResolveState {
  model: JavaModel;
  index: SymbolIndex;
  /** Declared dependency groupIds (from pom.xml / build.gradle) for external naming. */
  dependencyGroups: readonly string[];
  /** Sub class id -> super class ids, in declaration order (filled by `applySuperTypes`). */
  superTypes: Map<string, string[]>;
  /** Package names of the repository, sorted. */
  packageNames: readonly string[];
  scopes: Map<string, FileScope>;
}

export type TypeResult =
  | { kind: "class"; cls: ClassInfo }
  | { kind: "external"; key: string }
  | { kind: "unknown" };

export const UNKNOWN_TYPE: TypeResult = { kind: "unknown" };

/** What an `import` statement named, decided at scope-building time. */
export type ImportTarget =
  | { kind: "file"; file: string; exact: boolean }
  | { kind: "external"; key: string; packageName: string }
  | { kind: "wildcard" }
  | { kind: "unresolved" };

export interface ImportOutcome {
  line: number;
  specifier: string;
  importedNames: string[];
  target: ImportTarget;
}

type WildcardTarget =
  | { kind: "package"; pkg: string }
  | { kind: "class"; cls: ClassInfo }
  | { kind: "external"; key: string };

export interface WildcardEntry {
  line: number;
  target: WildcardTarget;
}

export type StaticBinding = { cls: ClassInfo } | { externalKey: string };

/** Names visible in one file through its package and imports. */
export interface FileScope {
  file: string;
  pkg: string;
  /** Simple name -> type, from single-type imports (and static imports of nested types). */
  singles: Map<string, TypeResult>;
  wildcards: WildcardEntry[];
  /** Member name -> classes it is statically imported from. */
  staticNames: Map<string, StaticBinding[]>;
  /** Classes whose members are all statically imported (`import static a.B.*`). */
  staticWildcards: { line: number; cls: ClassInfo }[];
  hasExternalWildcard: boolean;
  /** An external `import a.b.C.*` (capitalised last segment): may bring in static methods. */
  hasExternalStaticWildcard: boolean;
  /** Target file -> first wildcard import line, for the files a wildcard import was used for. */
  wildcardUses: Map<string, number>;
  outcomes: ImportOutcome[];
}

export function supersOf(state: ResolveState, cls: ClassInfo): ClassInfo[] {
  const ids = state.superTypes.get(cls.id) ?? [];
  const result: ClassInfo[] = [];
  for (const id of ids) {
    const found = state.model.byId.get(id);
    if (found !== undefined) result.push(found);
  }
  return result;
}

/** The class itself, then its super types depth-first, each once. */
export function hierarchyOf(state: ResolveState, cls: ClassInfo): ClassInfo[] {
  const order: ClassInfo[] = [];
  const seen = new Set<string>();
  const visit = (c: ClassInfo, depth: number): void => {
    if (seen.has(c.id) || depth > 32) return;
    seen.add(c.id);
    order.push(c);
    for (const s of supersOf(state, c)) visit(s, depth + 1);
  };
  visit(cls, 0);
  return order;
}

/** A member class of `cls` or of one of its super types. */
export function findNested(
  state: ResolveState,
  cls: ClassInfo,
  name: string,
): ClassInfo | undefined {
  for (const c of hierarchyOf(state, cls)) {
    const hit = c.nested.get(name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function hasPackageOrSubPackage(state: ResolveState, pkg: string): boolean {
  if (state.model.packages.has(pkg)) return true;
  const prefix = `${pkg}.`;
  return state.packageNames.some((p) => p.startsWith(prefix));
}

function classOrExternal(state: ResolveState, fqn: string, fromFile: string): TypeResult {
  const cls = classByFqn(state.model, fqn, fromFile);
  if (cls !== undefined) return { kind: "class", cls };
  const pkg = packagePartOf(fqn);
  if (pkg === "" || hasPackageOrSubPackage(state, pkg)) return UNKNOWN_TYPE;
  const key = externalKeyFor(pkg, state.dependencyGroups);
  return key === undefined ? UNKNOWN_TYPE : { kind: "external", key };
}

function lastSegment(text: string): string {
  return text.slice(text.lastIndexOf(".") + 1);
}

function addStatic(scope: FileScope, name: string, binding: StaticBinding): void {
  const list = scope.staticNames.get(name);
  if (list === undefined) scope.staticNames.set(name, [binding]);
  else list.push(binding);
}

function processImport(
  state: ResolveState,
  scope: FileScope,
  imp: FileExtraction["imports"][number],
): void {
  const base = { line: imp.line, specifier: imp.specifier };
  const unresolved = (names: string[]): void => {
    scope.outcomes.push({ ...base, importedNames: names, target: { kind: "unresolved" } });
  };
  const external = (key: string, packageName: string, names: string[]): void => {
    scope.outcomes.push({
      ...base,
      importedNames: names,
      target: { kind: "external", key, packageName },
    });
  };

  if (imp.kind === "module") {
    const simple = lastSegment(imp.specifier);
    const found = classOrExternal(state, imp.specifier, scope.file);
    if (found.kind === "class") {
      scope.singles.set(simple, found);
      scope.outcomes.push({
        ...base,
        importedNames: [simple],
        target: { kind: "file", file: found.cls.file, exact: true },
      });
    } else if (found.kind === "external") {
      scope.singles.set(simple, found);
      external(found.key, packagePartOf(imp.specifier), [simple]);
    } else {
      unresolved([simple]);
    }
    return;
  }

  if (imp.kind === "wildcard") {
    const cls = classByFqn(state.model, imp.specifier, scope.file);
    if (cls !== undefined) {
      scope.wildcards.push({ line: imp.line, target: { kind: "class", cls } });
      scope.staticWildcards.push({ line: imp.line, cls });
      scope.outcomes.push({ ...base, importedNames: [], target: { kind: "wildcard" } });
    } else if (hasPackageOrSubPackage(state, imp.specifier)) {
      scope.wildcards.push({ line: imp.line, target: { kind: "package", pkg: imp.specifier } });
      scope.outcomes.push({ ...base, importedNames: [], target: { kind: "wildcard" } });
    } else {
      const pkg = packagePartOf(imp.specifier);
      const key = pkg === "" ? undefined : externalKeyFor(pkg, state.dependencyGroups);
      if (key === undefined) {
        unresolved([]);
        return;
      }
      scope.wildcards.push({ line: imp.line, target: { kind: "external", key } });
      scope.hasExternalWildcard = true;
      if (isCapitalised(lastSegment(imp.specifier))) scope.hasExternalStaticWildcard = true;
      external(key, pkg, []);
    }
    return;
  }

  if (imp.kind === "named") {
    // `import static a.b.C.m`: members of class a.b.C (or nested types of it).
    const names = (imp.names ?? []).map((n) => n.name);
    const cls = classByFqn(state.model, imp.specifier, scope.file);
    if (cls !== undefined) {
      for (const name of names) {
        addStatic(scope, name, { cls });
        const nested = cls.nested.get(name);
        if (nested !== undefined) scope.singles.set(name, { kind: "class", cls: nested });
      }
      scope.outcomes.push({
        ...base,
        importedNames: names,
        target: { kind: "file", file: cls.file, exact: true },
      });
      return;
    }
    const found = classOrExternal(state, imp.specifier, scope.file);
    if (found.kind === "external") {
      for (const name of names) addStatic(scope, name, { externalKey: found.key });
      external(found.key, packagePartOf(imp.specifier), names);
    } else {
      unresolved(names);
    }
  }
}

/** Builds the import-derived scope of one file. Never throws on odd import data. */
export function buildFileScope(state: ResolveState, extraction: FileExtraction): FileScope {
  const pkg = extraction.meta?.["java.package"];
  const scope: FileScope = {
    file: extraction.file,
    pkg: typeof pkg === "string" ? pkg : "",
    singles: new Map(),
    wildcards: [],
    staticNames: new Map(),
    staticWildcards: [],
    hasExternalWildcard: false,
    hasExternalStaticWildcard: false,
    wildcardUses: new Map(),
    outcomes: [],
  };
  for (const imp of extraction.imports) processImport(state, scope, imp);
  return scope;
}

function noteWildcardUse(scope: FileScope, entry: WildcardEntry, cls: ClassInfo): void {
  if (cls.file === scope.file) return;
  const previous = scope.wildcardUses.get(cls.file);
  if (previous === undefined || entry.line < previous) scope.wildcardUses.set(cls.file, entry.line);
}

/** Step 1 of a simple-name lookup: member types of the enclosing classes, innermost first. */
function lookupInChain(
  state: ResolveState,
  chain: readonly ClassInfo[],
  name: string,
): ClassInfo | undefined {
  for (const cls of chain) {
    if (cls.name === name) return cls;
    const nested = findNested(state, cls, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function lookupSimple(
  state: ResolveState,
  scope: FileScope,
  chain: readonly ClassInfo[],
  name: string,
): TypeResult {
  const local = lookupInChain(state, chain, name);
  if (local !== undefined) return { kind: "class", cls: local };

  const single = scope.singles.get(name);
  if (single !== undefined) return single;

  const samePackage = classInPackage(state.model, scope.pkg, name, scope.file);
  if (samePackage !== undefined) return { kind: "class", cls: samePackage };

  for (const entry of scope.wildcards) {
    const target = entry.target;
    if (target.kind === "package") {
      const hit = classInPackage(state.model, target.pkg, name, scope.file);
      if (hit !== undefined) {
        noteWildcardUse(scope, entry, hit);
        return { kind: "class", cls: hit };
      }
    } else if (target.kind === "class") {
      const hit = findNested(state, target.cls, name);
      if (hit !== undefined) {
        noteWildcardUse(scope, entry, hit);
        return { kind: "class", cls: hit };
      }
    }
  }
  if (JAVA_LANG_TYPES.has(name)) return { kind: "external", key: "jdk" };
  return UNKNOWN_TYPE;
}

/** True for a segment list that starts like a package (`a.b.C`): lower case first segment. */
function looksPackageQualified(segments: readonly string[]): boolean {
  const first = segments[0];
  return first !== undefined && !isCapitalised(first) && segments.some((s) => isCapitalised(s));
}

/**
 * Resolves a type name as written (`User`, `Map.Entry`, `com.acme.User`) from a place inside
 * `chain` (the enclosing classes, innermost first). Order: member types of the enclosing
 * classes (and their super types), single-type imports, the same package, wildcard imports,
 * implicit `java.lang`, then the name as a fully qualified one.
 */
export function lookupTypeName(
  state: ResolveState,
  scope: FileScope,
  chain: readonly ClassInfo[],
  text: string,
): TypeResult {
  const segments = text.split(".").filter((s) => s !== "");
  const first = segments[0];
  if (first === undefined) return UNKNOWN_TYPE;

  let current = lookupSimple(state, scope, chain, first);
  if (current.kind === "unknown" && segments.length > 1 && looksPackageQualified(segments)) {
    return classOrExternal(state, segments.join("."), scope.file);
  }
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (current.kind === "external") return current;
    if (current.kind === "unknown") return UNKNOWN_TYPE;
    const nested = findNested(state, current.cls, segment);
    if (nested === undefined) return UNKNOWN_TYPE;
    current = { kind: "class", cls: nested };
  }
  return current;
}
