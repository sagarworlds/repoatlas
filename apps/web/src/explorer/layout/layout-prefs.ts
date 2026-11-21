import { readStorage, writeStorage } from "../../lib/storage.ts";

export const LAYOUT_STORAGE_KEY = "repoatlas.layout";

export const CODE_HEIGHT_MIN = 120;
export const CODE_HEIGHT_DEFAULT = 260;
export const COLLAPSED_STRIP_HEIGHT = 36;

export interface LayoutPrefs {
  /** Height in px of the code panel when expanded. */
  codeHeight: number;
  codeOpen: boolean;
  treeOpen: boolean;
}

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = {
  codeHeight: CODE_HEIGHT_DEFAULT,
  codeOpen: true,
  treeOpen: true,
};

/** Keeps a size inside [min, max] (max is never allowed to be smaller than min). */
export function clampSize(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Reads the saved layout; anything missing or invalid falls back to the defaults. */
export function readLayoutPrefs(): LayoutPrefs {
  const raw = readStorage(LAYOUT_STORAGE_KEY);
  if (raw === null) return { ...DEFAULT_LAYOUT_PREFS };
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return { ...DEFAULT_LAYOUT_PREFS };
    const v = data as Record<string, unknown>;
    return {
      codeHeight:
        typeof v.codeHeight === "number" && Number.isFinite(v.codeHeight)
          ? Math.max(CODE_HEIGHT_MIN, Math.round(v.codeHeight))
          : DEFAULT_LAYOUT_PREFS.codeHeight,
      codeOpen: typeof v.codeOpen === "boolean" ? v.codeOpen : DEFAULT_LAYOUT_PREFS.codeOpen,
      treeOpen: typeof v.treeOpen === "boolean" ? v.treeOpen : DEFAULT_LAYOUT_PREFS.treeOpen,
    };
  } catch {
    return { ...DEFAULT_LAYOUT_PREFS };
  }
}

export function writeLayoutPrefs(prefs: LayoutPrefs): void {
  writeStorage(LAYOUT_STORAGE_KEY, JSON.stringify(prefs));
}
