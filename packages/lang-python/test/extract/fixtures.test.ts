import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileExtraction } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractPython } from "../../src/extract/index.ts";

const fixturesDir = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

function listPythonFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPythonFiles(full, base));
    else if (entry.name.endsWith(".py")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

async function extractAll(repoDir: string): Promise<Map<string, FileExtraction>> {
  const result = new Map<string, FileExtraction>();
  for (const rel of listPythonFiles(repoDir)) {
    const content = readFileSync(path.join(repoDir, rel), "utf8");
    result.set(rel, await extractPython({ path: rel, content }));
  }
  return result;
}

interface ExpectedNode {
  id: string;
  kind: string;
}

const pythonRepo = path.join(fixturesDir, "python", "repo");
const polyglotRepo = path.join(fixturesDir, "polyglot", "repo");

describe.skipIf(!existsSync(pythonRepo))("fixtures/python extraction", () => {
  it("extracts every file without throwing and with unique definition ids", async () => {
    const all = await extractAll(pythonRepo);
    expect(all.size).toBeGreaterThan(5);
    for (const [file, ex] of all) {
      const ids = ex.definitions.map((d) => d.localId);
      expect(new Set(ids).size, `duplicate ids in ${file}`).toBe(ids.length);
    }
  });

  it("only broken.py has parse errors", async () => {
    const all = await extractAll(pythonRepo);
    const broken = [...all].filter(([, ex]) => ex.parseErrors > 0).map(([file]) => file);
    expect(broken).toEqual(["src/shop/broken.py"]);
    const ex = all.get("src/shop/broken.py");
    expect(ex?.definitions.length).toBeGreaterThanOrEqual(2);
  });

  it("produces every definition node the golden file expects", async () => {
    const expectedPath = path.join(fixturesDir, "python", "expected-edges.json");
    if (!existsSync(expectedPath)) return;
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
      mustContainNodes?: ExpectedNode[];
    };
    const all = await extractAll(pythonRepo);
    const produced = new Map<string, string>();
    for (const [file, ex] of all) {
      for (const d of ex.definitions) produced.set(`sym:${file}#${d.localId}`, d.kind);
    }
    for (const node of expected.mustContainNodes ?? []) {
      if (!node.id.startsWith("sym:")) continue;
      expect(produced.get(node.id), node.id).toBe(node.kind);
    }
  });

  it("marks files under tests/ as test code", async () => {
    const all = await extractAll(pythonRepo);
    expect(all.get("tests/test_service.py")?.meta?.isTest).toBe(true);
    expect(all.get("src/shop/models.py")?.meta?.isTest).toBeUndefined();
  });
});

describe.skipIf(!existsSync(polyglotRepo))("fixtures/polyglot python part", () => {
  it("extracts the python files", async () => {
    const all = await extractAll(path.join(polyglotRepo, "app"));
    expect(all.size).toBeGreaterThanOrEqual(2);
    for (const ex of all.values()) expect(ex.parseErrors).toBe(0);
  });
});
