import type { Definition, FileExtraction, NodeMeta, RawReference } from "@repoatlas/schema";
import { findEnclosingRanges, type SyntaxTree } from "@repoatlas/treesitter";
import { isSkippedTypeName } from "./annotations.ts";
import { isPythonTestPath } from "./test-path.ts";
import { collectTreeFacts, type DefNodeFacts } from "./tree-facts.ts";

function lastSegment(dotted: string): string {
  return dotted.slice(dotted.lastIndexOf(".") + 1);
}

/** `_x` is protected, `__x` is private, `__x__` (dunder) and everything else is public. */
export function visibilityOf(name: string): NodeMeta["visibility"] {
  if (name.startsWith("__") && name.endsWith("__") && name.length > 4) return "public";
  if (name.startsWith("__")) return "private";
  if (name.startsWith("_")) return "protected";
  return "public";
}

function definitionMeta(
  def: Definition,
  facts: DefNodeFacts | undefined,
  isTest: boolean,
): NodeMeta {
  const meta: NodeMeta = { ...def.meta };
  meta.visibility = visibilityOf(def.name);
  if (def.parentLocalId === undefined) meta.isExported = !def.name.startsWith("_");
  meta.loc = def.span.endLine - def.span.startLine + 1;
  if (isTest) meta.isTest = true;
  if (facts === undefined) return meta;
  if (facts.isAsync) meta.isAsync = true;
  if (facts.returns !== undefined) meta["py.returns"] = facts.returns;
  if (facts.params.length > 0) meta["py.params"] = facts.params;
  if (facts.decorators.length > 0) {
    meta["py.decorators"] = facts.decorators;
    const last = facts.decorators.map(lastSegment);
    if (last.includes("staticmethod")) {
      meta.isStatic = true;
      meta["py.staticmethod"] = true;
    }
    if (last.includes("classmethod")) {
      meta.isStatic = true;
      meta["py.classmethod"] = true;
    }
    if (
      last.some(
        (n) => n === "property" || n === "cached_property" || /^(setter|getter|deleter)$/.test(n),
      )
    ) {
      meta["py.property"] = true;
    }
  }
  return meta;
}

/** Drops reference noise that carries no information (see README of this package). */
function keepReference(ref: RawReference): boolean {
  if (ref.kind === "call" && ref.receiver === undefined && ref.name === "super") return false;
  if (ref.kind === "extends" && ref.receiver === undefined) {
    return !isSkippedTypeName(ref.name);
  }
  return true;
}

/**
 * Python specifics on top of the generic engine output (see LANGUAGE_PLUGINS section 6):
 * decorators, static/async/visibility/export/test/loc metadata, `type` references from
 * annotations, and removal of `from __future__` imports and bare `super()` calls.
 */
export function postProcessPython(
  ex: FileExtraction,
  tree: SyntaxTree,
  _src: string,
): FileExtraction {
  const facts = collectTreeFacts(tree);
  const isTest = isPythonTestPath(ex.file);

  // Pair engine definitions with tree nodes by (start line, name), in document order.
  const byKey = new Map<string, DefNodeFacts[]>();
  for (const f of facts.defs) {
    const key = `${f.startLine}:${f.name}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [f]);
    else list.push(f);
  }
  const owners: { localId: string; facts: DefNodeFacts }[] = [];
  const definitions = ex.definitions.map((def) => {
    const matched = byKey.get(`${def.span.startLine}:${def.name}`)?.shift();
    if (matched !== undefined) owners.push({ localId: def.localId, facts: matched });
    return { ...def, meta: definitionMeta(def, matched, isTest) };
  });

  // Innermost definition containing each annotation (sorted sweep, not a scan per annotation).
  const sortedAnnotations = [...facts.annotations].sort((a, b) => a.startIndex - b.startIndex);
  const ownerIndexes = findEnclosingRanges(
    owners.map((o) => ({ startIndex: o.facts.startIndex, endIndex: o.facts.endIndex })),
    sortedAnnotations.map((a) => a.startIndex),
  );

  const typeRefs: RawReference[] = [];
  const seen = new Set<string>();
  for (const [i, annotation] of sortedAnnotations.entries()) {
    const fromLocalId = owners[ownerIndexes[i] ?? -1]?.localId;
    for (const t of annotation.names) {
      const key = `${fromLocalId ?? ""}|${t.line}|${t.receiver ?? ""}|${t.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ref: RawReference = { line: t.line, kind: "type", name: t.name };
      if (t.receiver !== undefined) {
        ref.receiver = t.receiver;
        ref.receiverKind = t.receiver.includes(".") ? "member-chain" : "identifier";
      }
      if (fromLocalId !== undefined) ref.fromLocalId = fromLocalId;
      typeRefs.push(ref);
    }
  }

  const references = [...ex.references.filter(keepReference), ...typeRefs].sort(
    (a, b) => a.line - b.line, // Array.sort is stable: ties keep the engine's order
  );
  const imports = ex.imports.filter((i) => i.specifier !== "__future__");
  const meta = isTest ? { ...ex.meta, isTest: true } : ex.meta;
  const result: FileExtraction = { ...ex, definitions, imports, references };
  if (meta !== undefined) result.meta = meta;
  return result;
}
