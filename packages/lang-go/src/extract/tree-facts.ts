import type { SyntaxNode, SyntaxTree } from "@repoatlas/treesitter";
import { PREDECLARED_TYPES } from "../spec/predeclared.ts";
import { typeNodeHint } from "../spec/receiver-type.ts";

export type GoTypeKind = "struct" | "interface" | "alias";

/** What the syntax tree says about one top-level declaration. */
export interface DeclFacts {
  /** Same pairing key as the engine definition: `${startLine}:${name}`. */
  key: string;
  name: string;
  kind: "function" | "method" | "type";
  /** Receiver base type of a method, pointer star and generics stripped. */
  receiverType: string | undefined;
  /** Receiver variable name (`s` in `func (s *Server) Start()`), when it has one. */
  receiverVar: string | undefined;
  typeKind: GoTypeKind | undefined;
  /** Method names of an interface type, in source order. */
  interfaceMethods: string[];
  /**
   * Struct fields whose type is a single named type: field name -> `Name` or `pkg.Name`.
   * Embedded fields are listed under their type name. Empty for everything but structs.
   */
  fields: Record<string, string>;
  /** Names of type parameters in scope of this declaration (incl. receiver generics). */
  typeParams: Set<string>;
  /** Types declared inside the body of this function (not definitions). */
  localTypes: Set<string>;
}

/** A type used somewhere (parameter, result, field, var type, ...). */
export interface TypeUse {
  line: number;
  name: string;
  receiver: string | undefined;
  /** The declaration that contains the use, or undefined at package level. */
  owner: DeclFacts | undefined;
}

export interface GoTreeFacts {
  packageName: string | undefined;
  isGenerated: boolean;
  decls: DeclFacts[];
  typeUses: TypeUse[];
}

const GENERATED = /^\/\/ Code generated .* DO NOT EDIT\.$/m;

