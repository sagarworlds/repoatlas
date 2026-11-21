import type { LanguageId } from "../api/types.ts";

export interface ExampleRepo {
  /** "owner/repo" */
  repo: string;
  language: LanguageId;
  description: string;
  /** False until the language plugin exists: the example is shown but disabled. */
  available: boolean;
}

/** "Try" examples on the home page. Data-driven: flip `available` when a plugin lands. */
export const EXAMPLES: readonly ExampleRepo[] = [
  {
    repo: "sindresorhus/ky",
    language: "typescript",
    description: "Tiny HTTP client built on fetch",
    available: true,
  },
  {
    repo: "pmndrs/zustand",
    language: "typescript",
    description: "Small state management library",
    available: true,
  },
  {
    repo: "pallets/click",
    language: "python",
    description: "Command line interfaces for Python",
    available: false,
  },
  {
    repo: "spf13/cobra",
    language: "go",
    description: "A library for modern CLI apps in Go",
    available: false,
  },
];

export interface LanguageSupport {
  id: LanguageId;
  label: string;
  /** False = shown as a muted "coming soon" chip. */
  supported: boolean;
}

/** Languages shown as chips on the home page. */
export const LANGUAGES: readonly LanguageSupport[] = [
  { id: "typescript", label: "TypeScript / JavaScript", supported: true },
  { id: "python", label: "Python", supported: false },
  { id: "go", label: "Go", supported: false },
  { id: "java", label: "Java", supported: false },
  { id: "csharp", label: "C#", supported: false },
  { id: "rust", label: "Rust", supported: false },
];
