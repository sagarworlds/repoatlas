import {
  type Definition,
  disambiguateLocalIds,
  type FileExtraction,
  type NodeMeta,
  type RawReference,
} from "@repoatlas/schema";
import type { SyntaxTree } from "@repoatlas/treesitter";
import { BUILTIN_FUNCTIONS, PREDECLARED_TYPES } from "../spec/predeclared.ts";
import { fileVarHints } from "../spec/receiver-type.ts";
import { collectLocalCallFacts } from "./local-names.ts";
import { collectGoFacts, type DeclFacts } from "./tree-facts.ts";

/** Hint for a receiver that is a local variable of unknown type (never an imported package). */
export const LOCAL_UNKNOWN_HINT = "local:";

/** Go test files: `foo_test.go` (also the external `foo_test` package). */
export function isGoTestPath(path: string): boolean {
  return path.endsWith("_test.go");
}

/** Exported means the first letter is an upper-case letter (Unicode aware). */
export function isExportedName(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

function definitionMeta(
  def: Definition,
  facts: DeclFacts | undefined,
  flags: { isTest: boolean; isGenerated: boolean },
): NodeMeta {
  const meta: NodeMeta = { ...def.meta };
  const exported = isExportedName(def.name);
  meta.isExported = exported;
  meta.visibility = exported ? "public" : "private";
  meta.loc = def.span.endLine - def.span.startLine + 1;
  if (flags.isTest) meta.isTest = true;
  if (flags.isGenerated) meta.isGenerated = true;
  if (facts === undefined) return meta;
  if (facts.kind === "method" && facts.receiverType !== undefined) {
    meta["go.receiver"] = facts.receiverType;
  }
  if (facts.typeKind === "alias") meta["go.kind"] = "alias";
  if (facts.typeKind === "struct" && Object.keys(facts.fields).length > 0) {
    meta["go.fields"] = facts.fields;
  }
  if (facts.typeKind === "interface") meta["go.methods"] = facts.interfaceMethods;
  return meta;
}

/** Pairs engine definitions with tree declarations by (start line, name), in document order. */
function pairDefinitions(
  definitions: readonly Definition[],
  decls: readonly DeclFacts[],
): (DeclFacts | undefined)[] {
  const byKey = new Map<string, DeclFacts[]>();
  for (const d of decls) {
    const list = byKey.get(d.key);
    if (list === undefined) byKey.set(d.key, [d]);
    else list.push(d);
  }
  return definitions.map((def) => byKey.get(`${def.span.startLine}:${def.name}`)?.shift());
}

function keepReference(
  ref: RawReference,
  owner: DeclFacts | undefined,
  definedHere: ReadonlySet<string>,
): boolean {
  if (ref.receiver !== undefined) return true;
  if (owner?.localTypes.has(ref.name) === true) return false;
  if (ref.kind === "call") {
    if (definedHere.has(ref.name)) return true;
    return !BUILTIN_FUNCTIONS.has(ref.name) && !PREDECLARED_TYPES.has(ref.name);
  }
  if (ref.kind === "extends" || ref.kind === "instantiate") {
    return !PREDECLARED_TYPES.has(ref.name);
  }
  return true;
}

/**
 * Go specifics on top of the generic engine output (see LANGUAGE_PLUGINS section 6):
 * - methods get the localId `Receiver.Method` and, when the receiver type is declared in the
 *   same file, that type as parent; `meta["go.receiver"]` always names the receiver type;
 * - struct/interface/alias kinds, visibility, export, test, generated and loc metadata;
 * - calls on the method's receiver variable become receiverKind "self";
 * - `type` references from signatures, fields and variable types (collected from the tree);
 * - removal of builtin calls, `import "C"`, and references to local types and type parameters;
 * - file meta `go.package` and `go.test`.
 */
export function postProcessGo(ex: FileExtraction, tree: SyntaxTree, _src: string): FileExtraction {
  const facts = collectGoFacts(tree);
  const isTest = isGoTestPath(ex.file);
  const flags = { isTest, isGenerated: facts.isGenerated };
  const paired = pairDefinitions(ex.definitions, facts.decls);

  // New local ids: methods become `Receiver.Method`; collisions get `@line` (schema rule).
  const raw = ex.definitions.map((def, i) => {
    const f = paired[i];
    return {
      localId:
        f?.kind === "method" && f.receiverType !== undefined
          ? `${f.receiverType}.${def.name}`
          : def.name,
      startLine: def.span.startLine,
    };
  });
  const newIds = disambiguateLocalIds(raw);
  const idMap = new Map<string, string>(); // engine id -> final id
  const ownerById = new Map<string, DeclFacts>(); // final id -> facts
  const idByFacts = new Map<DeclFacts, string>(); // facts -> final id
  const typeIds = new Map<string, string>(); // type name -> final id of its first declaration
  const definedHere = new Set<string>();
  ex.definitions.forEach((def, i) => {
    const id = newIds[i] as string;
    idMap.set(def.localId, id);
    definedHere.add(def.name);
    const f = paired[i];
    if (f === undefined) return;
    ownerById.set(id, f);
    idByFacts.set(f, id);
    if (f.kind === "type" && !typeIds.has(f.name)) typeIds.set(f.name, id);
  });

  const definitions = ex.definitions.map((def, i) => {
    const f = paired[i];
    const out: Definition = { ...def, localId: newIds[i] as string };
    delete out.parentLocalId;
    if (f?.kind === "type" && f.typeKind === "interface") out.kind = "interface";
    else if (f?.kind === "type") out.kind = "class";
    else if (f?.kind === "method") out.kind = "method";
    if (f?.kind === "method" && f.receiverType !== undefined) {
      const parent = typeIds.get(f.receiverType);
      if (parent !== undefined) out.parentLocalId = parent;
    }
    out.meta = definitionMeta(def, f, flags);
    return out;
  });

  const locals = collectLocalCallFacts(tree.rootNode);

  // Engine references: remap owner ids, set self receivers, drop noise.
  const references: RawReference[] = [];
  for (const original of ex.references) {
    const ref: RawReference = { ...original };
    if (ref.fromLocalId !== undefined) {
      const mapped = idMap.get(ref.fromLocalId);
      if (mapped === undefined) delete ref.fromLocalId;
      else ref.fromLocalId = mapped;
    }
    const owner = ref.fromLocalId === undefined ? undefined : ownerById.get(ref.fromLocalId);
    if (!keepReference(ref, owner, definedHere)) continue;
    if (
      ref.kind === "call" &&
      ref.receiverKind === "identifier" &&
      owner?.kind === "method" &&
      owner.receiverVar !== undefined &&
      ref.receiver === owner.receiverVar
    ) {
      ref.receiverKind = "self";
      delete ref.receiverTypeHint;
    }
    if (ref.kind === "call") {
      // A local variable or parameter shadows package functions and imported packages.
      if (ref.receiver === undefined && locals.bareCalls.has(`${ref.line}|${ref.name}`)) continue;
      if (
        ref.receiverKind === "identifier" &&
        ref.receiverTypeHint === undefined &&
        locals.receivers.has(`${ref.line}|${ref.receiver}`)
      ) {
        ref.receiverTypeHint = LOCAL_UNKNOWN_HINT;
      }
    }
    references.push(ref);
  }

  // Type references. A type use that is already an instantiate/extends reference with the
  // same owner, line and name is dropped (the same edge would be created twice).
  const seen = new Set<string>();
  const keyOf = (r: RawReference): string =>
    `${r.fromLocalId ?? ""}|${r.line}|${r.receiver ?? ""}|${r.name}`;
  for (const r of references) {
    if (r.kind !== "call") seen.add(keyOf(r));
  }
  const typeRefs: RawReference[] = [];
  for (const use of facts.typeUses) {
    const ref: RawReference = { line: use.line, kind: "type", name: use.name };
    if (use.receiver !== undefined) {
      ref.receiver = use.receiver;
      ref.receiverKind = "identifier";
    }
    if (use.owner !== undefined) {
      const id = idByFacts.get(use.owner);
      if (id !== undefined) ref.fromLocalId = id;
    }
    const key = keyOf(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    typeRefs.push(ref);
  }

  const sorted = [...references, ...typeRefs].sort((a, b) => a.line - b.line);
  const imports = ex.imports.filter((i) => i.specifier !== "C");
  const meta: Record<string, unknown> = { ...ex.meta };
  if (facts.packageName !== undefined) meta["go.package"] = facts.packageName;
  if (isTest) meta["go.test"] = true;
  if (facts.isGenerated) meta["go.generated"] = true;
  const vars = fileVarHints(tree.rootNode);
  if (Object.keys(vars).length > 0) meta["go.vars"] = vars;
  if (imports.length !== ex.imports.length) meta["go.cgo"] = true;
  return { ...ex, definitions, imports, references: sorted, meta };
}
