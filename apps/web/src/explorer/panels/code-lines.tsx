import clsx from "clsx";
import { useEffect, useRef } from "react";
import type { CodeLine, CodeToken } from "../../lib/shiki.ts";
import { gutterWidth, isInSpan } from "./code-model.ts";

function tokenStyle(token: CodeToken) {
  const style: Record<string, string> = {};
  if (token.color) style.color = token.color;
  if (token.bold) style.fontWeight = "700";
  if (token.italic) style.fontStyle = "italic";
  if (token.underline) style.textDecoration = "underline";
  return style;
}

export interface CodeLinesProps {
  lines: CodeLine[];
  /** Real line number of the first entry of `lines`. */
  firstLine: number;
  selStart: number | undefined;
  selEnd: number | undefined;
  /** Call-site line, emphasised more strongly than the selected span. */
  callSiteLine: number | undefined;
  /** Line to scroll to when the shown code changes. */
  scrollLine: number | undefined;
  /** Changes whenever different code is shown, so the scroll runs again. */
  scrollKey: string;
}

/**
 * The code as numbered rows. Every token is a React <span> with its text as a child, so
 * source text is escaped by React and no HTML string is ever injected.
 * Selected lines get a tinted background plus a bar, the call site a stronger bar and a
 * marker, so colour is never the only signal.
 */
export function CodeLines(props: CodeLinesProps) {
  const { lines, firstLine, selStart, selEnd, callSiteLine, scrollLine, scrollKey } = props;
  const container = useRef<HTMLDivElement>(null);
  const width = gutterWidth(firstLine + lines.length - 1);

  // Scroll the target line to the middle of the panel when other code is shown. Only the
  // panel itself scrolls (not the page), hence we set scrollTop instead of scrollIntoView.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollKey is the trigger on purpose
  useEffect(() => {
    const root = container.current;
    if (!root || scrollLine === undefined) return;
    const row = root.querySelector<HTMLElement>(`[data-line="${scrollLine}"]`);
    if (!row) return;
    root.scrollTop = Math.max(0, row.offsetTop - root.clientHeight / 2 + row.offsetHeight / 2);
  }, [scrollKey, scrollLine]);

  return (
    <section
      ref={container}
      // A scrollable region must be keyboard reachable.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable code region
      tabIndex={0}
      aria-label="Source code"
      data-testid="code-lines"
      className="relative min-h-0 flex-1 overflow-auto bg-surface font-mono text-xs leading-5"
    >
      <div className="min-w-max py-1">
        {lines.map((tokens, index) => {
          const number = firstLine + index;
          const isCallSite = number === callSiteLine;
          const selected = isInSpan(number, selStart, selEnd);
          return (
            <div
              key={number}
              data-line={number}
              data-selected={selected ? "true" : undefined}
              data-callsite={isCallSite ? "true" : undefined}
              title={isCallSite ? "Call site" : undefined}
              className={clsx(
                "flex border-l-[3px]",
                isCallSite
                  ? "border-warn bg-warn-soft"
                  : selected
                    ? "border-accent bg-accent-soft/60"
                    : "border-transparent",
              )}
            >
              <span
                aria-hidden="true"
                className="shrink-0 select-none pr-3 pl-2 text-right text-muted tabular-nums"
                style={{ minWidth: `${width + 2}ch` }}
              >
                {number}
              </span>
              <span className="whitespace-pre pr-4">
                {tokens.length === 0
                  ? "​"
                  : tokens.map((token, i) => (
                      // Tokens never reorder, so the index is a stable key.
                      // biome-ignore lint/suspicious/noArrayIndexKey: static list
                      <span key={i} style={tokenStyle(token)}>
                        {token.text}
                      </span>
                    ))}
              </span>
              {isCallSite && <span className="sr-only">Call site</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
