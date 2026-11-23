import type { SyntaxNode } from "@repoatlas/treesitter";
import { removeWhitespace, typeHint, typeKey } from "../extract/type-names.ts";

/**
 * Argument types of calls, for overload picking (docs/LANGUAGE_PLUGINS.md, Java). Each
 * argument becomes a `typeKey` string: a class name without generics, a primitive, `Foo[]`,
 * "null", "->" for lambdas and method references, or "?" when we cannot tell cheaply.
 * The types are file meta (`java.callArgs`) because a RawReference has no field for them.
 */

/** Finds the declared type of a local variable, parameter or field visible at a node. */
export type VariableTypeLookup = (use: SyntaxNode, name: string) => string | undefined;

const COMMENTS = new Set(["line_comment", "block_comment"]);

const NUMERIC_RANK: Record<string, number> = {
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
};

/** Constants of the box classes and Math: `Integer.MAX_VALUE` is an int, `Double.NaN` a double. */
const BOX_CONSTANTS: Record<string, string> = {
  Integer: "int",
  Long: "long",
  Short: "short",
  Byte: "byte",
  Double: "double",
  Float: "float",
  Math: "double",
};

function integerLiteralType(text: string): string {
  return /[lL]$/.test(text) ? "long" : "int";
}

function floatLiteralType(text: string): string {
  return /[fF]$/.test(text) && !/^0[xX]/.test(text) ? "float" : "double";
}

/** The wider of two numeric primitives (binary numeric promotion), or "?" for anything else. */
function promote(a: string, b: string): string {
  const ra = NUMERIC_RANK[a];
  const rb = NUMERIC_RANK[b];
  if (a === "char") return b === "char" ? "int" : promote("int", b);
  if (b === "char") return promote(a, "int");
  if (ra === undefined || rb === undefined) return "?";
  const wider = Math.max(ra, rb, NUMERIC_RANK.int as number);
  return Object.keys(NUMERIC_RANK).find((k) => NUMERIC_RANK[k] === wider) ?? "?";
}

function binaryType(node: SyntaxNode, lookup: VariableTypeLookup): string {
  const operator = node.childForFieldName("operator")?.text ?? "";
  if (["==", "!=", "<", ">", "<=", ">=", "&&", "||", "instanceof"].includes(operator)) {
    return "boolean";
  }
  const left = argType(node.childForFieldName("left"), lookup);
  const right = argType(node.childForFieldName("right"), lookup);
  if (operator === "+" && (left === "String" || right === "String")) return "String";
  if (["+", "-", "*", "/", "%"].includes(operator)) return promote(left, right);
  return "?";
}

function arrayCreationType(node: SyntaxNode): string {
  const element = typeKey(node.childForFieldName("type"));
  const dims = node.namedChildren.reduce((sum, c) => {
    if (c.type === "dimensions_expr") return sum + 1;
    if (c.type === "dimensions") return sum + c.text.split("[").length - 1;
    return sum;
  }, 0);
  return element + "[]".repeat(Math.max(dims, 1));
}

/** The type key of one argument expression ("?" when unknown). */
export function argType(node: SyntaxNode | null, lookup: VariableTypeLookup): string {
  if (node === null) return "?";
  switch (node.type) {
    case "string_literal":
      return "String";
    case "character_literal":
      return "char";
    case "true":
    case "false":
      return "boolean";
    case "null_literal":
      return "null";
    case "decimal_integer_literal":
    case "hex_integer_literal":
    case "octal_integer_literal":
    case "binary_integer_literal":
      return integerLiteralType(node.text);
    case "decimal_floating_point_literal":
    case "hex_floating_point_literal":
      return floatLiteralType(node.text);
    case "class_literal":
      return "Class";
    case "lambda_expression":
    case "method_reference":
      return "->";
    case "object_creation_expression":
      return typeKey(node.childForFieldName("type"));
    case "array_creation_expression":
      return arrayCreationType(node);
    case "cast_expression":
      return typeKey(node.childForFieldName("type"));
    case "parenthesized_expression":
      return argType(node.namedChildren[0] ?? null, lookup);
    case "unary_expression": {
      if (node.childForFieldName("operator")?.text === "!") return "boolean";
      const operand = argType(node.childForFieldName("operand"), lookup);
      return operand === "?" ? "?" : promote(operand, "int");
    }
    case "binary_expression":
      return binaryType(node, lookup);
    case "identifier":
      return lookup(node, node.text) ?? "?";
    case "field_access": {
      const object = node.childForFieldName("object");
      const field = node.childForFieldName("field");
      if (object?.type === "this" && field !== null) return lookup(node, field.text) ?? "?";
      // `Modifier.PUBLIC`: probably a constant of type Modifier (an enum constant); only a hint.
      if (object?.type === "identifier" && field !== null && /^[A-Z][A-Z0-9_]*$/.test(field.text)) {
        const isType = /^[A-Z]/.test(object.text) && lookup(node, object.text) === undefined;
        const primitive = BOX_CONSTANTS[object.text];
        if (isType && primitive !== undefined) return primitive;
        if (isType) return `~${object.text}`;
      }
      return "?";
    }
    case "ternary_expression": {
      const yes = argType(node.childForFieldName("consequence"), lookup);
      const no = argType(node.childForFieldName("alternative"), lookup);
      if (yes === no) return yes;
      if (yes === "null") return no === "?" || no in NUMERIC_RANK ? "?" : no;
      if (no === "null") return yes === "?" || yes in NUMERIC_RANK ? "?" : yes;
      return "?";
    }
    case "method_invocation": {
      // `x.toString()` is always a String; nothing else is known without types.
      const name = node.childForFieldName("name")?.text;
      const noArgs = (node.childForFieldName("arguments")?.namedChildCount ?? 1) === 0;
      return name === "toString" && noArgs ? "String" : "?";
    }
    default:
      return "?";
  }
}

