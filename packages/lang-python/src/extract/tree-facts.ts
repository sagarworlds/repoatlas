import type { SyntaxNode, SyntaxTree } from "@repoatlas/treesitter";
import { inferReturnHint } from "../spec/receiver-type.ts";
import { collectTypeNames, type TypeName } from "./annotations.ts";

/** A def/class node found in the tree, with the facts the query cannot give us. */
export interface DefNodeFacts {
  name: string;
  startLine: number;
  startIndex: number;
  endIndex: number;
  isAsync: boolean;
  /** Decorator names as written, without `@` and call arguments: `app.route`. */
  decorators: string[];
  /** Parameter names of a function (empty for classes). */
  params: string[];
  /** The one class the function returns (annotation or agreeing return statements). */
  returns?: string;
}

/** Type names found in one annotation, with the offset of the annotation. */
export interface AnnotationFacts {
  startIndex: number;
  names: TypeName[];
}

export interface TreeFacts {
  defs: DefNodeFacts[];
  annotations: AnnotationFacts[];
}

function decoratorName(decorator: SyntaxNode): string | undefined {
  let expr = decorator.namedChildren.find((c) => c.type !== "comment");
  if (expr === undefined) return undefined;
  if (expr.type === "call") expr = expr.childForFieldName("function") ?? expr;
  return expr.text.replace(/\s+/g, "");
}

/** The identifier of a parameter node (`x`, `x: int`, `x=1`, `*args`, `**kw`), if any. */
function parameterName(param: SyntaxNode): string | undefined {
  switch (param.type) {
    case "identifier":
      return param.text;
    case "default_parameter":
    case "typed_default_parameter":
      return param.childForFieldName("name")?.text;
    case "typed_parameter":
    case "list_splat_pattern":
    case "dictionary_splat_pattern": {
      const inner = param.namedChildren.find((c) => c.type === "identifier");
      return inner?.text;
    }
    default:
      return undefined;
  }
}

function parameterNames(fn: SyntaxNode): string[] {
  const list = fn.childForFieldName("parameters");
  if (list === null) return [];
  return list.namedChildren.map(parameterName).filter((n): n is string => n !== undefined);
}

/** Iterative pre-order walk with a cursor (no recursion, so hostile nesting is safe). */
function walkNodeTypes(
  tree: SyntaxTree,
  wanted: ReadonlySet<string>,
  visit: (n: SyntaxNode) => void,
) {
  const cursor = tree.walk();
  try {
    let done = false;
    while (!done) {
      if (wanted.has(cursor.nodeType)) visit(cursor.currentNode);
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          done = true;
          break;
        }
      }
    }
  } finally {
    cursor.delete();
  }
}

const WANTED = new Set([
  "function_definition",
  "class_definition",
  "typed_parameter",
  "typed_default_parameter",
  "assignment",
]);

/** Collects def/class facts (decorators, async) and annotation type names in one pass. */
export function collectTreeFacts(tree: SyntaxTree): TreeFacts {
  const defs: DefNodeFacts[] = [];
  const annotations: AnnotationFacts[] = [];
  walkNodeTypes(tree, WANTED, (node) => {
    if (node.type === "function_definition" || node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name === undefined) return;
      const parent = node.parent;
      const decorators =
        parent !== null && parent.type === "decorated_definition"
          ? parent.namedChildren
              .filter((c) => c.type === "decorator")
              .map(decoratorName)
              .filter((n): n is string => n !== undefined)
          : [];
      const returns =
        node.type === "function_definition" ? inferReturnHint(node, tree.rootNode) : undefined;
      const fact: DefNodeFacts = {
        name,
        startLine: node.startPosition.row + 1,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        isAsync: node.children.some((c) => c.type === "async"),
        decorators,
        params: node.type === "function_definition" ? parameterNames(node) : [],
      };
      if (returns !== undefined) fact.returns = returns;
      defs.push(fact);
      const returnType = node.childForFieldName("return_type");
      if (returnType !== null) {
        annotations.push({
          startIndex: returnType.startIndex,
          names: collectTypeNames(returnType),
        });
      }
      return;
    }
    const type = node.childForFieldName("type");
    if (type === null) return;
    annotations.push({ startIndex: type.startIndex, names: collectTypeNames(type) });
  });
  return { defs, annotations };
}
