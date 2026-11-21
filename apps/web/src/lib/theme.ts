import { readStorage, writeStorage } from "./storage.ts";

export type ThemeChoice = "light" | "dark" | "system";

/** Keep in sync with public/theme-init.js. */
export const THEME_STORAGE_KEY = "repoatlas.theme";

export function readTheme(): ThemeChoice {
  const saved = readStorage(THEME_STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

/** Applies the choice to <html> (class strategy) and optionally persists it. */
export function applyTheme(choice: ThemeChoice, persist = true): void {
  const dark = choice === "dark" || (choice === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  if (persist) writeStorage(THEME_STORAGE_KEY, choice);
}

export function isDarkNow(): boolean {
  return document.documentElement.classList.contains("dark");
}
