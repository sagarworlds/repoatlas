import clsx from "clsx";
import { LANGUAGE_INFO } from "../config/languages.ts";

/** Supported languages in full colour, planned ones muted with "soon" (text, not only colour). */
export function LanguageChips() {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Languages">
      {LANGUAGE_INFO.map((lang) => (
        <li
          key={lang.id}
          title={lang.supported ? undefined : `${lang.name}: coming soon`}
          className={clsx(
            "rounded-full border px-2.5 py-0.5 text-xs",
            lang.supported
              ? "border-accent bg-accent-soft font-medium text-accent-strong"
              : "border-line text-muted",
          )}
        >
          {lang.name}
          {!lang.supported && <span className="ml-1 opacity-80">(soon)</span>}
        </li>
      ))}
    </ul>
  );
}
