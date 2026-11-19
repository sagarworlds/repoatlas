import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ReadEntry } from "tar";
import { Parser } from "tar";
import { AnalysisError } from "../errors.ts";
import type { Limits } from "../types.ts";
import { abortToError, throwIfAborted } from "./abort.ts";
import { checkEntryPath } from "./path-rules.ts";

export interface ExtractResult {
  /** Regular files written to disk. */
  files: number;
  /** Bytes written to disk. */
  bytes: number;
  skipped: { reason: string; count: number }[];
}

type EntryKind = "file" | "dir" | "symlink" | "hardlink" | "special";

// Final absolute path length limits. Windows MAX_PATH is 260 (including the terminator).
const MAX_ABSOLUTE_PATH = process.platform === "win32" ? 259 : 4095;

function classify(type: string): EntryKind {
  switch (type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
      return "file";
    case "Directory":
      return "dir";
    case "SymbolicLink":
      return "symlink";
    case "Link":
      return "hardlink";
    default:
      return "special";
  }
}

/**
 * Safely extract an (already gunzipped) tar stream into `destDir`.
 *
 * The `tar` package is used ONLY as a streaming parser; this function decides what gets
 * written where, so every rule of docs/SECURITY.md section 3 lives here and in path-rules.ts.
 * Nothing is ever executed, symlinks/hardlinks/devices are never created, and files are
 * written with mode 0o644 and the "wx" flag (fail if the file already exists).
 */
export async function extractTarball(
  stream: Readable,
  destDir: string,
  limits: Limits,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const destRoot = path.resolve(destDir);
  await mkdir(destRoot, { recursive: true });

  const maxInputBytes = limits.maxTarballBytes * 3; // zip-bomb ratio guard
  const skipped = new Map<string, number>();
  const note = (reason: string): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };

  // lower-cased relative path -> original-cased path, for case-collision detection.
  const casing = new Map<string, string>();
  const seenFiles = new Set<string>();
  let nonDirEntries = 0;
  let inputBytes = 0;
  let filesWritten = 0;
  let bytesWritten = 0;

  // `fatal` records the first abort-worthy error raised inside event callbacks (which cannot
  // throw to our caller). `writes` is a serial promise chain so file writes never overlap.
  let fatal: unknown;
  let writes: Promise<void> = Promise.resolve();

  /** Returns false when `segments` collides (differs only by case) with an earlier entry. */
  function registerCasing(segments: string[]): boolean {
    const keys: [string, string][] = [];
    for (let i = 1; i <= segments.length; i++) {
      const original = segments.slice(0, i).join("/");
      const known = casing.get(original.toLowerCase());
      if (known !== undefined && known !== original) return false;
      keys.push([original.toLowerCase(), original]);
    }
    for (const [lower, original] of keys) casing.set(lower, original);
    return true;
  }

  /** Resolve the on-disk path and prove it is inside destRoot; undefined = skip. */
  function resolveTarget(segments: string[]): string | undefined {
    const absolute = path.resolve(destRoot, ...segments);
    if (!absolute.startsWith(destRoot + path.sep)) {
      note("unsafe-path");
      return undefined;
    }
    if (absolute.length > MAX_ABSOLUTE_PATH) {
      note("path-too-long");
      return undefined;
    }
    return absolute;
  }

  function enqueueWrite(task: () => Promise<void>): void {
    writes = writes.then(async () => {
      if (fatal !== undefined) return;
      try {
        await task();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Conflicts caused by hostile/odd archives (file vs directory, duplicates) are skips.
        if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") note("path-conflict");
        else if (code === "ENAMETOOLONG" || code === "EINVAL") note("unsafe-path");
        else
          fatal = new AnalysisError("INTERNAL", "Failed to write extracted file", { cause: err });
      }
    });
  }

  function handleEntry(entry: ReadEntry): void {
    const kind = classify(entry.type);

    if (kind !== "dir") {
      nonDirEntries++;
      if (nonDirEntries > limits.maxFiles) {
        throw new AnalysisError(
          "REPO_TOO_LARGE",
          `Repository has more than ${limits.maxFiles} files`,
        );
      }
    }
    if (kind === "symlink" || kind === "hardlink" || kind === "special") {
      note(kind === "special" ? "special-file" : kind);
      entry.resume();
      return;
    }

    const checked = checkEntryPath(entry.path);
    if (checked.ok === "empty") {
      entry.resume();
      return;
    }
    if (!checked.ok) {
      note(checked.reason);
      entry.resume();
      return;
    }
    const segments = checked.segments;
    const relPath = segments.join("/");

    if (kind === "file" && seenFiles.has(relPath)) {
      note("duplicate");
      entry.resume();
      return;
    }
    if (!registerCasing(segments)) {
      note("case-collision");
      entry.resume();
      return;
    }
    const target = resolveTarget(segments);
    if (target === undefined) {
      entry.resume();
      return;
    }

    if (kind === "dir") {
      entry.resume();
      enqueueWrite(async () => {
        await mkdir(target, { recursive: true, mode: 0o755 });
      });
      return;
    }

    // Regular file. The header size is only a hint; we also count the real bytes received.
    if (entry.size > limits.maxFileBytes) {
      note("too-large-file");
      entry.resume();
      return;
    }
    seenFiles.add(relPath);
    const chunks: Buffer[] = [];
    let received = 0;
    entry.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received <= limits.maxFileBytes) chunks.push(chunk);
    });
    entry.on("end", () => {
      if (received > limits.maxFileBytes) {
        note("too-large-file");
        return;
      }
      const content = Buffer.concat(chunks);
      enqueueWrite(async () => {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, content, { flag: "wx", mode: 0o644 });
        filesWritten++;
        bytesWritten += content.length;
      });
    });
  }

  const parser = new Parser({ strict: false, onwarn: () => {} });
  parser.on("entry", (entry: ReadEntry) => {
    if (fatal !== undefined) {
      entry.resume();
      return;
    }
    try {
      handleEntry(entry);
    } catch (err) {
      fatal = err;
      entry.resume();
    }
  });

  const onAbort = (): void => {
    if (signal) stream.destroy(abortToError(signal));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    throwIfAborted(signal);
    // Feeding the parser chunk by chunk and awaiting the write chain after each one gives
    // backpressure: at most one chunk's worth of entries is buffered in memory at a time.
    for await (const chunk of stream as AsyncIterable<unknown>) {
      throwIfAborted(signal);
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      inputBytes += buf.length;
      if (inputBytes > maxInputBytes) {
        throw new AnalysisError(
          "REPO_TOO_LARGE",
          "Extracted size exceeds the allowed ratio of the tarball limit",
        );
      }
      parser.write(buf);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writes;
      if (fatal !== undefined) throw fatal;
    }
    parser.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writes;
    if (fatal !== undefined) throw fatal;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.destroy();
  }

  return {
    files: filesWritten,
    bytes: bytesWritten,
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
  };
}
