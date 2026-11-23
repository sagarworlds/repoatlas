import type { ReceiverTypeContext, SyntaxNode } from "@repoatlas/treesitter";
import { BUILTIN_FUNCTIONS, PREDECLARED_TYPES } from "./predeclared.ts";

/** What one binding of a variable tells us: a type name, or "unknown" (undefined). */
interface Binding {
  hint: string | undefined;
}

/** name -> every binding of that name in one scope. */
type BindingTable = Map<string, Binding[]>;

const FUNCTION_SCOPES = new Set(["function_declaration", "method_declaration", "func_literal"]);

/**
 * Type name written by a type node: `Server`, `*Server`, `pkg.Client`, `List[int]` (the
 * generic base). Predeclared types, slices, maps, channels and funcs give undefined.
 */
export function typeNodeHint(type: SyntaxNode | null): string | undefined {
  let current = type;
  // Unwrap `*T` and `(T)`; a loop avoids recursion on deeply nested input.
  while (
    current !== null &&
    (current.type === "pointer_type" || current.type === "parenthesized_type")
  ) {
    current = current.namedChildren.find((c) => c.type !== "comment") ?? null;
  }
  if (current === null) return undefined;
  if (current.type === "generic_type") return typeNodeHint(current.childForFieldName("type"));
  if (current.type === "type_identifier") {
    return PREDECLARED_TYPES.has(current.text) ? undefined : current.text;
  }
  if (current.type === "qualified_type") {
    const pkg = current.childForFieldName("package")?.text;
    const name = current.childForFieldName("name")?.text;
    return pkg === undefined || name === undefined ? undefined : `${pkg}.${name}`;
  }
  return undefined;
}

const VAR_PREFIX = "var:";
const MAX_EXPR_DEPTH = 24;
const MAX_VAR_DEPTH = 6;

/** A base (variable, constructor call or type name) followed by field/method steps. */
interface Chain {
  base: string;
  /** `f:name` (field access) or `m:name` (method call), in source order. */
  steps: string[];
}

function chainOf(node: SyntaxNode | null, depth: number): Chain | undefined {
  if (node === null || depth > MAX_EXPR_DEPTH) return undefined;
  switch (node.type) {
    case "identifier":
      return { base: VAR_PREFIX + node.text, steps: [] };
    case "parenthesized_expression":
      return chainOf(node.namedChildren[0] ?? null, depth + 1);
    case "unary_expression": {
      // `&x` and `*x` keep the type name (pointers are stripped everywhere).
      const op = node.childForFieldName("operator")?.text;
      if (op !== "&" && op !== "*") return undefined;
      return chainOf(node.childForFieldName("operand"), depth + 1);
    }
    case "composite_literal":
    case "type_assertion_expression": {
      const type = typeNodeHint(node.childForFieldName("type"));
      return type === undefined ? undefined : { base: type, steps: [] };
    }
    case "selector_expression": {
      const inner = chainOf(node.childForFieldName("operand"), depth + 1);
      const field = node.childForFieldName("field");
      if (inner === undefined || field === null) return undefined;
      return { base: inner.base, steps: [...inner.steps, `f:${field.text}`] };
    }
    case "call_expression":
      return callChain(node, depth);
    default:
      return undefined;
  }
}

function callChain(call: SyntaxNode, depth: number): Chain | undefined {
  let fn = call.childForFieldName("function");
  // `New[int](x)`: the callee is the operand of the index expression.
  if (fn?.type === "index_expression") fn = fn.childForFieldName("operand");
  if (fn === null) return undefined;
  if (fn.type === "identifier") {
    if (fn.text === "new") {
      const first = call.childForFieldName("arguments")?.namedChildren[0] ?? null;
      const type = typeNodeHint(first);
      return type === undefined ? undefined : { base: type, steps: [] };
    }
    if (BUILTIN_FUNCTIONS.has(fn.text) || PREDECLARED_TYPES.has(fn.text)) return undefined;
    return { base: `call:${fn.text}`, steps: [] };
  }
  if (fn.type === "selector_expression") {
    const inner = chainOf(fn.childForFieldName("operand"), depth + 1);
    const field = fn.childForFieldName("field");
    if (inner === undefined || field === null) return undefined;
    return { base: inner.base, steps: [...inner.steps, `m:${field.text}`] };
  }
  return undefined;
}

/**
 * The hint text of a value expression, before variables are resolved. Plain forms are a
 * type name (`Server`, `pkg.Client`) or `call:NewT` / `call:pkg.NewT` (the resolver reads the
 * callee signature). Anything longer is a chain `base/f:field/m:Method`; a base of the form
 * `var:x` is replaced by the type of variable x in `inferGoReceiverType`.
 */
