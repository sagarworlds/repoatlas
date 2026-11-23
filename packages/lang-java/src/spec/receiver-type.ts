import type { ReceiverTypeContext, SyntaxNode } from "@repoatlas/treesitter";
import { isVarType, removeWhitespace, typeHint, typeKey } from "../extract/type-names.ts";

/**
 * Receiver type hints (docs/LANGUAGE_PLUGINS.md, receiverTypeHint). For `repo.save()` we
 * look for the declaration of `repo` by walking up the syntax tree: locals and parameters of
 * the enclosing blocks, methods and lambdas, then the fields of the enclosing classes. The
 * nearest declaration wins, even when it tells us nothing (`var x = foo()`, arrays), so a
 * shadowing local hides a field of the same name.
 */

interface Binding {
  hint: string | undefined;
  /** `typeKey` of the declared type (primitives and arrays included), "?" when unknown. */
  full: string;
  /** Offset of the declaration. Fields and parameters use -1: visible everywhere in scope. */
  startIndex: number;
}

type BindingTable = Map<string, Binding[]>;

function addBinding(
  table: BindingTable,
  name: string,
  hint: string | undefined,
  startIndex: number,
  full: string = hint ?? "?",
): void {
  const list = table.get(name);
  if (list === undefined) table.set(name, [{ hint, full, startIndex }]);
  else list.push({ hint, full, startIndex });
}

/** `typeKey` of a declared type followed by extra array dimensions (`int x[]`). */
function fullType(type: SyntaxNode | null, dimensions: SyntaxNode | null): string {
  const base = typeKey(type);
  return dimensions === null ? base : base + "[]".repeat(dimensions.text.split("[").length - 1);
}

/** `new Foo(...)`, `(Foo) x` and parenthesised forms: the class an expression obviously has. */
function expressionHint(value: SyntaxNode | null): string | undefined {
  if (value === null) return undefined;
  switch (value.type) {
    case "object_creation_expression":
    case "cast_expression":
      return typeHint(value.childForFieldName("type"));
    case "parenthesized_expression":
      return expressionHint(value.namedChildren[0] ?? null);
    default:
      return undefined;
  }
}

/** Adds the declarators of a local variable, field or constant declaration. */
function addDeclaration(table: BindingTable, declaration: SyntaxNode, positional: boolean): void {
  const type = declaration.childForFieldName("type");
  for (const declarator of declaration.childrenForFieldName("declarator")) {
    const name = declarator.childForFieldName("name");
    if (name === null) continue;
    let hint: string | undefined;
    const dimensions = declarator.childForFieldName("dimensions");
    if (dimensions !== null)
      hint = undefined; // an array
    else if (isVarType(type)) hint = expressionHint(declarator.childForFieldName("value"));
    else hint = typeHint(type);
    const full = isVarType(type) ? (hint ?? "?") : fullType(type, dimensions);
    addBinding(table, name.text, hint, positional ? declarator.startIndex : -1, full);
  }
}

function addFormalParameters(table: BindingTable, params: SyntaxNode | null): void {
  if (params === null) return;
  if (params.type === "identifier") {
    addBinding(table, params.text, undefined, -1); // lambda: x -> ...
    return;
  }
  for (const p of params.namedChildren) {
    if (p.type === "identifier") {
      addBinding(table, p.text, undefined, -1); // inferred lambda parameter
    } else if (p.type === "formal_parameter") {
      const name = p.childForFieldName("name");
      if (name === null) continue;
      const dimensions = p.childForFieldName("dimensions");
      const type = p.childForFieldName("type");
      addBinding(
        table,
        name.text,
        dimensions !== null ? undefined : typeHint(type),
        -1,
        fullType(type, dimensions),
      );
    } else if (p.type === "spread_parameter") {
      const declarator = p.namedChildren.find((c) => c.type === "variable_declarator");
      const name = declarator?.childForFieldName("name");
      if (name !== undefined && name !== null) addBinding(table, name.text, undefined, -1);
    }
  }
}

