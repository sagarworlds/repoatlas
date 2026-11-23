import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileExtractionSchema } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractGo } from "../../src/extract/index.ts";

const repoDir = fileURLToPath(new URL("../../../../fixtures/go/repo/", import.meta.url));

function listGoFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listGoFiles(full, base));
    else if (entry.name.endsWith(".go")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

describe.skipIf(!existsSync(repoDir))("go fixture repo extraction", () => {
  it("extracts every .go file without errors and with unique definition ids", async () => {
    const files = listGoFiles(repoDir);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const content = readFileSync(path.join(repoDir, rel), "utf8");
      const ex = await extractGo({ path: rel, content });
      expect(FileExtractionSchema.safeParse(ex).success, rel).toBe(true);
      if (!path.basename(rel).startsWith("broken")) expect(ex.parseErrors, rel).toBe(0);
      const ids = ex.definitions.map((d) => d.localId);
      expect(new Set(ids).size, `${rel}: duplicate ids in ${ids.join()}`).toBe(ids.length);
      expect(ex.meta?.["go.package"], rel).toBeTypeOf("string");
    }
  });
});
