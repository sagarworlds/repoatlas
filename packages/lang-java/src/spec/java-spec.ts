import type { TreeSitterLanguageSpec } from "@repoatlas/treesitter";
import { postProcessJava } from "../extract/post-process.ts";
import { javaGrammarPath } from "../grammar.ts";
import { loadJavaQueries } from "./queries.ts";
import { inferJavaReceiverType } from "./receiver-type.ts";
import { javaSignature } from "./signature.ts";

/**
 * The Java language spec for the generic tree-sitter engine. The engine caches its compiled
 * parser and queries per spec object, so always use this one instance. The .scm files are
 * read once, when this module is first imported.
 *
 * containerTypes is empty: every definition kind is already given explicitly by the queries
 * (methods are `definition.method`), so no function-to-method promotion is needed.
 */
export const javaSpec: TreeSitterLanguageSpec = {
  language: "java",
  grammarWasm: () => javaGrammarPath(),
  extensions: [".java"],
  queries: loadJavaQueries(),
  scopes: {
    containerTypes: [],
    selfNames: ["this"],
    superNames: ["super"],
  },
  signature: (node) => javaSignature(node),
  inferReceiverType: inferJavaReceiverType,
  postProcess: postProcessJava,
};
