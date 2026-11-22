; Python imports (capture conventions: packages/treesitter/README.md).
; Imports at any depth match (function level, try/except, TYPE_CHECKING blocks).

; import a.b, c
(import_statement
  name: (dotted_name) @import.module) @import

; import a.b as c
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.module
    alias: (identifier) @import.alias)) @import

; from a.b import x, y          from . import x          from ..pkg import y
(import_from_statement
  module_name: (_) @import.module
  name: (dotted_name) @import.name) @import

; from a.b import x as z
(import_from_statement
  module_name: (_) @import.module
  name: (aliased_import
    name: (dotted_name) @import.name
    alias: (identifier) @import.alias)) @import

; from a import *
(import_from_statement
  module_name: (_) @import.module
  (wildcard_import) @import.wildcard) @import

; importlib.import_module("a.b")   (only a plain string literal, no f-string interpolation)
(call
  function: (attribute
    attribute: (identifier) @_fn)
  arguments: (argument_list
    .
    (string
      (string_start)
      .
      (string_content) @import.module
      .
      (string_end)))
  (#eq? @_fn "import_module")) @import @import.dynamic

; __import__("a.b")
(call
  function: (identifier) @_fn
  arguments: (argument_list
    .
    (string
      (string_start)
      .
      (string_content) @import.module
      .
      (string_end)))
  (#eq? @_fn "__import__")) @import @import.dynamic
