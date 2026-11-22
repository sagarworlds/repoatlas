/**
 * A small, strict TOML reader for the subset that Python project manifests need.
 * It understands tables, arrays of tables, dotted keys, strings (all four kinds), arrays,
 * inline tables, booleans and numbers. Dates and other bare values come back as raw strings.
 *
 * Safety: `parseToml` never throws. Any syntax error, oversized input or excessive nesting
 * gives an empty table. Tables are created with a null prototype so a key such as
 * `__proto__` is an ordinary key and cannot pollute anything.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export const MAX_TOML_CHARS = 1_000_000;
const MAX_DEPTH = 32;

class TomlSyntaxError extends Error {}

function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && !Array.isArray(value);
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/** Parses `text`. Returns an empty table when the text is not valid (never throws). */
export function parseToml(text: string): TomlTable {
  if (text.length > MAX_TOML_CHARS) return newTable();
  try {
    return parseOrThrow(text);
  } catch {
    // Includes TomlSyntaxError and anything unexpected, such as a stack overflow.
    return newTable();
  }
}

function parseOrThrow(text: string): TomlTable {
  let i = 0;
  const root = newTable();
  // Tables that a `[header]` already defined, and arrays created by `[[header]]`.
  const explicit = new WeakSet<TomlTable>();
  const tableArrays = new WeakSet<TomlValue[]>();

  const fail = (message: string): never => {
    throw new TomlSyntaxError(`${message} at offset ${i}`);
  };
  const peek = (): string => text[i] ?? "";

  function skipSpaces(): void {
    while (peek() === " " || peek() === "\t") i++;
  }
  function skipComment(): void {
    if (peek() !== "#") return;
    while (i < text.length && peek() !== "\n") i++;
  }
  /** Skips whitespace, comments and newlines (between statements and inside arrays). */
  function skipBlank(): void {
    for (;;) {
      skipSpaces();
      if (peek() === "#") skipComment();
      else if (peek() === "\n") i++;
      else if (peek() === "\r" && text[i + 1] === "\n") i += 2;
      else return;
    }
  }

  function parseBasicString(multiline: boolean): string {
    // `i` is just after the opening quote(s).
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const ch = peek();
      if (multiline && text.startsWith('"""', i)) {
        i += 3;
        // Up to two extra quotes directly before the closing delimiter belong to the string.
        while (peek() === '"' && out.length < MAX_TOML_CHARS) {
          out += '"';
          i++;
        }
        return out;
      }
      if (!multiline && ch === '"') {
        i++;
        return out;
      }
      if (!multiline && (ch === "\n" || ch === "\r")) fail("newline in string");
      if (ch !== "\\") {
        out += ch;
        i++;
        continue;
      }
      i++;
      const esc = peek();
      const simple = ESCAPES[esc];
      if (simple !== undefined) {
        out += simple;
        i++;
      } else if (esc === "u" || esc === "U") {
        const len = esc === "u" ? 4 : 8;
        const hex = text.slice(i + 1, i + 1 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) fail("bad unicode escape");
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail("bad code point");
        out += String.fromCodePoint(code);
        i += 1 + len;
      } else if (multiline && (esc === "\n" || esc === " " || esc === "\t" || esc === "\r")) {
        // Line-ending backslash: drop the newline and all whitespace after it.
        while (/[ \t\r\n]/.test(peek()) && i < text.length) i++;
      } else {
        fail("bad escape");
      }
    }
  }

  function parseLiteralString(multiline: boolean): string {
    const close = multiline ? "'''" : "'";
    const end = text.indexOf(close, i);
    if (end < 0) fail("unterminated string");
    let body = text.slice(i, end);
    if (!multiline && /[\n\r]/.test(body)) fail("newline in string");
    i = end + close.length;
    if (multiline) {
      while (peek() === "'") {
        body += "'";
        i++;
      }
    }
    return body;
  }

  /** Reads a string after the cursor sits on its opening quote. */
  function parseString(): string {
    const quote = peek();
    const multiline = text.startsWith(quote.repeat(3), i);
    i += multiline ? 3 : 1;
    if (multiline) {
      // A newline right after the opening delimiter is trimmed.
      if (peek() === "\n") i++;
      else if (peek() === "\r" && text[i + 1] === "\n") i += 2;
    }
    return quote === '"' ? parseBasicString(multiline) : parseLiteralString(multiline);
  }

  function parseKeyPart(): string {
    const ch = peek();
    if (ch === '"' || ch === "'") {
      if (text.startsWith(ch.repeat(3), i)) fail("multiline key");
      i++;
      return ch === '"' ? parseBasicString(false) : parseLiteralString(false);
    }
    const start = i;
    while (BARE_KEY.test(peek())) i++;
    if (i === start) fail("expected a key");
    return text.slice(start, i);
  }

  function parseKeyPath(): string[] {
    const parts: string[] = [];
    skipSpaces();
    parts.push(parseKeyPart());
    for (;;) {
      skipSpaces();
      if (peek() !== ".") return parts;
      i++;
      skipSpaces();
      parts.push(parseKeyPart());
    }
  }

  function parseArray(depth: number): TomlValue[] {
    i++; // [
    const items: TomlValue[] = [];
    for (;;) {
      skipBlank();
      if (peek() === "]") {
        i++;
        return items;
      }
      items.push(parseValue(depth + 1));
      skipBlank();
      if (peek() === ",") i++;
      else if (peek() !== "]") fail("expected , or ]");
    }
  }

  function parseInlineTable(depth: number): TomlTable {
    i++; // {
    const table = newTable();
    skipSpaces();
    if (peek() === "}") {
      i++;
      return table;
    }
    for (;;) {
      skipSpaces();
      assignKeyValue(table, depth + 1);
      skipSpaces();
      if (peek() === ",") {
        i++;
        skipSpaces();
        if (peek() === "}") {
          i++;
          return table;
        }
      } else if (peek() === "}") {
        i++;
        return table;
      } else {
        fail("expected , or }");
      }
    }
  }

  function parseBare(): TomlValue {
    const start = i;
    while (i < text.length && !/[,\]}\s#]/.test(peek())) i++;
    const token = text.slice(start, i);
    if (token === "") fail("expected a value");
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^[+-]?\d[\d_]*$/.test(token)) return Number.parseInt(token.replaceAll("_", ""), 10);
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(token)) {
      return Number.parseFloat(token.replaceAll("_", ""));
    }
    // Dates, times, hex numbers, inf and nan: kept as raw text, never interpreted.
    // A date-time can contain one space ("1979-05-27 07:32:00"); take the time part too.
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && /^ \d{2}:/.test(text.slice(i, i + 4))) {
      const timeStart = i + 1;
      i = timeStart;
      while (i < text.length && !/[,\]}\s#]/.test(peek())) i++;
      return `${token} ${text.slice(timeStart, i)}`;
    }
    return token;
  }

  function parseValue(depth: number): TomlValue {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    skipSpaces();
    const ch = peek();
    if (ch === '"' || ch === "'") return parseString();
    if (ch === "[") return parseArray(depth);
    if (ch === "{") return parseInlineTable(depth);
    return parseBare();
  }

  /** Walks (and creates) the intermediate tables of a key path. */
  function descend(start: TomlTable, path: string[]): TomlTable {
    let table = start;
    for (const part of path) {
      const next = table[part];
      if (next === undefined) {
        const created = newTable();
        table[part] = created;
        table = created;
      } else if (Array.isArray(next)) {
        const last = next[next.length - 1];
        if (!tableArrays.has(next) || !isTable(last)) fail("key is not a table");
        table = last as TomlTable;
      } else if (isTable(next)) {
        table = next;
      } else {
        fail("key is not a table");
      }
    }
    return table;
  }

  function assignKeyValue(into: TomlTable, depth: number): void {
    const path = parseKeyPath();
    skipSpaces();
    if (peek() !== "=") fail("expected =");
    i++;
    const value = parseValue(depth);
    const leaf = path[path.length - 1] as string;
    const owner = descend(into, path.slice(0, -1));
    if (leaf in owner) fail("duplicate key");
    owner[leaf] = value;
  }

  function parseHeader(): TomlTable {
    const isArray = text.startsWith("[[", i);
    i += isArray ? 2 : 1;
    const path = parseKeyPath();
    skipSpaces();
    if (!text.startsWith(isArray ? "]]" : "]", i)) fail("expected ]");
    i += isArray ? 2 : 1;
    const leaf = path[path.length - 1] as string;
    const owner = descend(root, path.slice(0, -1));
    const existing = owner[leaf];
    if (isArray) {
      if (existing === undefined) {
        const list: TomlValue[] = [];
        tableArrays.add(list);
        const table = newTable();
        list.push(table);
        owner[leaf] = list;
        return table;
      }
      if (!Array.isArray(existing) || !tableArrays.has(existing)) fail("not an array of tables");
      const table = newTable();
      (existing as TomlValue[]).push(table);
      return table;
    }
    if (existing === undefined) {
      const table = newTable();
      explicit.add(table);
      owner[leaf] = table;
      return table;
    }
    if (!isTable(existing) || explicit.has(existing)) fail("table defined twice");
    explicit.add(existing as TomlTable);
    return existing as TomlTable;
  }

  let current = root;
  for (;;) {
    skipBlank();
    if (i >= text.length) return root;
    if (peek() === "[") current = parseHeader();
    else assignKeyValue(current, 0);
    skipSpaces();
    skipComment();
    if (i < text.length && peek() !== "\n" && !(peek() === "\r" && text[i + 1] === "\n")) {
      fail("unexpected text after statement");
    }
  }
}

/** Reads `table[k1][k2]...` and returns it only when every step is a table. */
export function getTable(table: TomlTable, ...path: string[]): TomlTable | undefined {
  let current: TomlValue | undefined = table;
  for (const key of path) {
    if (!isTable(current)) return undefined;
    current = current[key];
  }
  return isTable(current) ? current : undefined;
}

/** Reads a string value; undefined when absent or not a string. */
export function getString(table: TomlTable | undefined, key: string): string | undefined {
  const value = table?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Reads an array of strings (a lone string counts as a one-item array). Others are dropped. */
export function getStringList(table: TomlTable | undefined, key: string): string[] {
  const value = table?.[key];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Reads an array and keeps only its table items (e.g. poetry `packages`). */
export function getTableList(table: TomlTable | undefined, key: string): TomlTable[] {
  const value = table?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isTable);
}
