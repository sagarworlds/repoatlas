import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PipelineResult } from "@repoatlas/core";
import { SCHEMA_VERSION } from "@repoatlas/schema";

export interface DumpRepo {
  owner: string;
  repo: string;
  ref: string;
  commitSha: string;
}

function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively sorts object keys so the JSON text does not depend on insertion order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Builds the deterministic JSON text of the --out file. */
export function buildDump(repo: DumpRepo, result: PipelineResult): string {
  const document = {
    schemaVersion: SCHEMA_VERSION,
    repo,
    stats: result.stats,
    nodes: [...result.nodes].sort((a, b) => compare(a.id, b.id)),
    edges: [...result.edges].sort(
      (a, b) =>
        compare(a.kind, b.kind) ||
        compare(a.src, b.src) ||
        compare(a.dst, b.dst) ||
        compare(a.line ?? 0, b.line ?? 0),
    ),
    rollups: [...result.rollups].sort(
      (a, b) =>
        compare(a.level, b.level) ||
        compare(a.kind, b.kind) ||
        compare(a.src, b.src) ||
        compare(a.dst, b.dst),
    ),
    unresolved: [...result.unresolved].sort(
      (a, b) =>
        compare(a.file, b.file) ||
        compare(a.line, b.line) ||
        compare(a.name, b.name) ||
        compare(a.kind, b.kind),
    ),
  };
  return `${JSON.stringify(sortKeys(document), null, 2)}\n`;
}

/** Writes to a temp file next to the target, then renames, so readers never see a partial file. */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
