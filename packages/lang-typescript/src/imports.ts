import type { RawImport } from "@repoatlas/schema";
import ts from "typescript";
import { walkPreOrder } from "./ast-walk.ts";

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
 */
export function collectImports(sf: ts.SourceFile): ImportSite[] {
  const sites: ImportSite[] = [];
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  function push(
    node: ts.Node,
    specifier: string,
    kind: RawImport["kind"],
    extra: { names?: RawImport["names"]; alias?: string; typeOnly?: boolean; reexport?: boolean },
  ): void {
    const raw: RawImport = {
      line: lineOf(node),
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
    if (
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

  walkPreOrder(sf, visit);
  return sites;
}
