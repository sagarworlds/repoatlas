import type { LanguageId } from "../api/types.ts";
import { isLanguageSupported } from "./languages.ts";

export interface ExampleRepo {
  /** "owner/repo" */
  repo: string;
  language: LanguageId;
  description: string;
}

/** An example is usable once its language plugin exists (see config/languages.ts). */
export function isExampleAvailable(example: ExampleRepo): boolean {
  return isLanguageSupported(example.language);
}

/** "Try" examples on the home page. Availability follows the supported-language config. */
export const EXAMPLES: readonly ExampleRepo[] = [
  {
    repo: "sindresorhus/ky",
    language: "typescript",
    description: "Tiny HTTP client built on fetch",
  },
  {
    repo: "pmndrs/zustand",
    language: "typescript",
    description: "Small state management library",
  },
  {
    repo: "pallets/click",
    language: "python",
    description: "Command line interfaces for Python",
  },
  {
    repo: "expressjs/express",
    language: "javascript",
    description: "Fast, minimalist web framework for Node.js",
  },
  {
    repo: "spf13/cobra",
    language: "go",
    description: "A library for modern CLI apps in Go",
  },
  {
    repo: "google/gson",
    language: "java",
    description: "Java library for JSON serialization",
  },
];
