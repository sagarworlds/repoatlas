/** Minimal INI reader for `setup.cfg`. Never throws; unreadable input gives no sections. */

export type IniFile = Map<string, Map<string, string>>;

const MAX_INI_CHARS = 200_000;
const MAX_LINE_CHARS = 2_000;

/**
 * Sections map to key/value maps. A line that starts with whitespace continues the
 * previous value (joined with "\n"). Lines starting with `#` or `;` are comments.
 * Section and key names are lower-cased because setup.cfg treats them case-insensitively.
 */
export function parseIni(text: string): IniFile {
  const result: IniFile = new Map();
  if (text.length > MAX_INI_CHARS) return result;
  let section: Map<string, string> | undefined;
  let lastKey: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length > MAX_LINE_CHARS) continue; // not a real setup.cfg line
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header && !/^\s/.test(rawLine)) {
      section = new Map();
      result.set((header[1] ?? "").trim().toLowerCase(), section);
      lastKey = undefined;
      continue;
    }
    if (!section) continue;
    if (/^\s/.test(rawLine) && lastKey !== undefined) {
      section.set(lastKey, `${section.get(lastKey) ?? ""}\n${trimmed}`);
      continue;
    }
    // Linear scan (a regex with a lazy key and `\s*` backtracks quadratically on long lines).
    const sep = trimmed.search(/[=:]/);
    if (sep <= 0) continue;
    lastKey = trimmed.slice(0, sep).trim().toLowerCase();
    section.set(lastKey, trimmed.slice(sep + 1).trim());
  }
  return result;
}

/** Splits a multi-line value into its non-empty trimmed lines. */
export function iniLines(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
