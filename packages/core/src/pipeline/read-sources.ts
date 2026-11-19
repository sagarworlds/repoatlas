import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguagePlugin, RepoFile } from "@repoatlas/plugin-api";
import { checkSourceContent } from "../walk/index.ts";
import type { PipelineContext } from "./context.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { countLines, mapLimit } from "./util.ts";

/** A claimed file that was read successfully. */
export interface LoadedFile {
  path: string;
  bytes: number;
  loc: number;
  content: string;
}

const READ_CONCURRENCY = 16;

/**
 * Reads every claimed file. Files that cannot be read, or whose content looks minified or
 * generated, are counted in the diagnostics and left out. Returns files per plugin id,
 * in the order the plugin claimed them.
 */
export async function readClaimedFiles(
  rootDir: string,
  assignments: Map<string, RepoFile[]>,
  plugins: readonly LanguagePlugin[],
  ctx: PipelineContext,
  diagnostics: Diagnostics,
): Promise<Map<string, LoadedFile[]>> {
  const result = new Map<string, LoadedFile[]>();
  for (const plugin of plugins) {
    const claimed = assignments.get(plugin.id) ?? [];
    const loaded = await mapLimit(claimed, READ_CONCURRENCY, async (file) => {
      ctx.check();
      let content: string;
      try {
        content = await readFile(join(rootDir, file.path), "utf8");
      } catch {
        diagnostics.addSkip("unreadable");
        return undefined;
      }
      const reason = await checkSourceContent(content);
      if (reason) {
        diagnostics.addSkip(reason);
        return undefined;
      }
      return { path: file.path, bytes: file.bytes, loc: countLines(content), content };
    });
    result.set(
      plugin.id,
      loaded.filter((f): f is LoadedFile => f !== undefined),
    );
  }
  return result;
}
