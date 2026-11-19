import type { LanguageId } from "./graph.ts";

/**
 * Node ID helpers. Always build IDs through these functions (GRAPH_SCHEMA §3).
 * All paths are POSIX (forward slashes), relative to the repo root.
 */

/** Converts Windows separators to "/" and strips a leading "./" and trailing "/". */
export function toPosixPath(p: string): string {
  let out = p.replaceAll("\\", "/");
  while (out.startsWith("./")) out = out.slice(2);
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out === "." ? "" : out;
}

/** True when `p` is a clean repo-relative POSIX path (no "..", absolute, drive letter, NUL). */
export function isSafeRelativePath(p: string): boolean {
  if (p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return !p.split("/").some((seg) => seg === ".." || seg === ".");
}

export function repoId(): string {
  return "repo:";
}

/** The root directory is `dir:` (empty path). */
export function dirId(path: string): string {
  return `dir:${toPosixPath(path)}`;
}

export function fileId(path: string): string {
  return `file:${toPosixPath(path)}`;
}

export function moduleId(lang: LanguageId, qualified: string): string {
  return `mod:${lang}:${qualified}`;
}

/** `qualifiedInFile` is the dotted chain of enclosing names within the file, e.g. "User.save". */
export function symbolId(path: string, qualifiedInFile: string): string {
  return `sym:${toPosixPath(path)}#${qualifiedInFile}`;
}

export function externalId(ecosystem: string, pkg: string): string {
  return `ext:${ecosystem}:${pkg}`;
}

/**
 * Collision suffix: later declarations with the same localId get `@{startLine}`
 * ("Foo.bar@42"). The first occurrence keeps the plain ID. Returns one localId per
 * input item, in the same order.
 */
export function disambiguateLocalIds(
  items: readonly { localId: string; startLine: number }[],
): string[] {
  const seen = new Set<string>();
  return items.map(({ localId, startLine }) => {
    let candidate = localId;
    if (seen.has(candidate)) {
      candidate = `${localId}@${startLine}`;
      let n = 2;
      while (seen.has(candidate)) candidate = `${localId}@${startLine}_${n++}`;
    }
    seen.add(candidate);
    return candidate;
  });
}

/** Strips subpaths from an npm specifier: "lodash/fp" -> "lodash", "@a/b/c" -> "@a/b". */
export function npmPackageName(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? specifier;
}

export type ParsedId =
  | { kind: "repo" }
  | { kind: "dir"; path: string }
  | { kind: "file"; path: string }
  | { kind: "module"; language: string; qualified: string }
  | { kind: "symbol"; path: string; qualifiedInFile: string }
  | { kind: "external"; ecosystem: string; pkg: string };

/** Inverse of the builders above. Returns undefined for malformed IDs. */
export function parseId(id: string): ParsedId | undefined {
  if (id === "repo:") return { kind: "repo" };
  if (id.startsWith("dir:")) return { kind: "dir", path: id.slice(4) };
  if (id.startsWith("file:")) return { kind: "file", path: id.slice(5) };
  if (id.startsWith("mod:")) {
    const rest = id.slice(4);
    const i = rest.indexOf(":");
    if (i < 0) return undefined;
    return { kind: "module", language: rest.slice(0, i), qualified: rest.slice(i + 1) };
  }
  if (id.startsWith("sym:")) {
    const rest = id.slice(4);
    const i = rest.indexOf("#");
    if (i < 0) return undefined;
    return { kind: "symbol", path: rest.slice(0, i), qualifiedInFile: rest.slice(i + 1) };
  }
  if (id.startsWith("ext:")) {
    const rest = id.slice(4);
    const i = rest.indexOf(":");
    if (i < 0) return undefined;
    return { kind: "external", ecosystem: rest.slice(0, i), pkg: rest.slice(i + 1) };
  }
  return undefined;
}
