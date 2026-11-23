; Java imports. Specifier conventions (docs/LANGUAGE_PLUGINS.md section 6, Java):
;   import a.b.C;          -> module   "a.b.C"
;   import a.b.*;          -> wildcard "a.b"
;   import static a.b.C.m; -> named    "a.b.C" names [m]
;   import static a.b.C.*; -> wildcard "a.b.C"
; A query cannot say "has no static keyword", so the #match? predicates on the whole
; statement text keep the static and non-static patterns apart.

; import a.b.C;   import C;
((import_declaration
   [(scoped_identifier) (identifier)] @import.module) @import
 (#not-match? @import "^import\\s+static\\b")
 (#not-match? @import "\\*\\s*;?\\s*$"))

; import a.b.*;   import a.*;
((import_declaration
   [(scoped_identifier) (identifier)] @import.module
   (asterisk) @import.wildcard) @import
 (#not-match? @import "^import\\s+static\\b"))

; import static a.b.C.m;
((import_declaration
   (scoped_identifier
     scope: (_) @import.module
     name: (identifier) @import.name)) @import
 (#match? @import "^import\\s+static\\b")
 (#not-match? @import "\\*\\s*;?\\s*$"))

; import static a.b.C.*;
((import_declaration
   (scoped_identifier) @import.module
   (asterisk) @import.wildcard) @import
 (#match? @import "^import\\s+static\\b"))
