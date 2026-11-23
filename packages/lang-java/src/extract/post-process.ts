import type { Definition, FileExtraction, NodeMeta, RawReference } from "@repoatlas/schema";
import { findEnclosingRanges, type SyntaxTree } from "@repoatlas/treesitter";
import { collectCallFacts } from "../spec/arg-types.ts";
import { declaredTypeOf } from "../spec/receiver-type.ts";
import { collectJavaFacts, type JavaDefFacts } from "./definition-facts.ts";
import { isJavaTestAnnotation, isJavaTestClassName, isJavaTestPath } from "./test-path.ts";
import { collectTypeRefs } from "./type-refs.ts";

function visibilityOf(facts: JavaDefFacts): NonNullable<NodeMeta["visibility"]> {
  if (facts.modifiers.includes("public")) return "public";
  if (facts.modifiers.includes("protected")) return "protected";
  if (facts.modifiers.includes("private")) return "private";
  // Members of interfaces and annotation types are implicitly public; otherwise package-private.
  if (facts.container === "interface" || facts.container === "annotation") return "public";
  return "internal";
}

function isAbstract(facts: JavaDefFacts): boolean {
  if (facts.modifiers.includes("abstract")) return true;
  const interfaceMethod = facts.container === "interface" && facts.typeKind === undefined;
  if (!interfaceMethod || facts.hasBody) return false;
  return !facts.modifiers.includes("static") && !facts.modifiers.includes("private");
}

/** Nested enums, records, interfaces and annotation types are implicitly static. */
function isStatic(facts: JavaDefFacts): boolean {
  if (facts.modifiers.includes("static")) return true;
  const nested = facts.container !== undefined;
  return nested && facts.typeKind !== undefined && facts.typeKind !== "class";
}

function definitionMeta(
  def: Definition,
  facts: JavaDefFacts | undefined,
  fileIsTest: boolean,
  testTypes: Set<string>,
): NodeMeta {
  const meta: NodeMeta = { ...def.meta };
  meta.loc = def.span.endLine - def.span.startLine + 1;
  if (facts === undefined) {
    if (fileIsTest) meta.isTest = true;
    return meta;
  }
  const visibility = visibilityOf(facts);
  meta.visibility = visibility;
  meta.isExported = visibility === "public";
  if (isStatic(facts)) meta.isStatic = true;
  if (isAbstract(facts)) {
    meta.isAbstract = true;
    meta["java.abstract"] = true;
  }
  if (facts.typeKind === "enum" || facts.typeKind === "record" || facts.typeKind === "annotation") {
    meta["java.kind"] = facts.typeKind;
  }
  if (facts.annotations.length > 0) meta["java.annotations"] = facts.annotations;
  if (facts.isConstructor) meta.isConstructor = true;
  if (facts.paramCount !== undefined) {
    meta["java.params"] = facts.paramCount;
    if (facts.varargs) meta["java.varargs"] = true;
    if (facts.paramTypes.length > 0) meta["java.paramTypes"] = facts.paramTypes;
  }
  if (facts.returns !== undefined) meta["java.returns"] = facts.returns;
  if (Object.keys(facts.fields).length > 0) meta["java.fields"] = facts.fields;
  const testClass = facts.typeKind !== undefined && isJavaTestClassName(facts.name);
  if (testClass) testTypes.add(facts.name);
  const inTestType = facts.typeName !== undefined && testTypes.has(facts.typeName);
  const testMethod = facts.typeKind === undefined && facts.annotations.some(isJavaTestAnnotation);
  if (fileIsTest || testClass || inTestType || testMethod) meta.isTest = true;
  return meta;
}

/**
 * Java specifics on top of the generic engine output (docs/LANGUAGE_PLUGINS.md section 6):
 * definition metadata, `type` references (field/parameter/return/local/generic/throws/cast/
 * annotation types), receiverKind of this(...)/super(...), file meta (`java.package`, isTest).
 * Calls inside lambdas, anonymous classes and local classes stay attributed to the nearest
 * named enclosing method because those constructs are never definitions.
 */
