import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface JavaQueries {
  definitions: string;
  imports: string;
  references: string;
}

let cached: JavaQueries | undefined;

/**
 * Reads queries/*.scm once. The folder is found relative to this module, or through
 * JAVA_QUERIES_DIR for a bundled server (the bundle copies the folder next to itself).
 */
export function loadJavaQueries(env: NodeJS.ProcessEnv = process.env): JavaQueries {
  if (cached !== undefined) return cached;
  const override = env.JAVA_QUERIES_DIR;
  const dir =
    override !== undefined && override !== ""
      ? override
      : fileURLToPath(new URL("../../queries/", import.meta.url));
  const read = (name: string): string => readFileSync(path.join(dir, name), "utf8");
  cached = {
    definitions: read("definitions.scm"),
    imports: read("imports.scm"),
    references: read("references.scm"),
  };
  return cached;
}
