; Python definitions. Adapted from tree-sitter-python queries/tags.scm (MIT).
; A function directly inside a class becomes a "method" in the engine (scopes.containerTypes).
; Module-level constants are not definitions (the schema has no variable kind).

(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function
