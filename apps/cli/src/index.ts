// CLI entry point: pnpm analyze <github-url> [--ref <ref>] [--out graph.json] [--local <dir>]
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2));
