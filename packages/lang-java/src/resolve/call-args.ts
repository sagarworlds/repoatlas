import type { FileExtraction, RawReference } from "@repoatlas/schema";
import { callArgsKey } from "../spec/arg-types.ts";

/** Per-reference facts the extractor stored as file meta, keyed by line, name and ordinal. */
export interface CallFactsByRef {
  args: Map<RawReference, string[]>;
  anonSupers: Map<RawReference, string[]>;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((t) => (typeof t === "string" ? t : "?"));
}

/**
 * Pairs `java.callArgs` and `java.anonSupers` with the references they describe. The
 * extractor keyed each entry by line, callee name and the n-th such call on that line; here
 * the references are counted the same way (calls and instantiations that have an argument list).
 */
export function assignCallFacts(extraction: FileExtraction): CallFactsByRef {
  const result: CallFactsByRef = { args: new Map(), anonSupers: new Map() };
  const metaTable = (name: string): Record<string, unknown> => {
    const value = extraction.meta?.[name];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  const args = metaTable("java.callArgs");
  const supers = metaTable("java.anonSupers");
  if (Object.keys(args).length === 0 && Object.keys(supers).length === 0) return result;
  const counts = new Map<string, number>();
  for (const ref of extraction.references) {
    if (ref.argCount === undefined) continue;
    if (ref.kind !== "call" && ref.kind !== "instantiate") continue;
    const base = `${ref.line}:${ref.name}`;
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    const key = callArgsKey(ref.line, ref.name, ordinal);
    const types = stringArray(args[key]);
    if (types !== undefined && types.length === ref.argCount) result.args.set(ref, types);
    const anon = stringArray(supers[key]);
    if (anon !== undefined) result.anonSupers.set(ref, anon);
  }
  return result;
}

/** Names of the local classes of a file (`java.localTypes`). */
export function localTypesOf(extraction: FileExtraction): Set<string> {
  const value = extraction.meta?.["java.localTypes"];
  return new Set(
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
  );
}
