import type { Definition, FileExtraction } from "@repoatlas/schema";
import { symbolId } from "@repoatlas/schema";
import { compareText } from "./text.ts";

/** A method or constructor, with what overload picking needs. */
export interface MethodInfo {
  id: string;
  /** Id of the class that declares it. */
  ownerId: string;
  name: string;
  /** Number of declared parameters (`java.params`); undefined when the extractor did not say. */
  params: number | undefined;
  varargs: boolean;
  /** Declared parameter types (`java.paramTypes`), when the extractor said. */
  paramTypes: string[] | undefined;
  /** Declared return type (`java.returns`, a `typeKey`): class name, `void`, a primitive, `X[]`, a type variable or `?`. */
  returns: string | undefined;
  isCtor: boolean;
  isStatic: boolean;
}

/** A class, interface, enum, record or annotation type found in the repository. */
export interface ClassInfo {
  id: string;
  file: string;
  localId: string;
  name: string;
  pkg: string;
  /** Package plus the chain of outer classes: `com.acme.Outer.Inner`. */
  fqn: string;
  kind: "class" | "interface";
  /** `java.kind` meta: "enum" | "record" | "annotation" | undefined for plain classes. */
  javaKind: string | undefined;
  annotations: string[];
  outer: ClassInfo | undefined;
  methods: Map<string, MethodInfo[]>;
  ctors: MethodInfo[];
  nested: Map<string, ClassInfo>;
  /**
   * True when some super type is outside the repository (or could not be resolved), so a
   * member that is not found may simply be inherited from it. Set by the resolver.
   */
  opaqueSupers: boolean;
  /** Class-typed fields (`java.fields` meta): name -> type name as written. */
  fields: ReadonlyMap<string, string>;
}

/** Everything the resolver knows about the repository's Java types. */
export interface JavaModel {
  /** In file order, then source order. */
  classes: ClassInfo[];
  byId: Map<string, ClassInfo>;
  /** FQN -> class (the first one when two files declare the same FQN). */
  byFqn: Map<string, ClassInfo>;
  /** Package -> simple name -> top-level class. The default package is "". */
  packages: Map<string, Map<string, ClassInfo>>;
  extractionOf: Map<string, FileExtraction>;
  /** FQNs declared more than once (multi-module repos), with every declaration. */
  duplicateFqns: Map<string, ClassInfo[]>;
  /** `${package}|${simple name}` of top-level classes declared more than once. */
  duplicatePackageNames: Map<string, ClassInfo[]>;
}

function fieldMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value !== "object" || value === null) return out;
  for (const [name, type] of Object.entries(value)) {
    if (typeof type === "string") out.set(name, type);
  }
  return out;
}

