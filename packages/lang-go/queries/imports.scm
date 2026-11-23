; Go imports. One import_spec per imported package, also inside `import ( ... )` blocks.
; The first pattern matches every spec; the others add the alias or the marker.
; (import "C" for cgo is dropped in postProcess.)

(import_spec
  path: (_) @import.module) @import

; import str "strings"
(import_spec
  name: (package_identifier) @import.alias
  path: (_) @import.module) @import

; import . "pkg"
(import_spec
  name: (dot) @import.wildcard
  path: (_) @import.module) @import

; import _ "pkg"
(import_spec
  name: (blank_identifier) @import.side-effect
  path: (_) @import.module) @import