export function postProcessJava(
  ex: FileExtraction,
  tree: SyntaxTree,
  _src: string,
): FileExtraction {
  const facts = collectJavaFacts(tree.rootNode);
  const fileIsTest = isJavaTestPath(ex.file);

  // Pair engine definitions with tree facts by (start line, name), both in document order.
  const byKey = new Map<string, JavaDefFacts[]>();
  for (const f of facts.defs) {
    const key = `${f.startLine}:${f.name}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [f]);
    else list.push(f);
  }
  const owners: { localId: string; startIndex: number; endIndex: number }[] = [];
  const testTypes = new Set<string>();
  // Definitions the structural walk does not know are local classes (and their members): the
  // queries cannot exclude them, so they are dropped here and their references move up.
  const droppedParent = new Map<string, string | undefined>();
  const definitions: Definition[] = [];
  for (const def of ex.definitions) {
    const matched = byKey.get(`${def.span.startLine}:${def.name}`)?.shift();
    if (matched === undefined) {
      droppedParent.set(def.localId, def.parentLocalId);
      continue;
    }
    owners.push({
      localId: def.localId,
      startIndex: matched.startIndex,
      endIndex: matched.endIndex,
    });
    definitions.push({ ...def, meta: definitionMeta(def, matched, fileIsTest, testTypes) });
  }
  const survivingOwner = (localId: string | undefined): string | undefined => {
    let current = localId;
    while (current !== undefined && droppedParent.has(current))
      current = droppedParent.get(current);
    return current;
  };

  const typeDrafts = collectTypeRefs(tree.rootNode);
  const ownerIndexes = findEnclosingRanges(
    owners,
    typeDrafts.map((d) => d.startIndex),
  );
  const typeRefs: RawReference[] = [];
  const seen = new Set<string>();
  typeDrafts.forEach((draft, i) => {
    const fromLocalId = owners[ownerIndexes[i] ?? -1]?.localId;
    const key = `${fromLocalId ?? ""}|${draft.line}|${draft.receiver ?? ""}|${draft.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ref: RawReference = { line: draft.line, kind: "type", name: draft.name };
    if (draft.receiver !== undefined) {
      ref.receiver = draft.receiver;
      ref.receiverKind = draft.receiver.includes(".") ? "member-chain" : "identifier";
    }
    if (fromLocalId !== undefined) ref.fromLocalId = fromLocalId;
    typeRefs.push(ref);
  });

  // this(...) and super(...) have no receiver text; the keyword is the name.
  const engineRefs = ex.references.map((original) => {
    let ref = original;
    if (ref.fromLocalId !== undefined && droppedParent.has(ref.fromLocalId)) {
      const { fromLocalId: _dropped, ...rest } = ref;
      const owner = survivingOwner(ref.fromLocalId);
      ref = owner === undefined ? rest : { ...rest, fromLocalId: owner };
    }
    if (ref.kind === "call" && ref.receiver === undefined && ref.argCount !== undefined) {
      if (ref.name === "this") return { ...ref, receiverKind: "self" as const };
      if (ref.name === "super") return { ...ref, receiverKind: "super" as const };
    }
    return ref;
  });
  const references = [...engineRefs, ...typeRefs].sort((a, b) => a.line - b.line); // stable

  const meta: Record<string, unknown> = { ...ex.meta };
  if (facts.packageName !== undefined) meta["java.package"] = facts.packageName;
  if (fileIsTest) meta.isTest = true;
  const callFacts = collectCallFacts(tree.rootNode, declaredTypeOf);
  if (callFacts.localTypes.length > 0) meta["java.localTypes"] = callFacts.localTypes;
  if (Object.keys(callFacts.args).length > 0) meta["java.callArgs"] = callFacts.args;
  if (Object.keys(callFacts.anonSupers).length > 0) meta["java.anonSupers"] = callFacts.anonSupers;
  const result: FileExtraction = { ...ex, definitions, references };
  if (Object.keys(meta).length > 0) result.meta = meta;
  return result;
}
