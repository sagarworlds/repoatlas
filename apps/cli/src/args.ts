import { parseArgs } from "node:util";

export const USAGE = `Usage:
  pnpm analyze <github-url | owner/repo> [--ref <ref>] [--out <file>]
  pnpm analyze --local <dir> [--out <file>]

Options:
  --ref <ref>     Branch, tag or commit SHA (default: the repository's default branch)
  --out <file>    Write the full graph (nodes, edges, rollups, stats) as JSON to <file>
  --local <dir>   Analyze a directory on disk instead of downloading from GitHub
  -h, --help      Show this help

Environment (optional):
  GITHUB_TOKEN, MAX_TARBALL_BYTES, MAX_FILES, MAX_FILE_BYTES, ANALYSIS_TIMEOUT_MS

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
  return {
    kind: "analyze",
    target: positionals[0],
    ref: values.ref,
    out: values.out,
    local,
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
