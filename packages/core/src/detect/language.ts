import type { LanguageId } from "@repoatlas/schema";

const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, LanguageId> = new Map<string, LanguageId>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".cs", "csharp"],
  [".rs", "rust"],
  [".php", "php"],
  [".rb", "ruby"],
  [".c", "c"],
  [".h", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
]);

/** Pure extension-based language lookup. TypeScript declaration files are not analyzed. */
export function languageOfPath(path: string): LanguageId | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/\.d\.[cm]?ts$/.test(base)) return undefined;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined; // no extension, or a dotfile such as ".c"
  return EXTENSION_TO_LANGUAGE.get(base.slice(dot));
}
