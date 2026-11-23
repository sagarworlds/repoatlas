/** Predeclared types: a reference to one of these is never a reference into the repo. */
export const PREDECLARED_TYPES: ReadonlySet<string> = new Set([
  "any",
  "bool",
  "byte",
  "comparable",
  "complex64",
  "complex128",
  "error",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "rune",
  "string",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
]);

/**
 * Predeclared functions that make no reference. `min`, `max`, `clear` and `print` are NOT in
 * this list on purpose: many repos define their own helpers with these names.
 */
export const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  "append",
  "cap",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "new",
  "panic",
  "println",
  "real",
  "recover",
]);