/** Names bound by `x instanceof Foo f` inside a condition (not looking into lambdas). */
function addInstanceofPatterns(table: BindingTable, condition: SyntaxNode | null): void {
  if (condition === null) return;
  const stack: SyntaxNode[] = [condition];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (node.type === "lambda_expression") continue;
    if (node.type === "instanceof_expression") {
      const name = node.childForFieldName("name");
      if (name !== null) {
        addBinding(table, name.text, typeHint(node.childForFieldName("right")), node.startIndex);
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
}

/** The names one syntax node declares for the code inside it, or undefined when it is no scope. */
function buildTable(scope: SyntaxNode): BindingTable | undefined {
  const table: BindingTable = new Map();
  switch (scope.type) {
    case "block":
    case "constructor_body":
      for (const c of scope.namedChildren) {
        if (c.type === "local_variable_declaration") addDeclaration(table, c, true);
      }
      return table;
    case "switch_block":
      for (const group of scope.namedChildren) {
        if (group.type !== "switch_block_statement_group") continue;
        for (const c of group.namedChildren) {
          if (c.type === "local_variable_declaration") addDeclaration(table, c, true);
        }
      }
      return table;
    case "for_statement":
      for (const init of scope.childrenForFieldName("init")) {
        if (init.type === "local_variable_declaration") addDeclaration(table, init, true);
      }
      return table;
    case "enhanced_for_statement": {
      const name = scope.childForFieldName("name");
      const type = scope.childForFieldName("type");
      if (name !== null) {
        const dimensions = scope.childForFieldName("dimensions");
        const hint = dimensions !== null || isVarType(type) ? undefined : typeHint(type);
        addBinding(table, name.text, hint, -1, isVarType(type) ? "?" : fullType(type, dimensions));
      }
      return table;
    }
    case "catch_clause": {
      const param = scope.namedChildren.find((c) => c.type === "catch_formal_parameter");
      const name = param?.childForFieldName("name");
      if (param !== undefined && name !== undefined && name !== null) {
        const catchType = param.namedChildren.find((c) => c.type === "catch_type");
        const types = catchType?.namedChildren ?? [];
        const only = types.length === 1 ? types[0] : undefined;
        addBinding(table, name.text, only === undefined ? undefined : typeHint(only), -1);
      }
      return table;
    }
    case "try_with_resources_statement": {
      const resources = scope.childForFieldName("resources");
      for (const r of resources?.namedChildren ?? []) {
        const name = r.childForFieldName("name");
        if (r.type !== "resource" || name === null) continue;
        const type = r.childForFieldName("type");
        const hint = isVarType(type)
          ? expressionHint(r.childForFieldName("value"))
          : typeHint(type);
        addBinding(table, name.text, hint, -1);
      }
      return table;
    }
    case "method_declaration":
    case "constructor_declaration":
    case "lambda_expression":
      addFormalParameters(table, scope.childForFieldName("parameters"));
      return table;
    case "if_statement":
    case "while_statement":
    case "ternary_expression":
      addInstanceofPatterns(table, scope.childForFieldName("condition"));
      return table;
    case "binary_expression":
      addInstanceofPatterns(table, scope.childForFieldName("left"));
      return table;
    case "class_body":
    case "interface_body":
    case "enum_body_declarations":
      for (const c of scope.namedChildren) {
        if (c.type === "field_declaration" || c.type === "constant_declaration") {
          addDeclaration(table, c, false);
        }
      }
      if (scope.parent?.type === "record_declaration") {
        addFormalParameters(table, scope.parent.childForFieldName("parameters"));
      }
      return table;
    default:
      return undefined;
  }
}

// WeakMap keyed by the syntax tree (like C# ConditionalWeakTable): a freed tree frees its tables.
// The value maps a scope node id to its table (null: the node type is not a scope).
const tablesByTree = new WeakMap<object, Map<number, BindingTable | null>>();

function tableFor(scope: SyntaxNode): BindingTable | undefined {
  let tables = tablesByTree.get(scope.tree);
  if (tables === undefined) {
    tables = new Map();
    tablesByTree.set(scope.tree, tables);
  }
  const cached = tables.get(scope.id);
  if (cached !== undefined) return cached ?? undefined;
  const built = buildTable(scope);
  tables.set(scope.id, built ?? null);
  return built;
}

function lastVisible(list: Binding[], useIndex: number): Binding | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i] as Binding;
    if (b.startIndex <= useIndex) return b;
  }
  return undefined;
}

