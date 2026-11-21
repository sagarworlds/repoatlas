import clsx from "clsx";
import { LANGUAGES } from "../config/examples.ts";

/** Supported languages in full colour, planned ones muted with "soon" (text, not only colour). */
export function LanguageChips() {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Supported languages">
      {LANGUAGES.map((lang) => (
        <li
          key={lang.id}
          className={clsx(
            "rounded-full border px-2.5 py-0.5 text-xs",
            lang.supported
              ? "border-accent bg-accent-soft font-medium text-accent-strong"
              : "border-line text-muted",
          )}
        >
          {lang.label}
          {!lang.supported && <span className="ml-1 opacity-80">(soon)</span>}
        </li>
      ))}
    </ul>
  );
}