/** Number of leading directory segments two file paths share. */
function sharedDirDepth(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

/**
 * Among classes with the same name, the one nearest to `fromFile` (longest shared directory
 * prefix, so the caller's own Maven or Gradle module wins; the first one on ties).
 */
export function nearestClass(candidates: readonly ClassInfo[], fromFile: string): ClassInfo {
  let best = candidates[0] as ClassInfo;
  let bestDepth = sharedDirDepth(best.file, fromFile);
  for (const c of candidates.slice(1)) {
    const depth = sharedDirDepth(c.file, fromFile);
    if (depth > bestDepth) {
      best = c;
      bestDepth = depth;
    }
  }
  return best;
}

/** Class by FQN; when several modules declare it, the one nearest to `fromFile`. */
export function classByFqn(model: JavaModel, fqn: string, fromFile: string): ClassInfo | undefined {
  const dups = model.duplicateFqns.get(fqn);
  return dups === undefined ? model.byFqn.get(fqn) : nearestClass(dups, fromFile);
}

/** Top-level class of a package by simple name, preferring the one nearest to `fromFile`. */
export function classInPackage(
  model: JavaModel,
  pkg: string,
  name: string,
  fromFile: string,
): ClassInfo | undefined {
  const dups = model.duplicatePackageNames.get(`${pkg}|${name}`);
  return dups === undefined ? model.packages.get(pkg)?.get(name) : nearestClass(dups, fromFile);
}

function stripCollisionSuffix(localId: string): string {
  const at = localId.indexOf("@");
  return at < 0 ? localId : localId.slice(0, at);
}

function packageOf(extraction: FileExtraction): string {
  const value = extraction.meta?.["java.package"];
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function paramTypesOf(def: Definition): string[] | undefined {
  const list = stringList(def.meta?.["java.paramTypes"]);
  return list.length > 0 ? list : undefined;
}

function methodOf(file: string, def: Definition, ownerId: string): MethodInfo {
  const params = def.meta?.["java.params"];
  return {
    id: symbolId(file, def.localId),
    ownerId,
    name: def.name,
    params: typeof params === "number" ? params : undefined,
    varargs: def.meta?.["java.varargs"] === true,
    paramTypes: paramTypesOf(def),
    returns: typeof def.meta?.["java.returns"] === "string" ? def.meta["java.returns"] : undefined,
    isCtor: def.meta?.["isConstructor"] === true,
    isStatic: def.meta?.["isStatic"] === true,
  };
}

function qualifiedName(cls: ClassInfo): string {
  const names: string[] = [];
  const seen = new Set<ClassInfo>();
  for (let c: ClassInfo | undefined = cls; c !== undefined && !seen.has(c); c = c.outer) {
    seen.add(c);
    names.unshift(c.name);
  }
  return names.join(".");
}

function addToMap<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Builds the type model from the extractions alone (no SymbolIndex needed). Java resolves
 * by fully qualified name, so directories and source roots play no role: a class lives in
 * the package its file declares.
 */
export function buildJavaModel(extractions: readonly FileExtraction[]): JavaModel {
  const model: JavaModel = {
    classes: [],
    byId: new Map(),
    byFqn: new Map(),
    packages: new Map(),
    duplicateFqns: new Map(),
    duplicatePackageNames: new Map(),
    extractionOf: new Map(),
  };
  const classAt = new Map<string, ClassInfo>();
  const key = (file: string, localId: string): string => `${file}\u0000${localId}`;

  // Pass 1: class nodes.
  for (const extraction of extractions) {
    model.extractionOf.set(extraction.file, extraction);
    const pkg = packageOf(extraction);
    for (const def of extraction.definitions) {
      if (def.kind !== "class" && def.kind !== "interface") continue;
      const cls: ClassInfo = {
        id: symbolId(extraction.file, def.localId),
        file: extraction.file,
        localId: def.localId,
        name: def.name,
        pkg,
        fqn: "",
        kind: def.kind,
        javaKind: typeof def.meta?.["java.kind"] === "string" ? def.meta["java.kind"] : undefined,
        annotations: stringList(def.meta?.["java.annotations"]),
        outer: undefined,
        methods: new Map(),
        ctors: [],
        nested: new Map(),
        opaqueSupers: false,
        fields: fieldMap(def.meta?.["java.fields"]),
      };
      classAt.set(key(extraction.file, def.localId), cls);
      model.classes.push(cls);
      model.byId.set(cls.id, cls);
    }
  }

  // Pass 2: outer links, nested tables, FQNs, methods and constructors.
  for (const extraction of extractions) {
    for (const def of extraction.definitions) {
      const parent =
        def.parentLocalId === undefined
          ? undefined
          : classAt.get(key(extraction.file, def.parentLocalId));
      if (def.kind === "class" || def.kind === "interface") {
        const cls = classAt.get(key(extraction.file, def.localId));
        if (cls === undefined) continue;
        cls.outer = parent;
        if (parent !== undefined && !parent.nested.has(cls.name)) parent.nested.set(cls.name, cls);
      } else if (def.kind === "method" && parent !== undefined) {
        const info = methodOf(extraction.file, def, parent.id);
        if (info.isCtor) parent.ctors.push(info);
        else addToMap(parent.methods, info.name, info);
      }
    }
  }
  for (const cls of model.classes) {
    const qualified = qualifiedName(cls);
    cls.fqn = cls.pkg === "" ? qualified : `${cls.pkg}.${qualified}`;
    const first = model.byFqn.get(cls.fqn);
    if (first === undefined) model.byFqn.set(cls.fqn, cls);
    else {
      const dups = model.duplicateFqns.get(cls.fqn) ?? [first];
      dups.push(cls);
      model.duplicateFqns.set(cls.fqn, dups);
    }
    if (cls.outer === undefined) {
      let table = model.packages.get(cls.pkg);
      if (table === undefined) {
        table = new Map();
        model.packages.set(cls.pkg, table);
      }
      const existing = table.get(cls.name);
      if (existing === undefined) table.set(cls.name, cls);
      else {
        const dupKey = `${cls.pkg}|${cls.name}`;
        const dups = model.duplicatePackageNames.get(dupKey) ?? [existing];
        dups.push(cls);
        model.duplicatePackageNames.set(dupKey, dups);
      }
    }
  }
  return model;
}

const defTables = new WeakMap<FileExtraction, Map<string, Definition>>();

function definitionTable(extraction: FileExtraction): Map<string, Definition> {
  let table = defTables.get(extraction);
  if (table === undefined) {
    table = new Map(extraction.definitions.map((d) => [d.localId, d]));
    defTables.set(extraction, table);
  }
  return table;
}

/** The classes enclosing a definition, innermost first (the definition itself counts if it is a class). */
export function classChain(
  model: JavaModel,
  extraction: FileExtraction,
  fromLocalId: string | undefined,
  includeSelf: boolean,
): ClassInfo[] {
  if (fromLocalId === undefined) return [];
  const byLocalId = definitionTable(extraction);
  const chain: ClassInfo[] = [];
  let current = byLocalId.get(fromLocalId);
  let skipFirst = !includeSelf;
  for (let steps = 0; current !== undefined && steps <= extraction.definitions.length; steps++) {
    if (current.kind === "class" || current.kind === "interface") {
      if (skipFirst) skipFirst = false;
      else {
        const cls = model.byId.get(symbolId(extraction.file, current.localId));
        if (cls !== undefined) chain.push(cls);
      }
    }
    skipFirst = false;
    current =
      current.parentLocalId === undefined ? undefined : byLocalId.get(current.parentLocalId);
  }
  return chain;
}

/** Package names of the repository, sorted (for prefix checks). */
export function packageNames(model: JavaModel): string[] {
  return [...model.packages.keys()].sort(compareText);
}
