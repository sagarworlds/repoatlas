/** Small helpers shared by the pipeline modules. */

/** Compares by UTF-16 code units (like C# string.CompareOrdinal), independent of locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Message of anything that was thrown (JS can throw non-Error values), capped in length. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/** Number of lines: "a\nb\n" is 2, "a\nb" is 2, "" is 0. */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
  return content.endsWith("\n") ? lines - 1 : lines;
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight and returns the results in
 * input order. (C# analogy: Parallel.ForEachAsync with MaxDegreeOfParallelism.)
 * The first rejection stops the pool from starting new work and is re-thrown.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