/** Name and line of the callee of a call-like node, as the engine reports them. */
function calleeOf(node: SyntaxNode): { name: string; line: number } | undefined {
  if (node.type === "method_invocation") {
    const name = node.childForFieldName("name");
    return name === null ? undefined : { name: name.text, line: name.startPosition.row + 1 };
  }
  if (node.type === "explicit_constructor_invocation") {
    const keyword = node.childForFieldName("constructor");
    return keyword === null
      ? undefined
      : { name: keyword.text, line: keyword.startPosition.row + 1 };
  }
  if (node.type === "object_creation_expression") {
    const type = node.childForFieldName("type");
    const hint = typeHint(type);
    if (type === null || hint === undefined) return undefined;
    const name = removeWhitespace(hint).split(".").pop() ?? hint;
    return { name, line: type.startPosition.row + 1 };
  }
  return undefined;
}

/** Key shared by the extractor and the resolver: line, callee name and the n-th such call. */
export function callArgsKey(line: number, name: string, ordinal: number): string {
  return `${line}:${name}#${ordinal}`;
}

/**
 * Walks the whole tree once and returns the argument types of every call whose arguments we
 * know something about. The ordinal counts all calls with the same line and name, in
 * document order, whether or not they are listed.
 */
/** What the extractor knows about the calls of one file, keyed by `callArgsKey`. */
export interface CallFacts {
  /** Argument types (only calls where some argument type is known). */
  args: Record<string, string[]>;
  /**
   * For a call without receiver inside anonymous classes: the type names those classes
   * extend or implement, innermost first (`new AbstractModule() { ... bind(X) ... }`).
   */
  anonSupers: Record<string, string[]>;
  /** Names of classes, interfaces, enums and records declared inside method bodies, sorted. */
  localTypes: string[];
}

const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
]);
const MEMBER_CONTAINERS = new Set([
  "program",
  "class_body",
  "interface_body",
  "enum_body",
  "enum_body_declarations",
  "annotation_type_body",
]);

/** Super types of the anonymous classes around a node, innermost first (stops at a named class). */
function anonymousSupers(node: SyntaxNode): string[] {
  const supers: string[] = [];
  for (let p = node.parent; p !== null; p = p.parent) {
    if (p.type === "class_body") {
      const owner = p.parent;
      if (owner?.type !== "object_creation_expression") return supers;
      const hint = typeHint(owner.childForFieldName("type"));
      if (hint === undefined) return supers;
      supers.push(hint);
    }
  }
  return supers;
}

/**
 * Walks the whole tree once and returns the argument types of every call whose arguments we
 * know something about, and the anonymous-class context of unqualified calls. The ordinal in
 * the key counts all calls with the same line and name, in document order, whether or not
 * they are listed.
 */
export function collectCallFacts(root: SyntaxNode, lookup: VariableTypeLookup): CallFacts {
  const facts: CallFacts = { args: {}, anonSupers: {}, localTypes: [] };
  const localTypes = new Set<string>();
  const counts = new Map<string, number>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (
      TYPE_DECLARATIONS.has(node.type) &&
      !MEMBER_CONTAINERS.has(node.parent?.type ?? "program")
    ) {
      const name = node.childForFieldName("name");
      if (name !== null) localTypes.add(name.text);
    }
    const callee = calleeOf(node);
    const args = node.childForFieldName("arguments");
    if (callee !== undefined && args !== null) {
      const base = `${callee.line}:${callee.name}`;
      const ordinal = counts.get(base) ?? 0;
      counts.set(base, ordinal + 1);
      const key = callArgsKey(callee.line, callee.name, ordinal);
      const types = args.namedChildren
        .filter((c) => !COMMENTS.has(c.type))
        .map((c) => argType(c, lookup));
      if (types.some((t) => t !== "?")) facts.args[key] = types;
      if (node.type === "method_invocation" && node.childForFieldName("object") === null) {
        const supers = anonymousSupers(node);
        if (supers.length > 0) facts.anonSupers[key] = supers;
      }
    }
    // Reverse so that popping visits children in document order.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }
  facts.localTypes = [...localTypes].sort();
  return facts;
}
