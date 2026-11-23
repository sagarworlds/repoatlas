import type { SyntaxNode } from "@repoatlas/treesitter";
import { removeWhitespace, typeKey } from "./type-names.ts";

export type TypeKind = "class" | "interface" | "enum" | "record" | "annotation";

/** Plain data about one definition node (no node references survive the tree). */
export interface JavaDefFacts {
  name: string;
  startLine: number;
  startIndex: number;
  endIndex: number;
  /** tree-sitter node type, e.g. "method_declaration". */
  nodeType: string;
  /** Set for type declarations. */
  typeKind: TypeKind | undefined;
  modifiers: string[];
  /** Annotation names as written, without `@` and arguments: ["Override", "a.Foo"]. */
  annotations: string[];
  /** The type that directly contains this definition (undefined at file level). */
  container: TypeKind | undefined;
  isConstructor: boolean;
  /** Parameter count of methods and constructors. */
  paramCount: number | undefined;
  varargs: boolean;
  /** Declared parameter types as `typeKey` strings (generics removed, `?` = unknown). */
  paramTypes: string[];
  /** Declared return type of a method as a `typeKey` string; undefined for other definitions. */
  returns: string | undefined;
  hasBody: boolean;
  /** Fields of a type declaration whose type is a class type: name -> `typeKey` (max 200). */
  fields: Record<string, string>;
  /** Name of the nearest enclosing top-level or nested type (itself for a type). */
  typeName: string | undefined;
}

export interface JavaFileFacts {
  packageName: string | undefined;
  defs: JavaDefFacts[];
}

const TYPE_KINDS: Record<string, TypeKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

/** Which method-like members each kind of type may declare (mirrors queries/definitions.scm). */
const MEMBER_TYPES: Record<TypeKind, string[]> = {
  class: ["method_declaration", "constructor_declaration"],
  record: ["method_declaration", "constructor_declaration", "compact_constructor_declaration"],
  interface: ["method_declaration"],
  enum: ["method_declaration", "constructor_declaration"],
  annotation: [],
};

function modifiersOf(node: SyntaxNode): { keywords: string[]; annotations: string[] } {
  const keywords: string[] = [];
  const annotations: string[] = [];
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  for (const child of modifiers?.children ?? []) {
    if (child.type === "marker_annotation" || child.type === "annotation") {
      const name = child.childForFieldName("name");
      if (name !== null) annotations.push(removeWhitespace(name.text));
    } else if (!child.isNamed) {
      keywords.push(child.text);
    }
  }
  return { keywords, annotations };
}

/** Members of a type body (the enum body keeps its members after the constants). */
function bodyMembers(type: SyntaxNode): SyntaxNode[] {
  const body = type.childForFieldName("body");
  if (body === null) return [];
  if (body.type === "enum_body") {
    return body.namedChildren.find((c) => c.type === "enum_body_declarations")?.namedChildren ?? [];
  }
  return body.namedChildren;
}

interface ParameterFacts {
  count: number;
  varargs: boolean;
  types: string[];
}

function countParameters(params: SyntaxNode | null): ParameterFacts {
  let count = 0;
  let varargs = false;
  const types: string[] = [];
  for (const p of params?.namedChildren ?? []) {
    if (p.type === "formal_parameter") {
      count++;
      const dims = p.childForFieldName("dimensions");
      const base = typeKey(p.childForFieldName("type"));
      types.push(dims === null ? base : base + "[]".repeat(dims.text.split("[").length - 1));
    } else if (p.type === "spread_parameter") {
      count++;
      varargs = true;
      const typeNode = p.namedChildren.find(
        (c) => c.type !== "modifiers" && c.type !== "variable_declarator",
      );
      types.push(`${typeKey(typeNode ?? null)}[]`);
    }
  }
  return { count, varargs, types };
}

const PRIMITIVE_KEYS: ReadonlySet<string> = new Set([
  "byte",
  "short",
  "int",
  "long",
  "float",
  "double",
  "boolean",
  "char",
]);
const MAX_FIELDS = 200;