/** Strips `*`, parentheses and generic arguments from a receiver type node. */
function receiverBase(type: SyntaxNode | null): string | undefined {
  let current = type;
  while (current !== null) {
    if (current.type === "type_identifier") return current.text;
    if (current.type === "pointer_type" || current.type === "parenthesized_type") {
      current = current.namedChildren.find((c) => c.type !== "comment") ?? null;
    } else if (current.type === "generic_type") {
      current = current.childForFieldName("type");
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** First parameter of a method receiver list: its variable name and base type. */
function receiverInfo(method: SyntaxNode): {
  type: string | undefined;
  variable: string | undefined;
  typeParams: string[];
} {
  const list = method.childForFieldName("receiver");
  const param = list?.namedChildren.find((c) => c.type === "parameter_declaration");
  if (param === undefined) return { type: undefined, variable: undefined, typeParams: [] };
  const typeNode = param.childForFieldName("type");
  const variable = param.childForFieldName("name")?.text;
  const typeParams: string[] = [];
  let inner = typeNode;
  while (inner !== null && inner.type === "pointer_type") inner = inner.namedChildren[0] ?? null;
  if (inner !== null && inner.type === "generic_type") {
    const args = inner.childForFieldName("type_arguments");
    for (const elem of args?.namedChildren ?? []) {
      const id = elem.type === "type_elem" ? elem.namedChildren[0] : elem;
      if (id !== undefined && id.type === "type_identifier") typeParams.push(id.text);
    }
  }
  return {
    type: receiverBase(typeNode),
    variable: variable === "_" ? undefined : variable,
    typeParams,
  };
}

function declaredTypeParams(node: SyntaxNode): string[] {
  const list = node.childForFieldName("type_parameters");
  if (list === null) return [];
  const names: string[] = [];
  for (const decl of list.namedChildren) {
    for (const n of decl.childrenForFieldName("name")) names.push(n.text);
  }
  return names;
}

function interfaceMethodNames(type: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of type.namedChildren) {
    if (child.type !== "method_elem") continue;
    const name = child.childForFieldName("name");
    if (name !== null) names.push(name.text);
  }
  return names;
}

const MAX_FIELDS_PER_STRUCT = 200;

function structFieldTypes(struct: SyntaxNode): Record<string, string> {
  const fields: Record<string, string> = {};
  const list = struct.namedChildren.find((c) => c.type === "field_declaration_list");
  let count = 0;
  for (const decl of list?.namedChildren ?? []) {
    if (decl.type !== "field_declaration" || count >= MAX_FIELDS_PER_STRUCT) continue;
    const typeText = typeNodeHint(decl.childForFieldName("type"));
    if (typeText === undefined) continue;
    const names = decl.childrenForFieldName("name").map((n) => n.text);
    // An embedded field is named after its type: `*pkg.Base` -> Base.
    if (names.length === 0) names.push(typeText.slice(typeText.lastIndexOf(".") + 1));
    for (const name of names) {
      fields[name] = typeText;
      count++;
    }
  }
  return fields;
}

function declFacts(node: SyntaxNode): DeclFacts | undefined {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null || nameNode.text === "") return undefined;
  const name = nameNode.text;
  const facts: DeclFacts = {
    key: `${node.startPosition.row + 1}:${name}`,
    name,
    kind: "function",
    receiverType: undefined,
    receiverVar: undefined,
    typeKind: undefined,
    interfaceMethods: [],
    fields: {},
    typeParams: new Set(declaredTypeParams(node)),
    localTypes: new Set(),
  };
  if (node.type === "method_declaration") {
    facts.kind = "method";
    const info = receiverInfo(node);
    facts.receiverType = info.type;
    facts.receiverVar = info.variable;
    for (const p of info.typeParams) facts.typeParams.add(p);
  }
  if (node.type === "type_spec" || node.type === "type_alias") {
    facts.kind = "type";
    const type = node.childForFieldName("type");
    if (type?.type === "struct_type") {
      facts.typeKind = "struct";
      facts.fields = structFieldTypes(type);
    } else if (type?.type === "interface_type") {
      facts.typeKind = "interface";
      facts.interfaceMethods = interfaceMethodNames(type);
    } else facts.typeKind = "alias";
  }
  if (node.type === "function_declaration" || node.type === "method_declaration") {
    for (const t of node.descendantsOfType(["type_spec", "type_alias"])) {
      const n = t.childForFieldName("name");
      if (n !== null) facts.localTypes.add(n.text);
    }
  }
  return facts;
}

const NAMED_TYPE_NODES = new Set(["type_identifier", "qualified_type"]);

/**
 * The children the type walk visits. Nodes whose type names are NOT type uses are left out:
 * declaration names, method receivers, embedded fields and single-name interface elements
 * (those are `extends` references), composite-literal types and `new(T)` (those are
 * `instantiate` references), and the generic function name in `Map[int](x)` (a call).
 */
function childrenToVisit(node: SyntaxNode): SyntaxNode[] {
  const all = node.namedChildren;
  switch (node.type) {
    case "type_spec":
    case "type_alias": {
      const name = node.childForFieldName("name");
      return all.filter((c) => c.id !== name?.id);
    }
    case "method_declaration": {
      const receiver = node.childForFieldName("receiver");
      return all.filter((c) => c.id !== receiver?.id);
    }
    case "field_declaration": {
      if (node.childForFieldName("name") !== null) return all;
      return embeddedFieldChildren(node);
    }
    case "type_elem": {
      const isInterfaceElem = node.parent?.type === "interface_type";
      const only = all.length === 1 ? all[0] : undefined;
      if (isInterfaceElem && only !== undefined && NAMED_TYPE_NODES.has(only.type)) return [];
      return all;
    }
    case "composite_literal": {
      const type = node.childForFieldName("type");
      if (type === null) return all;
      if (NAMED_TYPE_NODES.has(type.type)) return all.filter((c) => c.id !== type.id);
      return all.flatMap((c) => (c.id === type.id ? genericArgumentsOf(c) : [c]));
    }
    case "type_conversion_expression": {
      const type = node.childForFieldName("type");
      if (type === null || type.type !== "generic_type") return all;
      return all.flatMap((c) => (c.id === type.id ? genericArgumentsOf(c) : [c]));
    }
    case "call_expression": {
      const fn = node.childForFieldName("function");
      if (fn === null || fn.type !== "identifier" || fn.text !== "new") return all;
      const args = node.childForFieldName("arguments");
      const first = args?.namedChildren[0];
      if (args === null || first === undefined || !NAMED_TYPE_NODES.has(first.type)) return all;
      // Keep the call's other children, but replace the argument list by its other arguments.
      return all.flatMap((c) => (c.id === args.id ? args.namedChildren.slice(1) : [c]));
    }
    default:
      return all;
  }
}

/** For `Base[Foo]` only the type arguments (the base name is reported by a query). */
function genericArgumentsOf(node: SyntaxNode): SyntaxNode[] {
  if (node.type !== "generic_type") return [node];
  const args = node.childForFieldName("type_arguments");
  return args === null ? [] : [args];
}

function embeddedFieldChildren(field: SyntaxNode): SyntaxNode[] {
  const type = field.childForFieldName("type");
  if (type === null) return field.namedChildren;
  let inner: SyntaxNode | null = type;
  if (inner.type === "pointer_type") inner = inner.namedChildren[0] ?? null;
  if (inner === null) return [];
  if (NAMED_TYPE_NODES.has(inner.type)) return [];
  if (inner.type === "generic_type") return genericArgumentsOf(inner);
  return field.namedChildren;
}

/** Visits a declaration (or a package-level statement) and records every type use. */
function collectTypeUses(root: SyntaxNode, owner: DeclFacts | undefined, out: TypeUse[]): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (node.type === "type_identifier") {
      record(out, owner, node.startPosition.row + 1, node.text, undefined);
      continue;
    }
    if (node.type === "qualified_type") {
      const pkg = node.childForFieldName("package")?.text;
      const name = node.childForFieldName("name");
      if (name !== null) record(out, owner, name.startPosition.row + 1, name.text, pkg);
      continue;
    }
    const children = childrenToVisit(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as SyntaxNode);
  }
}

