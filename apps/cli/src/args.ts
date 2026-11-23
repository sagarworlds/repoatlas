import { parseArgs } from "node:util";

export const USAGE = `Usage:
  pnpm analyze <github-url | owner/repo> [--ref <ref>] [--out <file>] [--no-cache] [--workers <n>]
  pnpm analyze --local <dir> [--out <file>] [--no-cache] [--workers <n>]

Options:
  --ref <ref>     Branch, tag or commit SHA (default: the repository's default branch)
  --out <file>    Write the full graph (nodes, edges, rollups, stats) as JSON to <file>
  --local <dir>   Analyze a directory on disk instead of downloading from GitHub
  --no-cache      Do not read or write the per-file extraction cache
  --workers <n>   Extraction threads: 0 or 1 = main thread only (debugging), default auto
                  (CPUs - 1, at most 8, and only for repositories with 100+ files per plugin)
  -h, --help      Show this help

Environment (optional):
  GITHUB_TOKEN, MAX_TARBALL_BYTES, MAX_FILES, MAX_FILE_BYTES, ANALYSIS_TIMEOUT_MS,
  CLI_CACHE_FILE (extraction cache database, default <repo>/data/cli-cache.db),
  CACHE_MAX_EXTRACTIONS, CACHE_MAX_EXTRACTION_BYTES, EXTRACT_WORKERS

Exit codes: 0 ok, 1 usage error, 2 analysis error, 130 interrupted
`;

/** What the user asked for. A discriminated union: check \`kind\` to narrow the type. */
export type ParsedArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | {
      kind: "analyze";
      /** GitHub URL or owner/repo shorthand; undefined when --local is used. */
      target: string | undefined;
      ref: string | undefined;
      out: string | undefined;
      local: string | undefined;
      /** True when --no-cache was given. */
      noCache: boolean;
      /** Value of --workers (0..64), or undefined when the flag was not given. */
      workers: number | undefined;
    };

export function parseCliArgs(argv: string[]): ParsedArgs {
  let parsed: ReturnType<typeof parseArgsStrict>;
  try {
    parsed = parseArgsStrict(argv);
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };

  const local = values.local;
  if (local !== undefined && positionals.length > 0) {
    return { kind: "error", message: "Give either a <github-url> or --local <dir>, not both." };
  }
  if (local === undefined && positionals.length === 0) {
    return { kind: "error", message: "Missing <github-url> (or --local <dir>)." };
  }
  if (positionals.length > 1) {
    return { kind: "error", message: "Only one <github-url> may be given." };
  }
  if (local !== undefined && values.ref !== undefined) {
    return { kind: "error", message: "--ref cannot be used with --local." };
  }
  if (local === "" || values.out === "" || values.ref === "") {
    return { kind: "error", message: "Option values must not be empty." };
  }
  let workers: number | undefined;
  if (values.workers !== undefined) {
    // Number() rather than parseInt so "2x" is rejected instead of read as 2.
    workers = values.workers.trim() === "" ? Number.NaN : Number(values.workers);
    if (!Number.isInteger(workers) || workers < 0 || workers > 64) {
      return { kind: "error", message: "--workers must be an integer from 0 to 64." };
    }
  }
  return {
    kind: "analyze",
    target: positionals[0],
    ref: values.ref,
    out: values.out,
    local,
    noCache: values["no-cache"] === true,
    workers,
  };
}

function parseArgsStrict(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      ref: { type: "string" },
      out: { type: "string" },
      local: { type: "string" },
      "no-cache": { type: "boolean" },
      workers: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** Turns "owner/repo" into a full URL; anything else is returned unchanged. */
export function expandShorthand(target: string): string {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)
    ? `https://github.com/${target}`
    : target;
}
