/** A type name as written in Go source, split into optional package qualifier and name. */
export interface TypeName {
  qualifier: string | undefined;
  name: string;
}

const NOT_A_NAMED_TYPE = /^(\[|map\[|chan\b|<-|func\b|interface\b|struct\b)/;
const TYPE_NAME = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/;

/**
 * Reduces type text to a plain (optionally qualified) type name: `*Server` -> Server,
 * `pkg.Client[T]` -> pkg.Client, `...Item` -> Item. Slices, maps, channels, function and
 * literal types have no single named type: they give undefined.
 */
export function parseTypeName(text: string): TypeName | undefined {
  let t = text.trim();
  if (t.startsWith("...")) t = t.slice(3);
  while (t.startsWith("*") || t.startsWith("&")) t = t.slice(1).trim();
  if (NOT_A_NAMED_TYPE.test(t)) return undefined;
  const bracket = t.indexOf("[");
  if (bracket >= 0) t = t.slice(0, bracket); // generic arguments
  const match = TYPE_NAME.exec(t.trim());
  if (!match) return undefined;
  const [, first, second] = match;
  if (first === undefined) return undefined;
  return second === undefined
    ? { qualifier: undefined, name: first }
    : { qualifier: first, name: second };
}

/** Index of the bracket that closes the one at `open`, or -1. Handles (), [] and {}. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const NAMED_ENTRY = /^[A-Za-z_][A-Za-z0-9_]*\s+(\S[\s\S]*)$/;
const NOT_A_PARAM_NAME = /^(chan|func|map|interface|struct)\b/;

/** The type of one result entry: `s *Server` -> `*Server`, `error` -> `error`. */
function typeOfEntry(entry: string): string {
  if (NOT_A_PARAM_NAME.test(entry)) return entry;
  const named = NAMED_ENTRY.exec(entry);
  return named?.[1] ?? entry;
}

/**
 * The first result type of a function signature text such as
 * `func NewServer(addr string) *Server` or `func (s *S) Open() (*File, error)`, as a plain
 * type name (see `parseTypeName`). Undefined when there is no result or it is not a named type.
 */
export function parseResultType(signature: string): TypeName | undefined {
  const s = signature.trim();
  if (!/^func\b/.test(s)) return undefined;
  let i = 4;
  const skipSpace = (): void => {
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
  };
  skipSpace();
  if (s.charAt(i) === "(") {
    // Receiver of a method.
    const end = closing(s, i);
    if (end < 0) return undefined;
    i = end + 1;
    skipSpace();
  }
  while (i < s.length && /[A-Za-z0-9_]/.test(s.charAt(i))) i++; // function name
  skipSpace();
  if (s.charAt(i) === "[") {
    // Type parameters.
    const end = closing(s, i);
    if (end < 0) return undefined;
    i = end + 1;
    skipSpace();
  }
  if (s.charAt(i) !== "(") return undefined;
  const paramsEnd = closing(s, i);
  if (paramsEnd < 0) return undefined;
  const rest = s.slice(paramsEnd + 1).trim();
  if (rest === "") return undefined;
  if (!rest.startsWith("(")) return parseTypeName(rest);

  const end = closing(rest, 0);
  const entries = splitTopLevel(rest.slice(1, end < 0 ? rest.length : end));
  const first = entries[0];
  if (first === undefined) return undefined;
  // `(a, b Server)`: the first entry has no type of its own; borrow the next typed entry.
  if (!/\s/.test(first)) {
    const typed = entries.find((e) => NAMED_ENTRY.test(e) && !NOT_A_PARAM_NAME.test(e));
    if (typed !== undefined) return parseTypeName(typeOfEntry(typed));
  }
  return parseTypeName(typeOfEntry(first));
}