/** The nearest declaration of `name` visible at `use`, walking out through enclosing scopes. */
function lookupVariable(use: SyntaxNode, name: string): Binding | undefined {
  let scope: SyntaxNode | null = use.parent;
  while (scope !== null) {
    const list = tableFor(scope)?.get(name);
    if (list !== undefined) {
      const found = lastVisible(list, use.startIndex);
      if (found !== undefined) return found;
    }
    scope = scope.parent;
  }
  return undefined;
}

/** `this.repo`: only the fields of the nearest enclosing class body count. */
function thisFieldHint(use: SyntaxNode, name: string): string | undefined {
  let scope: SyntaxNode | null = use.parent;
  while (scope !== null) {
    if (
      scope.type === "class_body" ||
      scope.type === "interface_body" ||
      scope.type === "enum_body_declarations"
    ) {
      const list = tableFor(scope)?.get(name);
      return list === undefined ? undefined : lastVisible(list, use.startIndex)?.hint;
    }
    scope = scope.parent;
  }
  return undefined;
}

/** The declared type of a variable visible at `use` (`typeKey` form), for call argument typing. */
export function declaredTypeOf(use: SyntaxNode, name: string): string | undefined {
  return lookupVariable(use, name)?.full;
}

/**
 * For a call chain such as `x.a().b()` the hint is the type of the chain's root (`x`), because
 * the resolver follows the method return types from there. A chain with no explicit root
 * (`a().b()`) has no hint.
 */
function chainRootHint(call: SyntaxNode): string | undefined {
  let node: SyntaxNode | null = call;
  while (node !== null) {
    if (node.type === "method_invocation") {
      node = node.childForFieldName("object");
    } else if (node.type === "field_access") {
      const object: SyntaxNode | null = node.childForFieldName("object");
      // `this.repo` and `Outer.this` are roots receiverHint understands itself.
      if (
        object === null ||
        object.type === "this" ||
        node.childForFieldName("field")?.type === "this"
      )
        break;
      node = object;
    } else {
      break;
    }
  }
  return node === null ? undefined : receiverHint(node);
}

function receiverHint(node: SyntaxNode): string | undefined {
  switch (node.type) {
    case "method_invocation":
      return chainRootHint(node);
    case "identifier":
      return lookupVariable(node, node.text)?.hint;
    case "object_creation_expression":
    case "cast_expression":
      return typeHint(node.childForFieldName("type"));
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner === undefined ? undefined : receiverHint(inner);
    }
    case "field_access": {
      const object = node.childForFieldName("object");
      const field = node.childForFieldName("field");
      if (object === null || field === null) return undefined;
      if (object.type === "this") return thisFieldHint(node, field.text);
      // `Outer.this.foo()`: the receiver is an instance of Outer.
      if (field.type === "this") return removeWhitespace(object.text);
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Conservative same-method type inference for `x.method()`: declared type of a local,
 * parameter or field (generics stripped, arrays and primitives give nothing), `new Foo()`,
 * `var x = new Foo()`, casts, `this.field` and `Outer.this`.
 */
export function inferJavaReceiverType(ctx: ReceiverTypeContext): string | undefined {
  return receiverHint(ctx.receiverNode);
}
