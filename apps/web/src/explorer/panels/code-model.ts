// Pure helpers for the code panel (no React, no network), so they are easy to unit test.
import type { AnalysisRecordDto, GraphNode, SourceResponse } from "../../api/types.ts";
import { buildGithubBlobUrl } from "../../lib/github.ts";

/** Extra lines shown above and below a symbol. */
export const CONTEXT_LINES = 5;

/** Most lines requested at once; keeps rendering and highlighting fast. */
export const MAX_LINES = 2000;

/** What to load and what to emphasise. All line numbers are 1-based and inclusive. */
export interface CodeTarget {
  file: string;
  start: number;
  end: number;
  /** The span of the selected symbol (undefined when a whole file is shown). */
  selStart: number | undefined;
  selEnd: number | undefined;
  /** True when the whole file was asked for (a file node), so a cut-off deserves a notice. */
  wholeFile: boolean;
}

/** A call-site highlight from the `hl` URL parameter ("path@line"), already decoded. */
export interface CallSite {
  file: string;
  line: number;
}

/**
 * Decides which lines to request for the selected node. A symbol gets its span plus context;
 * a file (or a node without a span) gets the file from line 1. A call site in the same file
 * is always included in the range, so it can be scrolled to.
 * Returns undefined for nodes without a file (directories, packages, the repository).
 */
export function computeTarget(
  node: GraphNode,
  callSite: CallSite | undefined,
): CodeTarget | undefined {
  const file = node.file;
  if (file === undefined) return undefined;
  const hlLine = callSite !== undefined && callSite.file === file ? callSite.line : undefined;
  const span = node.kind === "file" ? undefined : node.span;

  if (span === undefined) {
    // Whole file; if the call site is far below the cap, start the window near it instead.
    const start =
      hlLine !== undefined && hlLine > MAX_LINES ? hlLine - Math.floor(MAX_LINES / 2) : 1;
    return {
      file,
      start,
      end: start + MAX_LINES - 1,
      selStart: undefined,
      selEnd: undefined,
      wholeFile: true,
    };
  }

  let start = Math.max(1, span.startLine - CONTEXT_LINES);
  let end = span.endLine + CONTEXT_LINES;
  if (hlLine !== undefined) {
    start = Math.min(start, Math.max(1, hlLine - CONTEXT_LINES));
    end = Math.max(end, hlLine + CONTEXT_LINES);
  }
  end = Math.min(end, start + MAX_LINES - 1);
  return {
    file,
    start,
    end,
    selStart: span.startLine,
    selEnd: span.endLine,
    wholeFile: false,
  };
}

/**
 * The call-site line to highlight in the loaded source: only when it refers to the loaded
 * file and lies inside the loaded lines. Anything else is ignored.
 */
export function callSiteLineIn(
  callSite: CallSite | undefined,
  source: Pick<SourceResponse, "file" | "startLine" | "endLine">,
): number | undefined {
  if (callSite === undefined || callSite.file !== source.file) return undefined;
  return callSite.line >= source.startLine && callSite.line <= source.endLine
    ? callSite.line
    : undefined;
}

/** Line to scroll to after loading: the call site first, else the start of the selected span. */
export function scrollTargetLine(
  hlLine: number | undefined,
  selStart: number | undefined,
): number | undefined {
  return hlLine ?? selStart;
}

export function isInSpan(line: number, selStart: number | undefined, selEnd: number | undefined) {
  return selStart !== undefined && selEnd !== undefined && line >= selStart && line <= selEnd;
}

/** Notice for a whole-file view that the API or our cap cut short; undefined otherwise. */
export function truncationNotice(source: SourceResponse, target: CodeTarget): string | undefined {
  if (!target.wholeFile) return undefined;
  const cutBelow = source.endLine < source.totalLines;
  const cutAbove = source.startLine > 1;
  if (!cutBelow && !cutAbove) return undefined;
  return `Showing lines ${source.startLine}–${source.endLine} of ${source.totalLines}. Open the file on GitHub to see the rest.`;
}

/** Text that is not source code (contains NUL bytes) is shown as a binary-file notice. */
export function looksBinary(content: string): boolean {
  return content.includes("\0");
}

/** "Lines 12–40 of 412" for the panel header. */
export function rangeLabel(source: SourceResponse): string {
  if (source.totalLines === 0) return "empty file";
  return `lines ${source.startLine}–${source.endLine} of ${source.totalLines}`;
}

/** GitHub link for the shown code: the call-site line if there is one, else the selected span. */
export function githubUrlForSource(
  analysis: Pick<AnalysisRecordDto, "owner" | "repo" | "ref" | "commitSha">,
  file: string,
  fromLine: number | undefined,
  toLine: number | undefined,
): string {
  return buildGithubBlobUrl(
    analysis.owner,
    analysis.repo,
    analysis.commitSha ?? analysis.ref,
    file,
    fromLine,
    toLine,
  );
}

/** Digits needed for the line-number column. */
export function gutterWidth(lastLine: number): number {
  return Math.max(2, String(Math.max(1, lastLine)).length);
}
