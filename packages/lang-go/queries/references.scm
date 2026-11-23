; Go references. Calls and instantiations are adapted from tree-sitter-go queries/tags.scm
; (MIT); embedding patterns were written for RepoAtlas.
; Type references (params, results, fields, var types, ...) are collected in postProcess
; from the syntax tree, because they need context (declaration names, type parameters,
; receivers and composite-literal types must not count).

; ---- calls ------------------------------------------------------------------

; foo()
(call_expression
  function: (identifier) @name
  arguments: (argument_list) @args) @reference.call

; (foo)()
(call_expression
  function: (parenthesized_expression (identifier) @name)
  arguments: (argument_list) @args) @reference.call

; pkg.Func() / x.Method() / x.field.Method()
(call_expression
  function: (selector_expression
    operand: (_) @receiver
    field: (field_identifier) @name)
  arguments: (argument_list) @args) @reference.call

; (x.Method)()
(call_expression
  function: (parenthesized_expression
    (selector_expression
      operand: (_) @receiver
      field: (field_identifier) @name))
  arguments: (argument_list) @args) @reference.call

; Sum[int](a, b): explicit generic instantiation with several arguments (a single argument
; is parsed as a conversion, see below). `fns[i](x)` matches too; the resolver ignores it
; when `fns` is a local variable.
(call_expression
  function: (index_expression
    operand: (identifier) @name
    index: (identifier))
  arguments: (argument_list) @args) @reference.call

; Map[int](x): the grammar parses an explicit generic instantiation call as a conversion
(type_conversion_expression
  type: (generic_type
    type: (type_identifier) @name)) @reference.call

(type_conversion_expression
  type: (generic_type
    type: (qualified_type
      package: (package_identifier) @receiver
      name: (type_identifier) @name))) @reference.call

; ---- instantiation ----------------------------------------------------------

; Foo{...} and &Foo{...}
(composite_literal
  type: (type_identifier) @name) @reference.instantiate

(composite_literal
  type: (qualified_type
    package: (package_identifier) @receiver
    name: (type_identifier) @name)) @reference.instantiate

(composite_literal
  type: (generic_type
    type: (type_identifier) @name)) @reference.instantiate

(composite_literal
  type: (generic_type
    type: (qualified_type
      package: (package_identifier) @receiver
      name: (type_identifier) @name))) @reference.instantiate

; new(Foo)
(call_expression
  function: (identifier) @_fn
  arguments: (argument_list . (type_identifier) @name)
  (#eq? @_fn "new")) @reference.instantiate

(call_expression
  function: (identifier) @_fn
  arguments: (argument_list
    .
    (qualified_type
      package: (package_identifier) @receiver
      name: (type_identifier) @name))
  (#eq? @_fn "new")) @reference.instantiate

; ---- embedding (struct fields without a name) -------------------------------

(field_declaration
  !name
  type: (type_identifier) @name) @reference.extends

(field_declaration
  !name
  type: (qualified_type
    package: (package_identifier) @receiver
    name: (type_identifier) @name)) @reference.extends

(field_declaration
  !name
  type: (generic_type
    type: (type_identifier) @name)) @reference.extends

(field_declaration
  !name
  type: (generic_type
    type: (qualified_type
      package: (package_identifier) @receiver
      name: (type_identifier) @name))) @reference.extends

(field_declaration
  !name
  type: (pointer_type (type_identifier) @name)) @reference.extends

(field_declaration
  !name
  type: (pointer_type
    (qualified_type
      package: (package_identifier) @receiver
      name: (type_identifier) @name))) @reference.extends

(field_declaration
  !name
  type: (pointer_type
    (generic_type
      type: (type_identifier) @name))) @reference.extends

(field_declaration
  !name
  type: (pointer_type
    (generic_type
      type: (qualified_type
        package: (package_identifier) @receiver
        name: (type_identifier) @name)))) @reference.extends

; ---- embedding (interface elements that are a single type name) -------------

(interface_type
  (type_elem
    .
    (type_identifier) @name
    .) @reference.extends)

(interface_type
  (type_elem
    .
    (qualified_type
      package: (package_identifier) @receiver
      name: (type_identifier) @name)
    .) @reference.extends)
