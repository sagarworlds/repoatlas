; Java references (capture conventions: packages/treesitter/README.md).
; Calls, instantiations and class heritage are matched here. Annotations and type
; references (fields, parameters, returns, generics, casts, throws, ...) need parent and
; type-parameter context, so the spec's postProcess adds them (src/extract/post-process.ts).

; foo(...)   (no receiver; with a receiver the next pattern wins)
(method_invocation
  name: (identifier) @name
  arguments: (argument_list) @args) @reference.call

; recv.foo(...)   this.foo()   super.foo()   a.b.foo()   Type.foo()   foo().bar()
(method_invocation
  object: (_) @receiver
  name: (identifier) @name
  arguments: (argument_list) @args) @reference.call

; this(...)   super(...)  (name is the keyword; the post-process sets receiverKind)
(explicit_constructor_invocation
  constructor: (this) @name
  arguments: (argument_list) @args) @reference.call

(explicit_constructor_invocation
  constructor: (super) @name
  arguments: (argument_list) @args) @reference.call

; Foo::bar   this::bar   a.b.Foo::bar   (no args node: argCount stays undefined)
(method_reference
  . (_) @receiver
  . (identifier) @name .) @reference.call

; Foo::new
(method_reference
  . (identifier) @name
  "new") @reference.instantiate

; new Foo(...)   new Foo<>(...)   new a.b.Foo(...)   new Outer.Inner(...)
(object_creation_expression
  type: [
    (type_identifier) @name
    (generic_type (type_identifier) @name)
    (scoped_type_identifier (_) @receiver . (type_identifier) @name .)
    (generic_type (scoped_type_identifier (_) @receiver . (type_identifier) @name .))
  ]
  arguments: (argument_list) @args) @reference.instantiate

; class C extends Base   (also Base<T>, a.b.Base, Outer.Base)
(superclass
  [
    (type_identifier) @name
    (generic_type (type_identifier) @name)
    (scoped_type_identifier (_) @receiver . (type_identifier) @name .)
    (generic_type (scoped_type_identifier (_) @receiver . (type_identifier) @name .))
  ]) @reference.extends

; class C implements A, B   enum E implements A   record R(...) implements A
(super_interfaces
  (type_list
    [
      (type_identifier) @name
      (generic_type (type_identifier) @name)
      (scoped_type_identifier (_) @receiver . (type_identifier) @name .)
      (generic_type (scoped_type_identifier (_) @receiver . (type_identifier) @name .))
    ])) @reference.implements

; interface I extends A, B
(extends_interfaces
  (type_list
    [
      (type_identifier) @name
      (generic_type (type_identifier) @name)
      (scoped_type_identifier (_) @receiver . (type_identifier) @name .)
      (generic_type (scoped_type_identifier (_) @receiver . (type_identifier) @name .))
    ])) @reference.extends
