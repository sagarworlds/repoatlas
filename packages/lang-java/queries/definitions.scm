; Java definitions (capture conventions: packages/treesitter/README.md).
; Types declared at file level or as members of a named type, and their methods and
; constructors. Local classes cannot be excluded here (a local class is a class_declaration
; too); the post-process drops them. Members of anonymous classes and enum-constant bodies
; are not matched because every pattern names its parent type.
; Enums, records and annotation types are "class" (the post-process adds meta java.kind).

; top-level types
(program
  [(class_declaration name: (identifier) @name) @definition.class
   (record_declaration name: (identifier) @name) @definition.class
   (enum_declaration name: (identifier) @name) @definition.class
   (annotation_type_declaration name: (identifier) @name) @definition.class
   (interface_declaration name: (identifier) @name) @definition.interface])

; members of classes
(class_declaration
  body: (class_body
    [(class_declaration name: (identifier) @name) @definition.class
     (record_declaration name: (identifier) @name) @definition.class
     (enum_declaration name: (identifier) @name) @definition.class
     (annotation_type_declaration name: (identifier) @name) @definition.class
     (interface_declaration name: (identifier) @name) @definition.interface
     (method_declaration name: (identifier) @name) @definition.method
     (constructor_declaration name: (identifier) @name) @definition.method]))

; members of records (a compact constructor is a constructor)
(record_declaration
  body: (class_body
    [(class_declaration name: (identifier) @name) @definition.class
     (record_declaration name: (identifier) @name) @definition.class
     (enum_declaration name: (identifier) @name) @definition.class
     (annotation_type_declaration name: (identifier) @name) @definition.class
     (interface_declaration name: (identifier) @name) @definition.interface
     (method_declaration name: (identifier) @name) @definition.method
     (constructor_declaration name: (identifier) @name) @definition.method
     (compact_constructor_declaration name: (identifier) @name) @definition.method]))

; members of interfaces
(interface_declaration
  body: (interface_body
    [(class_declaration name: (identifier) @name) @definition.class
     (record_declaration name: (identifier) @name) @definition.class
     (enum_declaration name: (identifier) @name) @definition.class
     (annotation_type_declaration name: (identifier) @name) @definition.class
     (interface_declaration name: (identifier) @name) @definition.interface
     (method_declaration name: (identifier) @name) @definition.method]))

; members of enums (after the constants)
(enum_declaration
  body: (enum_body
    (enum_body_declarations
      [(class_declaration name: (identifier) @name) @definition.class
       (record_declaration name: (identifier) @name) @definition.class
       (enum_declaration name: (identifier) @name) @definition.class
       (annotation_type_declaration name: (identifier) @name) @definition.class
       (interface_declaration name: (identifier) @name) @definition.interface
       (method_declaration name: (identifier) @name) @definition.method
       (constructor_declaration name: (identifier) @name) @definition.method])))

; members of annotation types (the elements themselves are not definitions)
(annotation_type_declaration
  body: (annotation_type_body
    [(class_declaration name: (identifier) @name) @definition.class
     (record_declaration name: (identifier) @name) @definition.class
     (enum_declaration name: (identifier) @name) @definition.class
     (annotation_type_declaration name: (identifier) @name) @definition.class
     (interface_declaration name: (identifier) @name) @definition.interface]))
