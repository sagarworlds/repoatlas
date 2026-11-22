; Python references (capture conventions: packages/treesitter/README.md).
; Python syntax does not tell a call from a constructor call: everything is "call" and the
; resolver decides (Foo() resolves to Foo.__init__ when it exists).
; Type annotations are added by the spec's postProcess (they nest too deeply for a query).

; foo(...)
(call
  function: (identifier) @name
  arguments: (argument_list) @args) @reference.call

; foo(x for x in y)   (no argCount: a generator is one argument)
(call
  function: (identifier) @name
  arguments: (generator_expression)) @reference.call

; recv.foo(...)   self.foo()   super().foo()   a.b.c()   foo().bar()
(call
  function: (attribute
    object: (_) @receiver
    attribute: (identifier) @name)
  arguments: (argument_list) @args) @reference.call

(call
  function: (attribute
    object: (_) @receiver
    attribute: (identifier) @name)
  arguments: (generator_expression)) @reference.call

; @decorator and @pkg.decorator without call parentheses. Decorators that are call
; expressions (@app.route("/")) are already matched by the call patterns above.
(decorator
  (identifier) @name
  (#not-any-of? @name "staticmethod" "classmethod" "property" "abstractmethod" "override")) @reference.call

(decorator
  (attribute
    object: (_) @receiver
    attribute: (identifier) @name)
  (#not-any-of? @name "setter" "getter" "deleter")) @reference.call

; class C(Base)   class C(pkg.Base)   class C(Base[T])   class C(pkg.Base[T])
(class_definition
  superclasses: (argument_list
    (identifier) @name)) @reference.extends

(class_definition
  superclasses: (argument_list
    (attribute
      object: (_) @receiver
      attribute: (identifier) @name))) @reference.extends

(class_definition
  superclasses: (argument_list
    (subscript
      value: (identifier) @name))) @reference.extends

(class_definition
  superclasses: (argument_list
    (subscript
      value: (attribute
        object: (_) @receiver
        attribute: (identifier) @name)))) @reference.extends
