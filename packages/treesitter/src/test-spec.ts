import { createRequire } from "node:module";
import type { SyntaxNode, TreeSitterLanguageSpec } from "./types.ts";

/**
 * A deliberately small Python spec used only by this package's tests to exercise the
 * generic engine. The real one lives in packages/lang-python.
 */
export function pythonGrammarPath(): string {
  return createRequire(import.meta.url).resolve("tree-sitter-python/tree-sitter-python.wasm");
}

const DEFINITIONS = `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
`;

const IMPORTS = `
(import_statement name: (dotted_name) @import.module) @import
(import_statement name: (aliased_import name: (dotted_name) @import.module alias: (identifier) @import.alias)) @import
(import_from_statement module_name: (_) @import.module name: (dotted_name) @import.name) @import
(import_from_statement module_name: (_) @import.module name: (aliased_import name: (dotted_name) @import.name alias: (identifier) @import.alias)) @import
(import_from_statement module_name: (_) @import.module (wildcard_import) @import.wildcard) @import
`;

const REFERENCES = `
(call function: (identifier) @name arguments: (argument_list) @args) @reference.call
(call function: (attribute object: (_) @receiver attribute: (identifier) @name) arguments: (argument_list) @args) @reference.call
(class_definition superclasses: (argument_list (identifier) @name)) @reference.extends
`;

export function miniPythonSpec(
  overrides: Partial<TreeSitterLanguageSpec> = {},
): TreeSitterLanguageSpec {
  return {
    language: "python",
    grammarWasm: pythonGrammarPath,
    extensions: [".py"],
    queries: { definitions: DEFINITIONS, imports: IMPORTS, references: REFERENCES },
    scopes: {
      containerTypes: ["class_definition"],
      selfNames: ["self", "cls"],
      superNames: ["super"],
    },
    signature: (node: SyntaxNode, src: string) => {
      const body = node.childForFieldName("body");
      const end = body === null ? node.endIndex : body.startIndex;
      return src.slice(node.startIndex, end);
    },
    ...overrides,
  };
}
