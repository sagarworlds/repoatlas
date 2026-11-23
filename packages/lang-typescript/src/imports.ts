import type { RawImport } from "@repoatlas/schema";
import ts from "typescript";
import { walkPreOrder } from "./ast-walk.ts";
import { isJavaScriptSource } from "./source-kinds.ts";

/** One import-like statement found in a file, before resolution. */
export interface ImportSite {
  raw: RawImport;
  typeOnly: boolean;
  /** `export ... from "x"` */
  reexport: boolean;
}

/**
 * Finds every module specifier a file refers to: `import`, `export ... from`,
 * `import x = require("y")`, dynamic `import("z")` and `import("w").Type` type queries.
 * CommonJS `require("v")` calls with a literal specifier count too (a `require` with a
 * computed argument is skipped: there is nothing to resolve). In JavaScript files,
 * `import("x")` types written inside JSDoc comments are found by a text scan.
 */
export function collectImports(sf: ts.SourceFile): ImportSite[] {
  const sites: ImportSite[] = [];
  const lineAt = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  /** `at` is the node (or text position) whose line is reported. */
  function push(
    at: ts.Node | number,
    specifier: string,
    kind: RawImport["kind"],
    extra: { names?: RawImport["names"]; alias?: string; typeOnly?: boolean; reexport?: boolean },
  ): void {
    const raw: RawImport = {
      line: lineAt(typeof at === "number" ? at : at.getStart(sf)),
      specifier,
      kind,
      isRelative: specifier.startsWith("."),
    };
    if (extra.names && extra.names.length > 0) raw.names = extra.names;
    if (extra.alias !== undefined) raw.alias = extra.alias;
    sites.push({ raw, typeOnly: extra.typeOnly === true, reexport: extra.reexport === true });
  }

  /** Returns false when the children must not be visited. */
  function visit(node: ts.Node): boolean {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) {
        push(node, spec, "side-effect", {});
      } else {
        const typeOnly = clause.isTypeOnly === true;
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          push(node, spec, "wildcard", { alias: bindings.name.text, typeOnly });
        } else if (bindings && ts.isNamedImports(bindings)) {
          const names: NonNullable<RawImport["names"]> = [];
          if (clause.name) names.push({ name: "default", alias: clause.name.text });
          for (const el of bindings.elements) {
            names.push(
              el.propertyName
                ? { name: el.propertyName.text, alias: el.name.text }
                : { name: el.name.text },
            );
          }
          push(node, spec, "named", { names, typeOnly });
        } else {
          push(node, spec, "module", { alias: clause.name?.text, typeOnly });
        }
      }
      return false;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly;
      if (clause && ts.isNamedExports(clause)) {
        const names = clause.elements.map((el) =>
          el.propertyName
            ? { name: el.propertyName.text, alias: el.name.text }
            : { name: el.name.text },
        );
        push(node, spec, "named", { names, typeOnly, reexport: true });
      } else {
        const alias = clause && ts.isNamespaceExport(clause) ? clause.name.text : undefined;
        push(node, spec, "wildcard", { alias, typeOnly, reexport: true });
      }
      return false;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      push(node, node.moduleReference.expression.text, "module", {
        alias: node.name.text,
        typeOnly: node.isTypeOnly,
      });
      return false;
    }
    if (ts.isCallExpression(node) && isRequireCall(node)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) pushRequire(node, arg.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      push(node, node.arguments[0].text, "dynamic", {});
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      push(node, node.argument.literal.text, "module", { typeOnly: true });
    }
    return true;
  }

  /** `const x = require("m")`, `const { a, b: c } = require("m")`, `require("m").f`, `require("m")`. */
  function pushRequire(call: ts.CallExpression, specifier: string): void {
    const parent = call.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === call) {
      const decl = ts.isVariableDeclaration(parent.parent) ? parent.parent : undefined;
      const alias = decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
      const entry =
        alias === undefined ? { name: parent.name.text } : { name: parent.name.text, alias };
      push(call, specifier, "named", { names: [entry] });
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === call) {
      if (ts.isIdentifier(parent.name)) {
        push(call, specifier, "module", { alias: parent.name.text });
      } else if (ts.isObjectBindingPattern(parent.name)) {
        const names: NonNullable<RawImport["names"]> = [];
        for (const el of parent.name.elements) {
          if (el.dotDotDotToken) continue;
          const local = ts.isIdentifier(el.name) ? el.name.text : undefined;
          const imported =
            el.propertyName &&
            (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
              ? el.propertyName.text
              : local;
          if (imported === undefined) continue;
          names.push(
            local !== undefined && local !== imported
              ? { name: imported, alias: local }
              : { name: imported },
          );
        }
        push(call, specifier, "named", { names });
      } else {
        push(call, specifier, "module", {});
      }
    } else if (ts.isExpressionStatement(parent)) {
      push(call, specifier, "side-effect", {});
    } else {
      push(call, specifier, "module", {});
    }
  }

  walkPreOrder(sf, visit);
  if (isJavaScriptSource(sf.fileName)) {
    for (const block of jsDocBlocks(sf.text)) {
      for (const hit of block.text.matchAll(JSDOC_IMPORT_TYPE)) {
        if (hit[1] !== undefined) {
          push(block.start + hit.index, hit[1], "module", { typeOnly: true });
        }
      }
    }
  }
  return sites;
}

/** `require("x")` with exactly one argument (the checker also treats it as an import). */
function isRequireCall(call: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(call.expression) &&
    call.expression.text === "require" &&
    call.arguments.length === 1
  );
}

/**
 * Finds `/** ... *\/` blocks with indexOf, in linear time. (A lazy regex rescans to the end of
 * the file for every unclosed opener, which is quadratic on hostile input.)
 */
function jsDocBlocks(text: string): { start: number; text: string }[] {
  const blocks: { start: number; text: string }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("/**", from);
    if (start < 0) break;
    const end = text.indexOf("*/", start + 3);
    if (end < 0) break;
    blocks.push({ start, text: text.slice(start, end + 2) });
    from = end + 2;
  }
  return blocks;
}
// `@type {import("./types").Config}` in a JSDoc block is a type-only import. The TypeScript
// parser does not expose JSDoc to forEachChild, so the comment text is scanned instead.
const JSDOC_IMPORT_TYPE = /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;
