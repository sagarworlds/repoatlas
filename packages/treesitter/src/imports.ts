import type { RawImport } from "@repoatlas/schema";
import type { QueryMatch } from "web-tree-sitter";
import { capturesNamed, firstCapture } from "./captures.ts";
import { stripQuotes } from "./helpers.ts";
import type { SyntaxNode } from "./types.ts";

interface NameEntry {
  nameNode: SyntaxNode;
  alias?: string;
}

interface ImportGroup {
  importNode: SyntaxNode;
  moduleNode: SyntaxNode | undefined;
  names: NameEntry[];
  alias?: string;
  wildcard: boolean;
  sideEffect: boolean;
  dynamic: boolean;
  relative: boolean;
}

/**
 * Turns import-query matches into RawImport[]. Capture conventions:
 *
 *   @import            the whole statement (its first line is `line`)
 *   @import.module     the module specifier. One RawImport per distinct module node.
 *   @import.name       an imported name; names from several matches of the same statement
 *                      and module are merged into one RawImport (kind "named")
 *   @import.alias      pairs with the nearest @import.name that precedes it in the same match;
 *                      with no preceding name it is the alias of the module itself
 *   @import.wildcard   marker: `from a import *` (kind "wildcard")
 *   @import.side-effect  marker: import for side effects only (kind "side-effect")
 *   @import.dynamic    marker: dynamic import (kind "dynamic")
 *   @import.relative   marker: force isRelative=true (otherwise: specifier starts with ".")
 *
 * A query may match once per imported name (tree-sitter does that for repeated fields);
 * grouping by (statement node, module node) puts them back together.
 */
export function buildImports(matches: readonly QueryMatch[]): RawImport[] {
  const groups = new Map<string, ImportGroup>();
  for (const match of matches) {
    const moduleNode = firstCapture(match, "import.module");
    const importNode =
      firstCapture(match, "import") ?? moduleNode ?? firstCapture(match, "import.name");
    if (importNode === undefined) continue;
    const key = `${importNode.id}:${moduleNode?.id ?? "-"}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        importNode,
        moduleNode,
        names: [],
        wildcard: false,
        sideEffect: false,
        dynamic: false,
        relative: false,
      };
      groups.set(key, group);
    }
    mergeMatch(group, match);
  }

  const built: { sortKey: [number, number]; value: RawImport }[] = [];
  for (const group of groups.values()) {
    const value = finalise(group);
    if (value !== undefined) {
      built.push({
        sortKey: [group.importNode.startIndex, group.moduleNode?.startIndex ?? 0],
        value,
      });
    }
  }
  built.sort((a, b) => a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1]);
  return built.map((b) => b.value);
}

function mergeMatch(group: ImportGroup, match: QueryMatch): void {
  const names = capturesNamed(match, "import.name").sort((a, b) => a.startIndex - b.startIndex);
  const entries: NameEntry[] = names.map((nameNode) => ({ nameNode }));
  const aliases = capturesNamed(match, "import.alias").sort((a, b) => a.startIndex - b.startIndex);
  for (const aliasNode of aliases) {
    let target: NameEntry | undefined;
    for (const entry of entries) {
      if (entry.nameNode.startIndex < aliasNode.startIndex) target = entry;
    }
    if (target !== undefined && target.alias === undefined) target.alias = aliasNode.text;
    else if (target === undefined && group.alias === undefined) group.alias = aliasNode.text;
  }
  for (const entry of entries) {
    const duplicate = group.names.some((n) => n.nameNode.id === entry.nameNode.id);
    if (!duplicate) group.names.push(entry);
  }
  if (firstCapture(match, "import.wildcard") !== undefined) group.wildcard = true;
  if (firstCapture(match, "import.side-effect") !== undefined) group.sideEffect = true;
  if (firstCapture(match, "import.dynamic") !== undefined) group.dynamic = true;
  if (firstCapture(match, "import.relative") !== undefined) group.relative = true;
}

function finalise(group: ImportGroup): RawImport | undefined {
  const raw = group.moduleNode?.text.trim() ?? "";
  const quoted = stripQuotes(raw);
  // Quoted specifiers keep inner text as is; dotted names lose stray whitespace ("a . b").
  const specifier = quoted !== raw ? quoted : raw.replace(/\s+/g, "");
  if (specifier === "" && group.names.length === 0 && !group.wildcard) return undefined;

  const sorted = [...group.names].sort((a, b) => a.nameNode.startIndex - b.nameNode.startIndex);
  let kind: RawImport["kind"] = "module";
  if (group.dynamic) kind = "dynamic";
  else if (group.sideEffect) kind = "side-effect";
  else if (group.wildcard) kind = "wildcard";
  else if (sorted.length > 0) kind = "named";

  const result: RawImport = {
    line: group.importNode.startPosition.row + 1,
    specifier,
    kind,
    isRelative: group.relative || specifier.startsWith("."),
  };
  if (sorted.length > 0) {
    result.names = sorted.map((n) =>
      n.alias === undefined
        ? { name: n.nameNode.text.trim() }
        : { name: n.nameNode.text.trim(), alias: n.alias },
    );
  }
  if (group.alias !== undefined) result.alias = group.alias;
  return result;
}
