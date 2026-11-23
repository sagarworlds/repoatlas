import type { LanguagePlugin, RepoFile, SourceFile } from "@repoatlas/plugin-api";
import type { FileExtraction } from "@repoatlas/schema";
import { extractJava } from "./extract/index.ts";
import { javaPrepare } from "./prepare/index.ts";
import { javaResolve } from "./resolve/index.ts";

export function isJavaSource(path: string): boolean {
  return path.endsWith(".java");
}

/** An empty extraction used if the extractor itself fails (it should never throw). */
function failedExtraction(file: SourceFile): FileExtraction {
  return {
    file: file.path,
    language: "java",
    definitions: [],
    imports: [],
    references: [],
    parseErrors: 1,
  };
}

export const javaPlugin: LanguagePlugin = {
  id: "java",
  version: "1",
  languages: ["java"],
  tier: 1,

  detect: (files: RepoFile[]) => files.filter((f) => isJavaSource(f.path)),

  prepare: (ctx) => javaPrepare(ctx),

  // A thrown error (for example a grammar that cannot be loaded) becomes an empty
  // extraction, so one file never fails the whole analysis.
  async extract(file) {
    try {
      return await extractJava({ path: file.path, content: file.content });
    } catch {
      return failedExtraction(file);
    }
  },

  resolve: (input) => javaResolve(input),
};
