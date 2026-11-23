import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractJava } from "../../src/extract/index.ts";

const repoDir = fileURLToPath(new URL("../../../../fixtures/java/repo/", import.meta.url));

function javaFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...javaFiles(dir, rel));
    else if (entry.name.endsWith(".java")) out.push(rel);
  }
  return out.sort();
}

describe.skipIf(!existsSync(repoDir))("fixtures/java/repo extraction", () => {
  it("extracts every .java file with unique definition ids and valid references", async () => {
    const files = javaFiles(repoDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(path.join(repoDir, file), "utf8");
      const ex = await extractJava({ path: file, content });
      const ids = ex.definitions.map((d) => d.localId);
      expect(new Set(ids).size, `${file} definition ids`).toBe(ids.length);
      const known = new Set(ids);
      for (const r of ex.references) {
        if (r.fromLocalId !== undefined)
          expect(known.has(r.fromLocalId), `${file} ${r.name}`).toBe(true);
      }
      for (const d of ex.definitions) {
        if (d.parentLocalId !== undefined) expect(known.has(d.parentLocalId)).toBe(true);
      }
      if (!file.endsWith("Broken.java")) expect(ex.parseErrors, file).toBe(0);
    }
  });
});
