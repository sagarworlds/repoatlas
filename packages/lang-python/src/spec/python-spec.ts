import type { TreeSitterLanguageSpec } from "@repoatlas/treesitter";
import { postProcessPython } from "../extract/post-process.ts";
import { pythonGrammarPath } from "../grammar.ts";
import { loadPythonQueries } from "./queries.ts";
import { inferPythonReceiverType } from "./receiver-type.ts";
import { pythonSignature } from "./signature.ts";

/**
 * The Python language spec for the generic tree-sitter engine. The engine caches its
 * compiled parser and queries per spec object, so always use this one instance.
 * The .scm files are read once, when this module is first imported.
 */
export const pythonSpec: TreeSitterLanguageSpec = {
  language: "python",
  grammarWasm: () => pythonGrammarPath(),
  extensions: [".py", ".pyi"],
  queries: loadPythonQueries(),
  scopes: {
    containerTypes: ["class_definition"],
    selfNames: ["self", "cls"],
    superNames: ["super"],
  },
  signature: (node) => pythonSignature(node),
  inferReceiverType: inferPythonReceiverType,
  postProcess: postProcessPython,
};
