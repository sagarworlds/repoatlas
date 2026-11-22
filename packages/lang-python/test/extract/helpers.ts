import type { Definition, FileExtraction, RawImport, RawReference } from "@repoatlas/schema";
import { extractPython } from "../../src/extract/index.ts";

/** Extracts an inline snippet. Dedent is not applied: write snippets at column 0. */
export async function extract(content: string, path = "pkg/mod.py"): Promise<FileExtraction> {
  return extractPython({ path, content });
}

export function def(ex: FileExtraction, localId: string): Definition {
  const found = ex.definitions.find((d) => d.localId === localId);
  if (found === undefined) {
    throw new Error(
      `no definition ${localId}; have ${ex.definitions.map((d) => d.localId).join()}`,
    );
  }
  return found;
}

export function refs(
  ex: FileExtraction,
  name: string,
  kind?: RawReference["kind"],
): RawReference[] {
  return ex.references.filter((r) => r.name === name && (kind === undefined || r.kind === kind));
}

export function ref(ex: FileExtraction, name: string, kind?: RawReference["kind"]): RawReference {
  const found = refs(ex, name, kind)[0];
  if (found === undefined) {
    throw new Error(`no reference ${name}; have ${ex.references.map((r) => r.name).join()}`);
  }
  return found;
}

export function importOf(ex: FileExtraction, specifier: string): RawImport {
  const found = ex.imports.find((i) => i.specifier === specifier);
  if (found === undefined) {
    throw new Error(`no import ${specifier}; have ${ex.imports.map((i) => i.specifier).join()}`);
  }
  return found;
}
