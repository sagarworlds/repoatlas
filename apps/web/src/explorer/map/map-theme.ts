// Cytoscape draws on a canvas and cannot read CSS variables, so the theme tokens from
// index.css are resolved to plain colours here (and re-read when the theme changes).
import { useEffect, useState } from "react";
import { isDarkNow } from "../../lib/theme.ts";

export interface MapTheme {
  dark: boolean;
  fg: string;
  muted: string;
  surface: string;
  line: string;
  accent: string;
}

const FALLBACK_LIGHT: MapTheme = {
  dark: false,
  fg: "#1b2420",
  muted: "#5a665f",
  surface: "#ffffff",
  line: "#d8dcd2",
  accent: "#0f766e",
};
const FALLBACK_DARK: MapTheme = {
  dark: true,
  fg: "#e8eee9",
  muted: "#9aa8a0",
  surface: "#161d1a",
  line: "#2f3b36",
  accent: "#3fc1b0",
};

/** Builds a theme from a variable reader (injectable so it is testable without a DOM). */
export function themeFromReader(read: (name: string) => string, dark: boolean): MapTheme {
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const pick = (name: string, alt: string) => {
    const value = read(name).trim();
    return value !== "" ? value : alt;
  };
  return {
    dark,
    fg: pick("--fg", fallback.fg),
    muted: pick("--muted", fallback.muted),
    surface: pick("--surface", fallback.surface),
    line: pick("--line", fallback.line),
    accent: pick("--accent", fallback.accent),
  };
}

export function readMapTheme(): MapTheme {
  const dark = isDarkNow();
  const style = getComputedStyle(document.documentElement);
  return themeFromReader((name) => style.getPropertyValue(name), dark);
}

/** True while <html> has the `dark` class; follows the theme toggle and the OS setting. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(isDarkNow);
  // Effect: subscribe to class changes on <html>; the cleanup function unsubscribes
  // (like implementing IDisposable for an event subscription).
  useEffect(() => {
    const update = () => setDark(isDarkNow());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
