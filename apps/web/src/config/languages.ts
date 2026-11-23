import type { LanguageId } from "../api/types.ts";

export interface LanguageInfo {
  id: LanguageId;
  /** Human-readable name, used in banners and chips. */
  name: string;
  /** True once a language plugin exists. The ONE place to flip when a plugin lands. */
  supported: boolean;
}

/** All 12 schema language ids with display names. Order = order of the home page chips. */
export const LANGUAGE_INFO: readonly LanguageInfo[] = [
  { id: "typescript", name: "TypeScript", supported: true },
  { id: "javascript", name: "JavaScript", supported: true },
  { id: "python", name: "Python", supported: true },
  { id: "go", name: "Go", supported: true },
  { id: "java", name: "Java", supported: true },
  { id: "kotlin", name: "Kotlin", supported: false },
  { id: "csharp", name: "C#", supported: false },
  { id: "rust", name: "Rust", supported: false },
  { id: "php", name: "PHP", supported: false },
  { id: "ruby", name: "Ruby", supported: false },
  { id: "c", name: "C", supported: false },
  { id: "cpp", name: "C/C++", supported: false },
];

/** Languages with a plugin, derived from LANGUAGE_INFO. */
export const SUPPORTED_LANGUAGES: readonly LanguageId[] = LANGUAGE_INFO.filter(
  (l) => l.supported,
).map((l) => l.id);

export function isLanguageSupported(id: LanguageId): boolean {
  return SUPPORTED_LANGUAGES.includes(id);
}

/** Display name for a language id; unknown ids (from newer data) are shown as they are. */
export function languageName(id: string): string {
  return LANGUAGE_INFO.find((l) => l.id === id)?.name ?? id;
}

/** Tooltip text explaining how much to trust call links per plugin tier. */
export function tierHint(tier: 1 | 2 | 3): string {
  switch (tier) {
    case 3:
      return "Tier 3: calls are resolved by the language's own compiler, so links are the most precise.";
    case 2:
      return "Tier 2: calls are resolved with the help of a partial type analysis; some links are approximate.";
    case 1:
      return "Tier 1: syntax-based resolution; call links are approximate and some are name matches.";
  }
}