export function valueTypeHint(value: SyntaxNode | null): string | undefined {
  const chain = chainOf(value, 0);
  if (chain === undefined) return undefined;
  if (chain.steps.length === 0 && !chain.base.startsWith(VAR_PREFIX)) return chain.base;
  return [chain.base, ...chain.steps].join("/");
}

function addBinding(table: BindingTable, name: string, hint: string | undefined): void {
  const list = table.get(name);
  if (list === undefined) table.set(name, [{ hint }]);
  else list.push({ hint });
}

function identifiersOf(list: SyntaxNode | null): SyntaxNode[] {
  if (list === null) return [];
  if (list.type === "identifier") return [list];
  return list.namedChildren.filter((c) => c.type === "identifier");
}

function valuesOf(list: SyntaxNode | null): SyntaxNode[] {
  if (list === null) return [];
  if (list.type === "expression_list") return list.namedChildren;
  return [list];
}

/** `a, b := x, y` pairs names with values; `v, ok := x.(T)` types only the first name. */
function bindPairs(table: BindingTable, names: SyntaxNode[], values: SyntaxNode[]): void {
  names.forEach((name, i) => {
    let hint: string | undefined;
    if (values.length === names.length) hint = valueTypeHint(values[i] ?? null);
    else if (
      i === 0 &&
      values.length === 1 &&
      (values[0]?.type === "type_assertion_expression" || values[0]?.type === "call_expression")
    ) {
      hint = valueTypeHint(values[0]);
    }
    addBinding(table, name.text, hint);
  });
}

function parameterBindings(list: SyntaxNode | null, table: BindingTable): void {
  if (list === null || list.type !== "parameter_list") return;
  for (const p of list.namedChildren) {
    if (p.type === "parameter_declaration") {
      const hint = typeNodeHint(p.childForFieldName("type"));
      for (const n of p.childrenForFieldName("name")) addBinding(table, n.text, hint);
    } else if (p.type === "variadic_parameter_declaration") {
      const name = p.childForFieldName("name");
      if (name !== null) addBinding(table, name.text, undefined);
    }
  }
}

function varSpecBindings(spec: SyntaxNode, table: BindingTable): void {
  const names = spec.childrenForFieldName("name").filter((n) => n.type === "identifier");
  const type = spec.childForFieldName("type");
  if (type !== null) {
    const hint = typeNodeHint(type);
    for (const n of names) addBinding(table, n.text, hint);
  } else {
    bindPairs(table, names, valuesOf(spec.childForFieldName("value")));
  }
}

/** Package-level `var` declarations of this file. */
function collectFileBindings(root: SyntaxNode): BindingTable {
  const table: BindingTable = new Map();
  for (const decl of root.namedChildren) {
    if (decl.type !== "var_declaration") continue;
    for (const child of decl.namedChildren) {
      if (child.type === "var_spec") varSpecBindings(child, table);
      else if (child.type === "var_spec_list") {
        for (const spec of child.namedChildren) {
          if (spec.type === "var_spec") varSpecBindings(spec, table);
        }
      }
    }
  }
  return table;
}

/**
 * Every binding of every name inside one function in ONE linear walk (not looking into
 * nested function literals, which are scopes of their own).
 */
