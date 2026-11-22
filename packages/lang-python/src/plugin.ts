import type { LanguagePlugin, RepoFile, SourceFile } from "@repoatlas/plugin-api";
import type { FileExtraction } from "@repoatlas/schema";
import { extractPython } from "./extract/index.ts";
import { pythonPrepare } from "./prepare/index.ts";
import { pythonResolve } from "./resolve/index.ts";

/**
 * Only ".py" files are claimed. ".pyi" stubs describe types of another module and would
 * duplicate its symbols, so they are left out on purpose.
 */
export function isPythonSource(path: string): boolean {
  return path.endsWith(".py");
}

/** An empty extraction used if the extractor itself fails (it should never throw). */
function failedExtraction(file: SourceFile): FileExtraction {
  return {
    file: file.path,
    language: "python",
    definitions: [],
    imports: [],
    references: [],
    parseErrors: 1,
  };
}

export const pythonPlugin: LanguagePlugin = {
  id: "python",
  version: "1",
  languages: ["python"],
  tier: 1,

  detect: (files: RepoFile[]) => files.filter((f) => isPythonSource(f.path)),

  prepare: (ctx) => pythonPrepare(ctx),

  // Parse failures are reported through parseErrors; a thrown error (for example a grammar
  // that cannot be loaded) is turned into an empty extraction so one file never fails the run.
  async extract(file) {
    try {
      return await extractPython({ path: file.path, content: file.content });
    } catch {
      return failedExtraction(file);
    }
  },

  resolve: (input) => pythonResolve(input),
};