function record(
  out: TypeUse[],
  owner: DeclFacts | undefined,
  line: number,
  name: string,
  receiver: string | undefined,
): void {
  if (receiver === undefined) {
    if (PREDECLARED_TYPES.has(name)) return;
    if (owner?.typeParams.has(name) === true || owner?.localTypes.has(name) === true) return;
  }
  out.push({ line, name, receiver, owner });
}

/** Everything postProcess needs from the tree, gathered in one pass over the top level. */
export function collectGoFacts(tree: SyntaxTree): GoTreeFacts {
  const root = tree.rootNode;
  const facts: GoTreeFacts = {
    packageName: undefined,
    isGenerated: false,
    decls: [],
    typeUses: [],
  };
  for (const child of root.namedChildren) {
    switch (child.type) {
      case "comment":
        if (facts.packageName === undefined && GENERATED.test(child.text)) facts.isGenerated = true;
        break;
      case "package_clause":
        facts.packageName = child.namedChildren.find((c) => c.type === "package_identifier")?.text;
        break;
      case "import_declaration":
        break;
      case "function_declaration":
      case "method_declaration": {
        const decl = declFacts(child);
        if (decl !== undefined) facts.decls.push(decl);
        collectTypeUses(child, decl, facts.typeUses);
        break;
      }
      case "type_declaration":
        for (const spec of child.namedChildren) {
          if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
          const decl = declFacts(spec);
          if (decl !== undefined) facts.decls.push(decl);
          collectTypeUses(spec, decl, facts.typeUses);
        }
        break;
      default:
        collectTypeUses(child, undefined, facts.typeUses);
    }
  }
  return facts;
}
