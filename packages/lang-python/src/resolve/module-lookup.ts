import type { RawImport } from "@repoatlas/schema";
import { isInitFile, type ModuleTable } from "../prepare/project-info.ts";

/** An import's module as an absolute dotted name, or the reason it has none. */
export type ModuleName =
  | { ok: true; name: string; relative: boolean }
  | { ok: false; reason: "beyond-root" | "no-module" };

export function leadingDots(specifier: string): number {
  let n = 0;
  while (specifier[n] === ".") n++;
  return n;
}

export function isRelativeImport(imp: RawImport): boolean {
  return imp.specifier.startsWith(".") || imp.isRelative === true;
}

/**
 * Turns an import specifier into an absolute module name, as seen from `file`.
 * Relative imports: the file's package is the module name minus its last part (for an
 * `__init__.py` the package is the module itself); every dot after the first goes up one
 * package. Going above the top package is "beyond-root". A file with no module name
 * (for example inside a directory called `my-app`) cannot resolve relative imports.
 */
export function absoluteModuleName(table: ModuleTable, file: string, imp: RawImport): ModuleName {
  const specifier = imp.specifier.trim();
  if (!isRelativeImport(imp)) return { ok: true, name: specifier, relative: false };

  const dots = Math.max(1, leadingDots(specifier));
  const rest = specifier.slice(leadingDots(specifier));
  const own = table.fileToModule.get(file);
  if (own === undefined) return { ok: false, reason: "no-module" };

  const parts = own.split(".");
  const packageParts = isInitFile(file) ? parts : parts.slice(0, -1);
  const up = dots - 1;
  // `from . import x` in a root-level module is a sibling lookup in the root (name "").
  // Climbing to or past the top package is an error in Python, so it is beyond-root.
  if (up > 0 && up >= packageParts.length) return { ok: false, reason: "beyond-root" };
  const base = packageParts.slice(0, packageParts.length - up);
  const tail = rest === "" ? [] : rest.split(".");
  return { ok: true, name: [...base, ...tail].join("."), relative: true };
}

export interface ModuleLookup {
  /** The file that implements the module, when there is one. */
  file?: string;
  /** True when the module exists: a file, or a namespace package (a directory), or the root. */
  known: boolean;
}

/** Looks a dotted module name up in the project. "" is the (namespace) root. */
export function findModule(table: ModuleTable, name: string): ModuleLookup {
  const file = table.moduleToFile.get(name);
  if (file !== undefined) return { file, known: true };
  return { known: name === "" || table.packages.has(name) };
}

export function topLevelOf(moduleName: string): string {
  const dot = moduleName.indexOf(".");
  return dot < 0 ? moduleName : moduleName.slice(0, dot);
}

/** Joins a package name and a member name ("" is the root package). */
export function joinModule(parent: string, child: string): string {
  return parent === "" ? child : `${parent}.${child}`;
}
