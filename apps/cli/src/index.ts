// Placeholder: the real pipeline arrives in M1. Usage: pnpm analyze <github-url> [--ref <ref>] [--out graph.json]
export function main(argv: string[]): number {
  if (argv.length === 0) {
    process.stderr.write("usage: pnpm analyze <github-url> [--ref <ref>] [--out graph.json]\n");
    return 1;
  }
  process.stderr.write("analyze is not implemented yet (see docs/ROADMAP.md, M1)\n");
  return 2;
}

process.exitCode = main(process.argv.slice(2));
