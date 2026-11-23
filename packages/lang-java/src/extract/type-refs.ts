import type { SyntaxNode } from "@repoatlas/treesitter";
import { isSkippedAnnotation, isSkippedTypeName, splitQualified } from "./type-names.ts";

/** A `type` reference found in the tree, before it is attached to its enclosing definition. */
export interface TypeRefDraft {
  line: number;
  startIndex: number;
  name: string;
  receiver?: string;
}

/** Declarations whose `type_parameters` are visible inside them. */
const GENERIC_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "record_declaration",
  "method_declaration",
  "constructor_declaration",
]);

const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

function typeParameterNames(declaration: SyntaxNode): string[] {
  const list = declaration.childForFieldName("type_parameters");
  const names: string[] = [];
  for (const p of list?.namedChildren ?? []) {
    const first =
      p.type === "type_parameter"
        ? p.namedChildren.find((c) => c.type === "type_identifier")
        : undefined;
    if (first !== undefined) names.push(first.text);
  }
  return names;
}

/**
 * True when the engine already emits this type as extends/implements/instantiate: the head of
 * a superclass, a super-interface list entry, an extended interface, or `new Foo()`.
 * Type arguments of such a type are not heads, so they still get a `type` reference.
 */
function isEngineHead(node: SyntaxNode): boolean {
  let current = node;
  let parent = current.parent;
  if (parent?.type === "generic_type" && parent.namedChild(0)?.id === current.id) {
    current = parent;
    parent = current.parent;
  }
  if (parent === null) return false;
  if (parent.type === "superclass") return true;
  if (parent.type === "type_list") {
    const owner = parent.parent?.type;
    return owner === "super_interfaces" || owner === "extends_interfaces";
  }
  if (parent.type === "object_creation_expression") {
    return parent.childForFieldName("type")?.id === current.id;
  }
  return false;
}

function lastNamedChild(node: SyntaxNode): SyntaxNode {
  return node.namedChild(node.namedChildCount - 1) ?? node;
}

/**
 * Finds every `type` reference in the file: field, parameter, return, local variable and
 * generic-argument types, throws, casts, instanceof, catch parameters, class literals and
 * annotations. Names of java.lang types, `var` and type parameters in scope (`T`) are
 * skipped. Heads that the engine reports as extends/implements/instantiate are skipped too.
 * Iterative (explicit stack) so deeply nested expressions cannot overflow the call stack.
 */
export function collectTypeRefs(root: SyntaxNode): TypeRefDraft[] {
  const found: TypeRefDraft[] = [];
  const stack: { node: SyntaxNode; scope: ReadonlySet<string> }[] = [
    { node: root, scope: EMPTY_NAMES },
  ];
  while (stack.length > 0) {
    const { node, scope } = stack.pop() as { node: SyntaxNode; scope: ReadonlySet<string> };
    switch (node.type) {
      case "type_identifier":
        if (!scope.has(node.text) && !isSkippedTypeName(node.text) && !isEngineHead(node)) {
          found.push({
            line: node.startPosition.row + 1,
            startIndex: node.startIndex,
            name: node.text,
          });
        }
        continue;
      case "scoped_type_identifier": {
        // `a.b.Foo` and `Map.Entry`: one reference, never descend into the qualifier.
        if (isEngineHead(node)) continue;
        const parts = splitQualified(node.text);
        if (parts.receiver === undefined) continue;
        const last = lastNamedChild(node);
        const draft: TypeRefDraft = {
          line: last.startPosition.row + 1,
          startIndex: node.startIndex,
          name: parts.name,
          receiver: parts.receiver,
        };
        found.push(draft);
        continue;
      }
      case "marker_annotation":
      case "annotation": {
        const nameNode = node.childForFieldName("name");
        if (nameNode !== null) {
          const parts = splitQualified(nameNode.text);
          if (parts.receiver !== undefined || !isSkippedAnnotation(parts.name)) {
            const draft: TypeRefDraft = {
              line: nameNode.startPosition.row + 1,
              startIndex: node.startIndex,
              name: parts.name,
            };
            if (parts.receiver !== undefined) draft.receiver = parts.receiver;
            found.push(draft);
          }
        }
        const args = node.childForFieldName("arguments");
        if (args !== null) stack.push({ node: args, scope });
        continue;
      }
      case "type_parameter": {
        // The first type_identifier is the declared name `T`, not a use; the bounds follow.
        const children = node.namedChildren;
        const nameIndex = children.findIndex((c) => c.type === "type_identifier");
        children.forEach((c, i) => {
          if (i !== nameIndex) stack.push({ node: c, scope });
        });
        continue;
      }
      default:
        break;
    }
    let childScope = scope;
    if (GENERIC_DECLARATIONS.has(node.type)) {
      const names = typeParameterNames(node);
      if (names.length > 0) childScope = new Set([...scope, ...names]);
    }
    for (const child of node.namedChildren) stack.push({ node: child, scope: childScope });
  }
  return found.sort((a, b) => a.startIndex - b.startIndex);
}
