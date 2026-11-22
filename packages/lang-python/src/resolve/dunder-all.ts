/**
 * Reads a literal `__all__` from Python source without executing anything.
 * Only `__all__ = [...]`, `__all__ = (...)` and `__all__ += [...]` at the start of a line
 * count, and every element must be a plain string. Anything else (computed lists,
 * `__all__ = foo.__all__`, `__all__.extend(...)`) gives undefined, meaning "not literal".
 */

const ASSIGNMENT = /^__all__[ \t]*(\+?=)[ \t]*/gm;
const MAX_ITEMS = 5000;

interface ListResult {
  items: string[];
  end: number;
}

/** Parses a bracketed list of string literals starting at `start`. */
function parseStringList(source: string, start: number): ListResult | undefined {
  const open = source[start];
  if (open !== "[" && open !== "(") return undefined;
  const close = open === "[" ? "]" : ")";
  const items: string[] = [];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === close) return { items, end: i + 1 };
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      const value = end < 0 ? "" : source.slice(i + 1, end);
      if (end < 0 || value.includes("\n") || value.includes("\\")) return undefined;
      items.push(value);
      if (items.length > MAX_ITEMS) return undefined;
      i = end + 1;
    } else if (/[\s,]/.test(ch)) {
      i++;
    } else {
      return undefined; // a name, a call, `+`, ...: not a literal list of strings
    }
  }
  return undefined;
}

/** True when the rest of the line after `end` is blank or a comment. */
function restOfLineIsBlank(source: string, end: number): boolean {
  const newline = source.indexOf("\n", end);
  const rest = source.slice(end, newline < 0 ? source.length : newline).trim();
  return rest === "" || rest.startsWith("#");
}

export function parseDunderAll(source: string): string[] | undefined {
  let names: string[] | undefined;
  for (const match of source.matchAll(ASSIGNMENT)) {
    const list = parseStringList(source, match.index + match[0].length);
    if (!list || !restOfLineIsBlank(source, list.end)) return undefined;
    names = match[1] === "=" ? list.items : [...(names ?? []), ...list.items];
  }
  return names === undefined ? undefined : [...new Set(names)];
}
