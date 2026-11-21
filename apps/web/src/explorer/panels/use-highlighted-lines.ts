import { useEffect, useMemo, useState } from "react";
import { type CodeLine, highlightCode, plainLines, type ThemeMode } from "../../lib/shiki.ts";

interface Highlighted {
  content: string;
  language: string | null;
  mode: ThemeMode;
  lines: CodeLine[];
}

/**
 * Lines of `content` as colour tokens. Plain (uncoloured) lines are returned immediately, and
 * the highlighted version replaces them once Shiki has loaded. An effect with a "cancelled"
 * flag drops results that arrive after the inputs changed (like cancelling a stale request).
 */
export function useHighlightedLines(
  content: string,
  language: string | null,
  mode: ThemeMode,
): CodeLine[] {
  const plain = useMemo(() => plainLines(content), [content]);
  const [highlighted, setHighlighted] = useState<Highlighted | null>(null);

  useEffect(() => {
    let cancelled = false;
    void highlightCode(content, language, mode).then((lines) => {
      if (!cancelled) setHighlighted({ content, language, mode, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [content, language, mode]);

  const current =
    highlighted?.content === content &&
    highlighted.language === language &&
    highlighted.mode === mode;
  return current && highlighted ? highlighted.lines : plain;
}
