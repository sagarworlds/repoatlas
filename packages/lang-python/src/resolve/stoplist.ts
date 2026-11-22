import { isStoplisted } from "@repoatlas/plugin-api";

/**
 * Names that are never name-matched in Python: methods of builtin types and builtin
 * functions. Added to the shared stoplist in plugin-api (`get`, `set`, `append`, ...).
 */
export const PYTHON_STOPLIST: readonly string[] = [
  "items",
  "keys",
  "values",
  "join",
  "split",
  "strip",
  "format",
  "encode",
  "decode",
  "lower",
  "upper",
  "startswith",
  "endswith",
  "copy",
  "sort",
  "extend",
  "insert",
  "index",
  "count",
  "clear",
  "find",
  "replace",
  "sum",
  "min",
  "max",
  "any",
  "all",
  "sorted",
  "enumerate",
  "zip",
  "range",
  "isinstance",
  "getattr",
  "setattr",
  "hasattr",
  "super",
  "len",
  "str",
  "int",
  "float",
  "list",
  "dict",
  "set",
  "tuple",
  "bool",
  "type",
  "id",
  "repr",
  "hash",
  "iter",
  "next",
  "open",
  "input",
  "exit",
];

/** Other builtins that can be called or subclassed with no import (not used for matching). */
const OTHER_BUILTINS: readonly string[] = [
  "abs",
  "bytes",
  "bytearray",
  "callable",
  "chr",
  "classmethod",
  "dir",
  "divmod",
  "filter",
  "frozenset",
  "issubclass",
  "map",
  "object",
  "ord",
  "pow",
  "print",
  "property",
  "reversed",
  "round",
  "slice",
  "staticmethod",
  "vars",
  "BaseException",
  "Exception",
  "ArithmeticError",
  "AssertionError",
  "AttributeError",
  "ImportError",
  "IndexError",
  "KeyError",
  "LookupError",
  "NotImplementedError",
  "OSError",
  "RuntimeError",
  "StopIteration",
  "TypeError",
  "ValueError",
  "ZeroDivisionError",
];

const BUILTIN_NAMES: ReadonlySet<string> = new Set([...PYTHON_STOPLIST, ...OTHER_BUILTINS]);

/**
 * True for references that should not be reported as unresolved when nothing was found:
 * stoplisted names (builtin methods, any receiver) and bare builtin names such as `len(x)`
 * or `class E(Exception)`. Reporting them would only add noise to the resolution rate.
 */
export function isBuiltinNoise(name: string, hasReceiver: boolean): boolean {
  if (isStoplisted(name, PYTHON_STOPLIST)) return true;
  return !hasReceiver && BUILTIN_NAMES.has(name);
}
