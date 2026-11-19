/**
 * Names too ambiguous to name-match (mostly builtins/collections). LANGUAGE_PLUGINS §5.1.
 * Plugins may pass per-language additions to `isStoplisted`.
 */
export const NAME_MATCH_STOPLIST: ReadonlySet<string> = new Set([
  "get",
  "set",
  "add",
  "remove",
  "push",
  "pop",
  "append",
  "map",
  "filter",
  "reduce",
  "forEach",
  "len",
  "print",
  "log",
  "toString",
  "equals",
  "hashCode",
  "init",
  "__init__",
  "run",
  "call",
  "apply",
  "then",
  "catch",
  "write",
  "read",
  "close",
  "open",
  "update",
  "delete",
  "new",
]);

export function isStoplisted(name: string, extra?: Iterable<string>): boolean {
  if (NAME_MATCH_STOPLIST.has(name)) return true;
  if (extra) {
    for (const n of extra) if (n === name) return true;
  }
  return false;
}

/** Max candidates for which name-match edges are emitted (GRAPH_SCHEMA §2). */
export const MAX_NAME_MATCH_CANDIDATES = 3;
