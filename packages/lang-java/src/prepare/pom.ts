/**
 * Minimal, never-throwing reader for the dependency groupIds of a Maven `pom.xml`.
 *
 * Security: this is a tokenizer, not an XML parser. DOCTYPE declarations, processing
 * instructions, comments and CDATA are skipped; entities are never expanded; the input
 * size and the element depth are capped. Nothing in the file is ever executed.
 */

const MAX_XML_CHARS = 2_000_000;
const MAX_DEPTH = 64;
/** Elements under which a `<dependency>` is not a compile-time dependency of the code. */
const IGNORED_ANCESTORS: ReadonlySet<string> = new Set([
  "build",
  "plugin",
  "plugins",
  "pluginManagement",
  "reporting",
]);

interface OpenElement {
  name: string;
  /** Index just after the `>` of the opening tag. */
  textStart: number;
}

function isGroupIdChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "." ||
    ch === "-" ||
    ch === "_"
  );
}

/** A literal groupId: letters, digits, dot, dash, underscore. Rejects `${...}` and entities. */
export function isPlainGroupId(text: string): boolean {
  if (text === "" || text.length > 200) return false;
  for (const ch of text) if (!isGroupIdChar(ch)) return false;
  return !text.startsWith(".") && !text.endsWith(".");
}

function localName(tag: string): string {
  const colon = tag.indexOf(":");
  return colon < 0 ? tag : tag.slice(colon + 1);
}

/** Index of the `>` that ends the tag starting at `start`, ignoring `>` inside quotes. */
function findTagEnd(xml: string, start: number): number {
  let quote = "";
  for (let i = start; i < xml.length; i++) {
    const ch = xml.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/** Skips a `<!DOCTYPE ...>` including an internal `[...]` subset. Returns the index after it. */
function skipDeclaration(xml: string, start: number): number {
  let depth = 0;
  for (let i = start; i < xml.length; i++) {
    const ch = xml.charAt(i);
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return xml.length;
}

function skipPast(xml: string, from: number, marker: string): number {
  const end = xml.indexOf(marker, from);
  return end < 0 ? xml.length : end + marker.length;
}

/** Sorted, de-duplicated groupIds of the `<dependency>` entries of a pom.xml text. */
export function pomDependencyGroups(xml: string): string[] {
  const groups = new Set<string>();
  try {
    const text = xml.length > MAX_XML_CHARS ? xml.slice(0, MAX_XML_CHARS) : xml;
    const stack: OpenElement[] = [];
    let i = 0;
    while (i < text.length) {
      const lt = text.indexOf("<", i);
      if (lt < 0) break;
      if (text.startsWith("<!--", lt)) {
        i = skipPast(text, lt + 4, "-->");
        continue;
      }
      if (text.startsWith("<![CDATA[", lt)) {
        i = skipPast(text, lt + 9, "]]>");
        continue;
      }
      if (text.startsWith("<?", lt)) {
        i = skipPast(text, lt + 2, "?>");
        continue;
      }
      if (text.startsWith("<!", lt)) {
        i = skipDeclaration(text, lt + 2);
        continue;
      }
      const end = findTagEnd(text, lt + 1);
      if (end < 0) break;
      const raw = text.slice(lt + 1, end);
      i = end + 1;
      const closing = raw.startsWith("/");
      const selfClosing = raw.endsWith("/");
      const body = raw.slice(closing ? 1 : 0, selfClosing ? raw.length - 1 : raw.length);
      let nameEnd = 0;
      while (nameEnd < body.length && !" \t\r\n".includes(body.charAt(nameEnd))) nameEnd++;
      const name = localName(body.slice(0, nameEnd));
      if (name === "") continue;

      if (closing) {
        const top = stack.pop();
        if (top === undefined || top.name !== name) {
          // Malformed nesting: stop rather than guess.
          break;
        }
        if (name !== "groupId") continue;
        const parent = stack[stack.length - 1];
        const grand = stack[stack.length - 2];
        if (parent?.name !== "dependency" || grand?.name !== "dependencies") continue;
        if (stack.some((e) => IGNORED_ANCESTORS.has(e.name))) continue;
        const value = text.slice(top.textStart, lt).trim();
        if (isPlainGroupId(value)) groups.add(value);
      } else if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) break;
        stack.push({ name, textStart: end + 1 });
      }
    }
  } catch {
    // Anything unexpected: keep what was found so far.
  }
  return [...groups].sort();
}
