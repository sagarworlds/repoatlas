import type { LanguagePlugin, RepoFile, SourceFile } from "@repoatlas/plugin-api";
import type { FileExtraction } from "@repoatlas/schema";
import { extractGo } from "./extract/index.ts";
import { goPrepare } from "./prepare/index.ts";
import { goResolve } from "./resolve/index.ts";

export function isGoSource(path: string): boolean {
  return path.endsWith(".go");
}

/** An empty extraction used if the extractor itself fails (it should never throw). */
function failedExtraction(file: SourceFile): FileExtraction {
  return {
    file: file.path,
    language: "go",
    definitions: [],
    imports: [],
    references: [],
    parseErrors: 1,
  };
}

export const goPlugin: LanguagePlugin = {
  id: "go",
  version: "1",
  languages: ["go"],
  tier: 1,

  detect: (files: RepoFile[]) => files.filter((f) => isGoSource(f.path)),

  prepare: (ctx) => goPrepare(ctx),

  async extract(file) {
    try {
      return await extractGo({ path: file.path, content: file.content });
    } catch {
      return failedExtraction(file);
    }
  },

  resolve: (input) => goResolve(input),
};
