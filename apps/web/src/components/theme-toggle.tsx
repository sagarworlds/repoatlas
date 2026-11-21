import { useState } from "react";
import { applyTheme, isDarkNow } from "../lib/theme.ts";

/** Switches between light and dark. The first state follows the class set at page load. */
export function ThemeToggle() {
  // useState(() => ...) runs the initializer once, like a constructor.
  const [dark, setDark] = useState<boolean>(() => isDarkNow());

  function toggle() {
    const next = !dark;
    applyTheme(next ? "dark" : "light");
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label="Dark theme"
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-sm text-fg hover:bg-surface-2"
    >
      <span aria-hidden="true">{dark ? "☾" : "☀"}</span>
      <span>{dark ? "Dark" : "Light"}</span>
    </button>
  );
}
