; Go definitions. Adapted from tree-sitter-go queries/tags.scm (MIT).
; Only top-level declarations are definitions (local types are not).
; A method is attached to its receiver type in postProcess (the type may be in another file).
; Struct vs interface vs alias is decided in postProcess from the syntax tree.

(source_file
  (function_declaration
    name: (identifier) @name) @definition.function)

(source_file
  (method_declaration
    name: (field_identifier) @name) @definition.method)

(source_file
  (type_declaration
    (type_spec
      name: (type_identifier) @name) @definition.class))

(source_file
  (type_declaration
    (type_alias
      name: (type_identifier) @name) @definition.class))
