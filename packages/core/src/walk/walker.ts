import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { toPosixPath } from "@repoatlas/schema";
import { AnalysisError } from "../errors.ts";
import type { Limits } from "../types.ts";
import {
  BINARY_SNIFF_BYTES,
  isGeneratedPath,
  isIgnoredDir,
  looksBinary,
  looksMinifiedOrGenerated,
} from "./filters.ts";

export interface WalkedFile {
  path: string;
  bytes: number;
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: { reason: string; count: number }[];
}

/** Compares by UTF-16 code units (like C# string.CompareOrdinal), independent of locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readHead(absPath: string): Promise<Buffer> {
  const handle = await open(absPath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Walks `rootDir` iteratively and returns candidate files (POSIX relative paths).
 * Never follows symlinks and never reads more than the first 8000 bytes of a file.
 * Throws AnalysisError: CANCELLED on abort, REPO_TOO_LARGE past `limits.maxFiles`.
 */
export async function walkRepo(
  rootDir: string,
  limits: Limits,
  signal?: AbortSignal,
): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const skipCounts = new Map<string, number>();
  const skip = (reason: string): void => {
    skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
  };

  // Stack of relative POSIX directory paths ("" = root).
  const pending: string[] = [""];
  while (pending.length > 0) {
    if (signal?.aborted) throw new AnalysisError("CANCELLED", "Analysis was cancelled");
    const relDir = pending.pop() as string;
    let names: string[];
    try {
      names = await readdir(join(rootDir, relDir));
    } catch {
      skip("unreadable-dir");
      continue;
    }

    for (const name of names) {
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      const abs = join(rootDir, rel);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(abs);
      } catch {
        skip("unreadable");
        continue;
      }

      if (info.isSymbolicLink()) {
        skip("symlink");
      } else if (info.isDirectory()) {
        if (isIgnoredDir(name)) skip("ignored-dir");
        else pending.push(rel);
      } else if (info.isFile()) {
        const path = toPosixPath(rel);
        const generated = isGeneratedPath(path);
        if (generated) {
          skip(generated);
          continue;
        }
        if (info.size > limits.maxFileBytes) {
          skip("too-large");
          continue;
        }
        let binary: string | undefined;
        try {
          binary = looksBinary(await readHead(abs));
        } catch {
          skip("unreadable");
          continue;
        }
        if (binary) {
          skip(binary);
          continue;
        }
        files.push({ path, bytes: info.size });
        if (files.length > limits.maxFiles) {
          throw new AnalysisError(
            "REPO_TOO_LARGE",
            `Repository has more than ${limits.maxFiles} files`,
          );
        }
      } else {
        skip("special-file");
      }
    }
  }

  files.sort((a, b) => compareCodeUnits(a.path, b.path));
  const skipped = [...skipCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => compareCodeUnits(a.reason, b.reason));
  return { files, skipped };
}

/**
 * Content-based check, called by the pipeline after a plugin claimed the file.
 * Async so the caller can treat it like other per-file steps (and for future cheap I/O).
 */
export async function checkSourceContent(content: string): Promise<string | undefined> {
  return looksMinifiedOrGenerated(content);
}
