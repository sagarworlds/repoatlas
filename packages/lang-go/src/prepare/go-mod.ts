/** What `prepare` needs from one go.mod file. */
export interface GoModFile {
  /** The path of the `module` directive, or undefined when the file has none. */
  modulePath: string | undefined;
  /** Module paths named by `require` directives (single-line and block form). */
  requires: string[];
}

const MAX_GO_MOD_CHARS = 1_000_000;
const MAX_REQUIRES = 5000;

/** Cuts a `//` comment off a line, ignoring `//` inside "double" or `raw` quotes. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== undefined) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "/" && line.charAt(i + 1) === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Splits on whitespace; a quoted token keeps its inside (without the quotes). */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "`") {
      let end = i + 1;
      while (end < line.length && line.charAt(end) !== ch) {
        end += ch === '"' && line.charAt(end) === "\\" ? 2 : 1;
      }
      tokens.push(line.slice(i + 1, end));
      i = end + 1;
    } else {
      let end = i;
      while (end < line.length && !/\s/.test(line.charAt(end))) end++;
      tokens.push(line.slice(i, end));
      i = end;
    }
  }
  return tokens;
}

function cleanModulePath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let path = raw.trim();
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "" || /[\s\0]/.test(path)) return undefined;
  return path;
}

type Block = "module" | "require" | "other";

/**
 * Reads the `module` path and the `require`d module paths of a go.mod file. Strict and
 * line based: it never throws, ignores what it does not understand (replace, exclude,
 * retract, go, toolchain, ...) and caps its work on huge input. Handles quotes, `//`
 * comments, CRLF, a byte order mark and the parenthesised block form of every directive.
 */
export function parseGoMod(text: string): GoModFile {
  const result: GoModFile = { modulePath: undefined, requires: [] };
  try {
    const source = text.length > MAX_GO_MOD_CHARS ? text.slice(0, MAX_GO_MOD_CHARS) : text;
    let block: Block | undefined;
    for (const rawLine of source.replace(/^﻿/, "").split("\n")) {
      const tokens = tokenize(stripComment(rawLine));
      const first = tokens[0];
      if (first === undefined) continue;
      if (block !== undefined) {
        if (first === ")") block = undefined;
        else if (block === "module") result.modulePath ??= cleanModulePath(first);
        else if (block === "require" && result.requires.length < MAX_REQUIRES) {
          const path = cleanModulePath(first);
          if (path !== undefined) result.requires.push(path);
        }
        continue;
      }
      // `require(` (no space) is accepted too.
      const glued = first.length > 1 && first.endsWith("(");
      const keyword = glued ? first.slice(0, -1) : first;
      const rest = tokens.slice(1);
      const opens = glued || rest[0] === "(";
      const args = rest[0] === "(" ? rest.slice(1) : rest;
      if (keyword === "module") {
        if (opens) block = "module";
        else result.modulePath ??= cleanModulePath(args[0]);
      } else if (keyword === "require") {
        if (opens) block = "require";
        else if (result.requires.length < MAX_REQUIRES) {
          const path = cleanModulePath(args[0]);
          if (path !== undefined) result.requires.push(path);
        }
      } else if (opens) {
        block = "other";
      }
    }
  } catch {
    // Unreachable in practice; whatever was read so far is still valid.
  }
  return result;
}
