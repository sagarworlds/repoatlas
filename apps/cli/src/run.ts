import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AnalysisError,
  type AnalyzeRepositoryOptions,
  analyzeRepository,
  createDefaultRegistry,
  type Fetcher,
  GitHubFetcher,
  LocalDirFetcher,
  type ProgressEvent,
  parseGitHubUrl,
  type RepoRequest,
} from "@repoatlas/core";
import { expandShorthand, parseCliArgs, USAGE } from "./args.ts";
import { ConfigError, limitsFromEnv, loadDotEnv } from "./config.ts";
import { buildDump, writeFileAtomic } from "./dump.ts";
import { formatStats } from "./report.ts";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_ANALYSIS = 2;
export const EXIT_SIGINT = 130;

export interface RunDeps {
  fetcher?: Fetcher;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Parent directory for temporary download folders (default: os.tmpdir()). */
  tmpRoot?: string;
  plugins?: AnalyzeRepositoryOptions["plugins"];
  /** Environment to read config from (default: process.env after loading the repo .env). */
  env?: NodeJS.ProcessEnv;
}

/** Replaces every occurrence of the secret so it can never reach the output. */
function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("***") : text;
}

function isTty(stream: NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

/** Prints progress as one updating line on a TTY, or as occasional lines otherwise. */
function createProgressPrinter(stderr: NodeJS.WritableStream) {
  const tty = isTty(stderr);
  let lastPhase = "";
  let lastPrint = 0;
  let dirty = false;
  return {
    onProgress(event: ProgressEvent): void {
      const text = `${event.phase} ${event.filesDone}/${event.filesTotal}`;
      if (tty) {
        stderr.write(`\r${text}\u001b[K`);
        dirty = true;
        return;
      }
      const now = Date.now();
      const done = event.filesTotal > 0 && event.filesDone === event.filesTotal;
      if (event.phase !== lastPhase || done || now - lastPrint >= 2000) {
        stderr.write(`${text}\n`);
        lastPhase = event.phase;
        lastPrint = now;
      }
    },
    finish(): void {
      if (dirty) {
        stderr.write("\r\u001b[K");
        dirty = false;
      }
    },
  };
}

function localRequest(dir: string): { owner: string; repo: string } {
  const base = path.basename(dir).replace(/[^A-Za-z0-9_.-]/g, "-") || "local";
  return { owner: "local", repo: base };
}

/**
 * Runs the CLI and returns the exit code. It never calls process.exit, so tests can
 * inject a fake fetcher and capture the output streams.
 */
export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    stdout.write(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === "error") {
    stderr.write(`error: ${parsed.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  let env: NodeJS.ProcessEnv;
  if (deps.env) {
    env = deps.env;
  } else {
    loadDotEnv();
    env = process.env;
  }
  const token = env.GITHUB_TOKEN?.trim() || undefined;

  let limits: ReturnType<typeof limitsFromEnv>;
  try {
    limits = limitsFromEnv(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr.write(`error: ${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    controller.abort(new Error("interrupted"));
  };
  process.once("SIGINT", onSigint);

  const tempDirs: string[] = [];
  const progress = createProgressPrinter(stderr);

  try {
    let request: RepoRequest;
    let fetcher: Fetcher;
    if (parsed.local !== undefined) {
      const dir = path.resolve(parsed.local);
      request = localRequest(dir);
      fetcher = deps.fetcher ?? new LocalDirFetcher({ dir, ...request });
    } else {
      const target = parsed.target ?? "";
      const url = parseGitHubUrl(expandShorthand(target));
      request = { owner: url.owner, repo: url.repo, ref: parsed.ref ?? url.ref };
      fetcher = deps.fetcher ?? new GitHubFetcher({ token });
    }

    const outcome = await analyzeRepository({
      fetcher,
      request,
      limits,
      plugins: deps.plugins ?? [...createDefaultRegistry().plugins],
      destDirFor: async () => {
        const dir = await mkdtemp(path.join(deps.tmpRoot ?? tmpdir(), "repoatlas-"));
        tempDirs.push(dir);
        return dir;
      },
      onProgress: (event) => progress.onProgress(event),
      signal: controller.signal,
    });
    progress.finish();

    if (outcome.status === "skipped") {
      // Cannot happen: the CLI passes no shouldSkip. Kept for exhaustive handling.
      stderr.write("error: analysis was skipped\n");
      return EXIT_ANALYSIS;
    }
    const { fetched, result } = outcome;
    const meta = {
      owner: fetched.owner,
      repo: fetched.repo,
      ref: fetched.ref,
      commitSha: fetched.commitSha,
    };
    stdout.write(formatStats(result.stats, meta));

    if (parsed.out !== undefined) {
      const target = path.resolve(parsed.out);
      await writeFileAtomic(target, buildDump(meta, result));
      stdout.write(`\nGraph written to ${target}\n`);
    }
    return EXIT_OK;
  } catch (error) {
    progress.finish();
    if (interrupted) {
      stderr.write("interrupted\n");
      return EXIT_SIGINT;
    }
    if (error instanceof AnalysisError) {
      stderr.write(`${error.code}: ${redact(error.message, token)}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`INTERNAL: ${redact(message, token)}\n`);
    }
    return EXIT_ANALYSIS;
  } finally {
    process.removeListener("SIGINT", onSigint);
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