function collectFunctionBindings(scope: SyntaxNode): BindingTable {
  const table: BindingTable = new Map();
  parameterBindings(scope.childForFieldName("receiver"), table);
  parameterBindings(scope.childForFieldName("parameters"), table);
  parameterBindings(scope.childForFieldName("result"), table);
  const body = scope.childForFieldName("body");
  const stack: SyntaxNode[] = body === null ? [] : [body];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    if (node.type === "func_literal") continue;
    switch (node.type) {
      case "short_var_declaration":
        bindPairs(
          table,
          identifiersOf(node.childForFieldName("left")),
          valuesOf(node.childForFieldName("right")),
        );
        break;
      case "var_spec":
        varSpecBindings(node, table);
        break;
      case "assignment_statement": {
        if (node.childForFieldName("operator")?.text !== "=") break;
        const values = valuesOf(node.childForFieldName("right"));
        const names = identifiersOf(node.childForFieldName("left"));
        // `x = nil` keeps the type of x, like `None` in Python.
        if (names.length === values.length && values.every((v) => v.type === "nil")) break;
        bindPairs(table, names, values);
        break;
      }
      case "range_clause":
        for (const n of identifiersOf(node.childForFieldName("left"))) {
          addBinding(table, n.text, undefined);
        }
        break;
      case "type_switch_statement":
        for (const n of identifiersOf(node.childForFieldName("alias"))) {
          addBinding(table, n.text, undefined);
        }
        break;
      default:
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return table;
}

// WeakMap keyed by the syntax tree (like C# ConditionalWeakTable): a freed tree frees its entries.
const treeCaches = new WeakMap<object, Map<number, BindingTable>>();

function tableFor(scope: SyntaxNode): BindingTable {
  let caches = treeCaches.get(scope.tree);
  if (caches === undefined) {
    caches = new Map();
    treeCaches.set(scope.tree, caches);
  }
  let table = caches.get(scope.id);
  if (table === undefined) {
    table =
      scope.type === "source_file" ? collectFileBindings(scope) : collectFunctionBindings(scope);
    caches.set(scope.id, table);
  }
  return table;
}

/** The innermost scope (function literal, function, file) that binds `name`. */
function bindingsFor(start: SyntaxNode, name: string): Binding[] {
  let current: SyntaxNode | null = start.parent;
  while (current !== null) {
    if (FUNCTION_SCOPES.has(current.type) || current.type === "source_file") {
      const found = tableFor(current).get(name);
      if (found !== undefined && found.length > 0) return found;
    }
    current = current.parent;
  }
  return [];
}

/**
 * True when `name` is bound by a parameter, receiver, result or local declaration of an
 * enclosing function (or function literal). Such a name shadows a package-level function or an
 * imported package of the same name. Package-level variables do not count.
 */
export function isLocalName(start: SyntaxNode, name: string): boolean {
  let current: SyntaxNode | null = start.parent;
  while (current !== null) {
    if (FUNCTION_SCOPES.has(current.type) && tableFor(current).has(name)) return true;
    current = current.parent;
  }
  return false;
}

const MAX_ALTERNATIVES = 4;

/**
 * Replaces a `var:x` base by the hints of every binding of variable x in the innermost scope
 * that binds it (a list of alternatives; the resolver accepts them only when they all lead to
 * the same type). A variable without a binding in this file is a package-level variable of
 * another file, or an import name: `pkg/m:New` becomes `call:pkg.New`, anything else becomes
 * `pkgvar:x`. Undefined when a binding has no hint or there are too many alternatives.
 */
function expandHint(hint: string, at: SyntaxNode, depth: number): string[] | undefined {
  const parts = hint.split("/");
  const base = parts[0] ?? "";
  if (!base.startsWith(VAR_PREFIX)) return [hint];
  if (depth > MAX_VAR_DEPTH) return undefined;
  const name = base.slice(VAR_PREFIX.length);
  const bindings = bindingsFor(at, name);
  if (bindings.length === 0) {
    const first = parts[1];
    if (first?.startsWith("m:")) {
      return [[`call:${name}.${first.slice(2)}`, ...parts.slice(2)].join("/")];
    }
    return [[`pkgvar:${name}`, ...parts.slice(1)].join("/")];
  }
  const alternatives = new Set<string>();
  for (const b of bindings) {
    const expanded = b.hint === undefined ? undefined : expandHint(b.hint, at, depth + 1);
    if (expanded === undefined) return undefined;
    for (const e of expanded) alternatives.add([e, ...parts.slice(1)].join("/"));
  }
  return alternatives.size > MAX_ALTERNATIVES ? undefined : [...alternatives];
}

/**
 * Hints of the package-level variables declared in one file (name -> hint), for the resolver
 * to type `Var.Method()` calls made from other files of the package. Variables with several
 * differing bindings are left out.
 */
export function fileVarHints(root: SyntaxNode): Record<string, string> {
  const out: Record<string, string> = {};
  const anchor = root.namedChildren[0];
  if (anchor === undefined) return out;
  for (const [name, bindings] of tableFor(root)) {
    const first = bindings[0]?.hint;
    if (first === undefined || bindings.some((x) => x.hint !== first)) continue;
    const expanded = expandHint(first, anchor, 0);
    if (expanded === undefined || expanded.length !== 1) continue;
    const text = expanded[0];
    if (text !== undefined && text !== `pkgvar:${name}`) out[name] = text;
  }
  return out;
}

/**
 * Conservative same-scope type inference for the receiver of `x.Method()`. The receiver
 * expression may be a variable, a field chain (`x.a.b`) or a call chain (`x.A().B()`):
 * the variable's type is found when every binding of it in the innermost scope that binds it
 * (parameters, receiver, `x := T{}`, `x := &T{}`, `x := new(T)`, `var x T`, `x := y.(T)`,
 * `x := NewT()`) agrees on one type; the resolver then follows the field and method steps
 * through struct fields and method signatures. Any other binding of `x` (a range variable,
 * a different type) cancels the hint.
 */
export function inferGoReceiverType(ctx: ReceiverTypeContext): string | undefined {
  const receiver = ctx.receiverNode;
  const raw = valueTypeHint(receiver);
  if (raw === undefined) return undefined;
  return expandHint(raw, receiver, 0)?.join("|");
}
