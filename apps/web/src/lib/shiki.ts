// Syntax highlighting with Shiki, loaded lazily.
//
// Nothing from "shiki" is imported at the top of this file: every import is a dynamic
// `import()`, which Vite turns into a separate chunk that is only downloaded the first time
// code is highlighted (like loading an assembly on demand with Assembly.Load).
//
// We use the token API (codeToTokens) and return plain data, so React renders the tokens as
// <span> elements and no HTML string is ever injected into the page.
import type { LanguageId } from "@repoatlas/schema";
import type { HighlighterCore } from "shiki/core";

export type ThemeMode = "light" | "dark";

/** One coloured piece of a line. */
export interface CodeToken {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** A line is a list of tokens (an empty line has none). */
export type CodeLine = CodeToken[];

/** Lines beyond this are shown without colours (keeps highlighting fast on huge files). */
export const MAX_HIGHLIGHT_LINES = 3000;

/** Lines longer than this are not tokenized by Shiki (minified bundles). */
const MAX_LINE_LENGTH = 1000;

/** Our language ids to Shiki's language ids. They happen to be identical today. */
const SHIKI_LANGUAGES: Record<LanguageId, string> = {
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  go: "go",
  java: "java",
  kotlin: "kotlin",
  csharp: "csharp",
  rust: "rust",
  php: "php",
  ruby: "ruby",
  c: "c",
  cpp: "cpp",
};

/** Shiki language id for one of our languages; undefined means "show as plain text". */
export function shikiLanguageFor(language: string | null | undefined): string | undefined {
  if (language === null || language === undefined) return undefined;
  return Object.hasOwn(SHIKI_LANGUAGES, language)
    ? SHIKI_LANGUAGES[language as LanguageId]
    : undefined;
}

// Each loader is a separate lazy chunk, so only the languages actually viewed are downloaded.
type LanguageModule = { default: Parameters<HighlighterCore["loadLanguage"]>[0] };
const LANGUAGE_LOADERS: Record<string, () => Promise<LanguageModule>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
};

/** The subset of Shiki's token that we read (so tests do not need Shiki). */
export interface ThemedTokenLike {
  content: string;
  color?: string | undefined;
  /** Bit flags: 1 italic, 2 bold, 4 underline. */
  fontStyle?: number | undefined;
}

/** Converts Shiki tokens (one array per line) into our plain token lines. */
export function toCodeLines(lines: readonly (readonly ThemedTokenLike[])[]): CodeLine[] {
  return lines.map((line) =>
    line.map((token) => {
      const out: CodeToken = { text: token.content };
      if (token.color) out.color = token.color;
      const style = token.fontStyle ?? 0;
      if (style > 0) {
        if (style & 1) out.italic = true;
        if (style & 2) out.bold = true;
        if (style & 4) out.underline = true;
      }
      return out;
    }),
  );
}

/** Splits text into lines without colours (used for plain text and while Shiki loads). */
export function plainLines(code: string): CodeLine[] {
  return code.split("\n").map((text) => (text === "" ? [] : [{ text }]));
}

let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === undefined) {
    highlighterPromise = (async () => {
      const [core, engine, light, dark] = await Promise.all([
        import("shiki/core"),
        // The JavaScript regex engine avoids shipping the WASM file.
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light.mjs"),
        import("shiki/themes/github-dark.mjs"),
      ]);
      return core.createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: engine.createJavaScriptRegexEngine(),
      });
    })();
    // A failed load must not be cached forever.
    highlighterPromise.catch(() => {
      highlighterPromise = undefined;
    });
  }
  return highlighterPromise;
}

/**
 * Highlights `code` and returns one token list per line. Never throws: unknown languages,
 * load failures and tokenizer errors all give plain, uncoloured lines.
 */
export async function highlightCode(
  code: string,
  language: string | null | undefined,
  mode: ThemeMode,
): Promise<CodeLine[]> {
  const lang = shikiLanguageFor(language);
  const loader = lang === undefined ? undefined : LANGUAGE_LOADERS[lang];
  if (lang === undefined || loader === undefined) return plainLines(code);

  try {
    const lines = code.split("\n");
    const head = lines.slice(0, MAX_HIGHLIGHT_LINES);
    const tail = lines.slice(MAX_HIGHLIGHT_LINES);

    const highlighter = await getHighlighter();
    await highlighter.loadLanguage((await loader()).default);
    const result = highlighter.codeToTokens(head.join("\n"), {
      lang,
      theme: mode === "dark" ? "github-dark" : "github-light",
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
    });
    const colored = toCodeLines(result.tokens);
    // Shiki returns exactly one entry per input line; guard against a mismatch anyway.
    if (colored.length !== head.length) return plainLines(code);
    return tail.length === 0 ? colored : [...colored, ...plainLines(tail.join("\n"))];
  } catch {
    return plainLines(code);
  }
}
