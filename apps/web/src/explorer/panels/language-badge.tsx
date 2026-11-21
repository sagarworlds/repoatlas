import clsx from "clsx";

// A short text badge per language id (the id comes from the graph data). The text is the
// signal; the hue only helps scanning, so it works in grayscale too.
const BADGES: Record<string, { label: string; className: string }> = {
  typescript: {
    label: "TS",
    className: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  },
  javascript: {
    label: "JS",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  python: {
    label: "PY",
    className: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  },
  go: { label: "GO", className: "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200" },
  java: {
    label: "JV",
    className: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  },
  kotlin: {
    label: "KT",
    className: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
  csharp: {
    label: "C#",
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  },
  rust: { label: "RS", className: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200" },
  php: {
    label: "PHP",
    className: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  },
  ruby: { label: "RB", className: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200" },
  c: { label: "C", className: "bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200" },
  cpp: {
    label: "C++",
    className: "bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
  },
};

const UNKNOWN = { label: "·", className: "bg-surface-2 text-muted" };

export function languageBadgeLabel(language: string | undefined): string {
  return (language !== undefined ? BADGES[language] : undefined)?.label ?? UNKNOWN.label;
}

export function LanguageBadge(props: { language: string | undefined }) {
  const badge = (props.language !== undefined ? BADGES[props.language] : undefined) ?? UNKNOWN;
  return (
    <span
      title={props.language ?? "unknown language"}
      aria-hidden="true"
      className={clsx(
        "inline-flex h-4 min-w-6 shrink-0 items-center justify-center rounded px-1 font-mono text-[9px] font-bold leading-none",
        badge.className,
      )}
    >
      {badge.label}
    </span>
  );
}
