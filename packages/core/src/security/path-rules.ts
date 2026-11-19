/**
 * Path rules for archive entries (SECURITY section 3). Pure functions, identical on every OS:
 * Windows-unsafe names are rejected even on Linux/macOS so results never depend on the host.
 */

export type PathRejection = "unsafe-path" | "reserved-name" | "path-too-long";

export type EntryPathCheck =
  | { ok: true; segments: string[] }
  | { ok: false; reason: PathRejection }
  /** The path is only the top-level wrapper folder (or empty): nothing to extract, not an error. */
  | { ok: "empty" };

const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// Control chars (including NUL) and the characters Windows forbids in file names.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;
const MAX_SEGMENT_LENGTH = 255;

/**
 * Validate a raw tar entry path and strip the top-level `{owner}-{repo}-{sha}/` folder.
 * Returns the remaining path segments, or why the entry must be skipped.
 */
export function checkEntryPath(rawPath: string): EntryPathCheck {
  // NUL, backslashes and other control characters are never legitimate in repo paths.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
  if (/[\u0000-\u001f\u007f\\]/.test(rawPath)) return { ok: false, reason: "unsafe-path" };
  // Absolute paths and Windows drive letters ("C:foo", "C:/foo").
  if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) {
    return { ok: false, reason: "unsafe-path" };
  }

  const raw = rawPath.split("/");
  if (raw.includes("..")) return { ok: false, reason: "unsafe-path" };

  // Drop empty segments ("a//b", trailing "/") and "." segments, then the top-level folder.
  const parts = raw.filter((s) => s !== "" && s !== ".");
  const segments = parts.slice(1);
  if (segments.length === 0) return { ok: "empty" };

  for (const segment of segments) {
    if (FORBIDDEN_CHARS.test(segment)) return { ok: false, reason: "unsafe-path" };
    if (segment.endsWith(".") || segment.endsWith(" ")) return { ok: false, reason: "unsafe-path" };
    if (RESERVED_DEVICE_NAME.test(segment)) return { ok: false, reason: "reserved-name" };
    if (segment.length > MAX_SEGMENT_LENGTH) return { ok: false, reason: "path-too-long" };
  }
  return { ok: true, segments };
}
