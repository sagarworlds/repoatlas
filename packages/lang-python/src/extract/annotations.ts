import type { SyntaxNode } from "@repoatlas/treesitter";

/** A class name found inside a type annotation. */
export interface TypeName {
  /** Last segment: `User` for `models.User`. */
  name: string;
  /** Everything before the last dot: `models` for `models.User`. */
  receiver?: string;
  /** 1-based line of the name. */
  line: number;
}

// Built-in and `typing` names: they carry no information about the project's own classes,
// so they never become `type` references and never become a receiver type hint.
const SKIPPED = new Set([
  "int",
  "str",
  "float",
  "bool",
  "bytes",
  "bytearray",
  "complex",
  "list",
  "dict",
  "set",
  "frozenset",
  "tuple",
  "type",
  "object",
  "None",
  "Any",
  "Optional",
  "Union",
  "List",
  "Dict",
  "Set",
  "FrozenSet",
  "Tuple",
  "Type",
  "Callable",
  "Iterable",
  "Iterator",
  "Sequence",
  "Mapping",
  "MutableMapping",
  "MutableSequence",
  "MutableSet",
  "Awaitable",
  "Coroutine",
  "ClassVar",
  "Final",
  "Literal",
  "Annotated",
  "Generic",
  "Protocol",
  "TypeVar",
  "NoReturn",
  "Never",
  "Self",
  "AsyncIterator",
  "AsyncIterable",
  "Generator",
  "AsyncGenerator",
  "Collection",
  "Deque",
  "DefaultDict",
  "OrderedDict",
  "Counter",
  "Text",
  "TypeAlias",
  "LiteralString",
  "Required",
  "NotRequired",
  "TYPE_CHECKING",
]);

const IDENT_PATH = /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g;

export function isSkippedTypeName(name: string): boolean {
  return SKIPPED.has(name);
}

function splitDotted(text: string): { name: string; receiver?: string } {
  const i = text.lastIndexOf(".");
  return i < 0 ? { name: text } : { name: text.slice(i + 1), receiver: text.slice(0, i) };
}

function fromDotted(text: string, line: number): TypeName | undefined {
  const { name, receiver } = splitDotted(text);
  if (name === "" || SKIPPED.has(name)) return undefined;
  return receiver === undefined ? { name, line } : { name, receiver, line };
}

/** `base` of `Base[T]` is an identifier or attribute; returns its dotted text. */
function genericBase(node: SyntaxNode): string {
  const first = node.namedChildren[0];
  return first === undefined ? "" : first.text.replace(/\s+/g, "");
}

/**
 * All project-class candidates mentioned in a type annotation (`Optional[models.User]`
 * gives `models.User`; `Dict[str, Item]` gives `Item`). Handles `X | None`, string
 * annotations, `Literal[...]` (ignored) and `Annotated[X, ...]` (first argument only).
 * Iterative, so a hostile deeply nested annotation cannot overflow the stack.
 */
export function collectTypeNames(typeNode: SyntaxNode): TypeName[] {
  const out: TypeName[] = [];
  const stack: SyntaxNode[] = [typeNode];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    const line = node.startPosition.row + 1;
    switch (node.type) {
      case "identifier":
      case "attribute": {
        const ref = fromDotted(node.text.replace(/\s+/g, ""), line);
        if (ref !== undefined) out.push(ref);
        break;
      }
      case "string": {
        const content = node.namedChildren.find((c) => c.type === "string_content");
        for (const token of content?.text.match(IDENT_PATH) ?? []) {
          const ref = fromDotted(token, line);
          if (ref !== undefined) out.push(ref);
        }
        break;
      }
      case "generic_type":
      case "subscript": {
        const base =
          node.type === "subscript"
            ? (node.childForFieldName("value")?.text ?? "").replace(/\s+/g, "")
            : genericBase(node);
        const baseName = splitDotted(base).name;
        if (baseName === "Literal") break;
        const children = node.namedChildren;
        const first = children[0];
        if (first !== undefined) {
          const baseRef = fromDotted(base, line);
          if (baseRef !== undefined) out.push(baseRef);
        }
        const args = children.slice(1);
        const used = baseName === "Annotated" ? args.slice(0, 1) : args;
        // Reverse push keeps document order when popping.
        for (let i = used.length - 1; i >= 0; i--) stack.push(used[i] as SyntaxNode);
        break;
      }
      default: {
        // type, type_parameter, binary_operator, list, tuple, union_type...: look inside.
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as SyntaxNode);
      }
    }
  }
  return out;
}

function simpleName(text: string): string | undefined {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(clean)) return undefined;
  return SKIPPED.has(splitDotted(clean).name) ? undefined : clean;
}

/**
 * The one class an annotation says a value has, or undefined. `User`, `"User"`,
 * `Optional[User]`, `User | None` and `Union[User, None]` give "User"; `list[User]`,
 * `int` and `A | B` give undefined.
 */
export function annotationToTypeHint(typeNode: SyntaxNode): string | undefined {
  switch (typeNode.type) {
    case "type":
    case "parenthesized_expression":
      return typeNode.namedChildren.length === 1
        ? annotationToTypeHint(typeNode.namedChildren[0] as SyntaxNode)
        : undefined;
    case "identifier":
    case "attribute":
      return simpleName(typeNode.text);
    case "string": {
      const content = typeNode.namedChildren.find((c) => c.type === "string_content");
      return content === undefined ? undefined : simpleName(content.text);
    }
    case "generic_type":
    case "subscript": {
      const base =
        typeNode.type === "subscript"
          ? (typeNode.childForFieldName("value")?.text ?? "")
          : genericBase(typeNode);
      const baseName = splitDotted(base.replace(/\s+/g, "")).name;
      const args = typeNode.namedChildren
        .slice(1)
        .flatMap((c) => (c.type === "type_parameter" ? c.namedChildren : [c]))
        .filter((c) => c.type !== "none" && c.text !== "None");
      const only = args.length === 1 ? args[0] : undefined;
      if (only === undefined) return undefined;
      if (baseName === "Optional" || baseName === "Union" || baseName === "Annotated") {
        return annotationToTypeHint(only);
      }
      return undefined;
    }
    case "binary_operator": {
      const sides = [typeNode.childForFieldName("left"), typeNode.childForFieldName("right")]
        .filter((n): n is SyntaxNode => n !== null)
        .filter((n) => n.type !== "none");
      return sides.length === 1 ? annotationToTypeHint(sides[0] as SyntaxNode) : undefined;
    }
    default:
      return undefined;
  }
}