/** Class-typed fields of a type declaration (arrays, primitives and unknown types are skipped). */
function fieldsOf(type: SyntaxNode): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const member of bodyMembers(type)) {
    if (member.type !== "field_declaration" || count >= MAX_FIELDS) continue;
    const key = typeKey(member.childForFieldName("type"));
    if (key === "?" || key.endsWith("]") || PRIMITIVE_KEYS.has(key)) continue;
    for (const declarator of member.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const name = declarator.childForFieldName("name");
      if (name !== null && count < MAX_FIELDS) {
        out[name.text] = key;
        count++;
      }
    }
  }
  return out;
}

function factsFor(
  node: SyntaxNode,
  name: string,
  container: TypeKind | undefined,
  typeName: string | undefined,
  recordParams: ParameterFacts | undefined,
): JavaDefFacts {
  const typeKind = TYPE_KINDS[node.type];
  const { keywords, annotations } = modifiersOf(node);
  const isMethodLike = typeKind === undefined;
  let params: ParameterFacts | undefined;
  if (node.type === "compact_constructor_declaration") params = recordParams;
  else if (isMethodLike) params = countParameters(node.childForFieldName("parameters"));
  return {
    name,
    startLine: node.startPosition.row + 1,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    nodeType: node.type,
    typeKind,
    modifiers: keywords,
    annotations,
    container,
    isConstructor:
      node.type === "constructor_declaration" || node.type === "compact_constructor_declaration",
    paramCount: params?.count,
    varargs: params?.varargs ?? false,
    paramTypes: params?.types ?? [],
    returns:
      node.type === "method_declaration" ? typeKey(node.childForFieldName("type")) : undefined,
    hasBody: node.childForFieldName("body") !== null,
    fields: typeKind === undefined ? {} : fieldsOf(node),
    typeName: typeKind === undefined ? typeName : name,
  };
}

/** `package a.b;` gives "a.b" (annotations on the package are skipped). */
function packageOf(root: SyntaxNode): string | undefined {
  const decl = root.namedChildren.find((c) => c.type === "package_declaration");
  const name = decl?.namedChildren.find(
    (c) => c.type === "scoped_identifier" || c.type === "identifier",
  );
  return name === undefined ? undefined : removeWhitespace(name.text);
}

/**
 * Walks only the declaration structure (types and their methods/constructors, never method
 * bodies), which is exactly where definitions.scm finds definitions. Output is in document
 * order, parents before children, like the engine's definitions.
 */
export function collectJavaFacts(root: SyntaxNode): JavaFileFacts {
  const defs: JavaDefFacts[] = [];
  // Explicit stack instead of recursion: member nesting is shallow, but this is cheap safety.
  interface Frame {
    members: SyntaxNode[];
    container: TypeKind | undefined;
    typeName: string | undefined;
    recordParams: ParameterFacts | undefined;
    next: number;
  }
  const stack: Frame[] = [
    {
      members: root.namedChildren,
      container: undefined,
      typeName: undefined,
      recordParams: undefined,
      next: 0,
    },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    const member = frame.members[frame.next++];
    if (member === undefined) {
      stack.pop();
      continue;
    }
    const nameNode = member.childForFieldName("name");
    if (nameNode === null) continue;
    const typeKind = TYPE_KINDS[member.type];
    if (typeKind !== undefined) {
      defs.push(factsFor(member, nameNode.text, frame.container, frame.typeName, undefined));
      stack.push({
        members: bodyMembers(member),
        container: typeKind,
        typeName: nameNode.text,
        recordParams:
          typeKind === "record"
            ? countParameters(member.childForFieldName("parameters"))
            : undefined,
        next: 0,
      });
      continue;
    }
    const allowed = frame.container === undefined ? [] : MEMBER_TYPES[frame.container];
    if (allowed.includes(member.type)) {
      defs.push(
        factsFor(member, nameNode.text, frame.container, frame.typeName, frame.recordParams),
      );
    }
  }
  return { packageName: packageOf(root), defs };
}
