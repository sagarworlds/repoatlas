import clsx from "clsx";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNodeDetail, useSource } from "../../api/hooks.ts";
import type { AnalysisRecordDto, SourceResponse } from "../../api/types.ts";
import { trapTab } from "../../components/drawer.tsx";
import { Spinner } from "../../components/spinner.tsx";
import { describeError } from "../../lib/error-text.ts";
import { decodeHighlight, useExplorerParams } from "../url-state.ts";
import { CodeLines } from "./code-lines.tsx";
import {
  callSiteLineIn,
  computeTarget,
  githubUrlForSource,
  looksBinary,
  rangeLabel,
  scrollTargetLine,
  truncationNotice,
} from "./code-model.ts";
import { useCopy } from "./use-copy.ts";
import { useIsDark } from "./use-dark.ts";
import { useHighlightedLines } from "./use-highlighted-lines.ts";

const BUTTON =
  "h-7 rounded-md border border-line-strong px-2 text-xs hover:bg-surface-2 disabled:opacity-50";

function Notice(props: { title: string; children?: string; tone?: "warn" }) {
  return (
    <div
      role={props.tone === "warn" ? "note" : "status"}
      className="space-y-1 p-4 text-sm"
      data-testid="code-notice"
    >
      <p className="font-semibold">{props.title}</p>
      {props.children && <p className="text-muted">{props.children}</p>}
    </div>
  );
}

/** Highlighted source of one successful response. Split out so hooks run only with data. */
function SourceView(props: {
  source: SourceResponse;
  selStart: number | undefined;
  selEnd: number | undefined;
  callSiteLine: number | undefined;
  notice: string | undefined;
}) {
  const { source } = props;
  const dark = useIsDark();
  const lines = useHighlightedLines(source.content, source.language, dark ? "dark" : "light");
  const scrollLine = scrollTargetLine(props.callSiteLine, props.selStart);

  return (
    <>
      {props.notice && (
        <p role="note" className="border-b border-line bg-warn-soft px-3 py-1.5 text-xs text-warn">
          {props.notice}
        </p>
      )}
      <CodeLines
        lines={lines}
        firstLine={source.startLine}
        selStart={props.selStart}
        selEnd={props.selEnd}
        callSiteLine={props.callSiteLine}
        scrollLine={scrollLine}
        scrollKey={`${source.file}:${source.startLine}-${source.endLine}:${props.callSiteLine ?? ""}`}
      />
    </>
  );
}

/**
 * Source of the selected node (its span plus context, or the whole file), highlighted with
 * Shiki. Shows the call site from the `hl` URL parameter when it is in the loaded file.
 */
export function CodePanel(props: {
  analysisId: string;
  analysis: AnalysisRecordDto;
  onClose?: () => void;
}) {
  const { analysisId, analysis, onClose } = props;
  const { params } = useExplorerParams();
  const detail = useNodeDetail(analysisId, params.node);
  const callSite = useMemo(() => decodeHighlight(params.hl), [params.hl]);
  const node = detail.data?.node;
  const target = useMemo(
    () => (node ? computeTarget(node, callSite) : undefined),
    [node, callSite],
  );
  const source = useSource(analysisId, target?.file, target?.start, target?.end);
  const { message, copy } = useCopy();

  const [full, setFull] = useState(false);
  const wrapper = useRef<HTMLElement>(null);
  const fullButton = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);

  // Give focus back to the full-screen button when leaving full screen.
  useEffect(() => {
    if (wasFull.current && !full) fullButton.current?.focus();
    wasFull.current = full;
  }, [full]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!full) return;
    if (event.key === "Escape") {
      event.stopPropagation(); // do not also close an enclosing sheet
      setFull(false);
    } else if (wrapper.current) {
      trapTab(event, wrapper.current);
    }
  }

  const data = source.data;
  const callSiteLine = data ? callSiteLineIn(callSite, data) : undefined;
  const githubFrom = callSiteLine ?? target?.selStart;
  const githubTo = callSiteLine !== undefined ? undefined : target?.selEnd;
  const github = target
    ? githubUrlForSource(analysis, target.file, githubFrom, githubTo)
    : undefined;
  const binary = data !== undefined && looksBinary(data.content);

  let body: React.ReactNode;
  if (params.node === undefined) {
    body = (
      <Notice title="No code to show">Select a file or a function to see its source here.</Notice>
    );
  } else if (detail.isPending) {
    body = (
      <div className="p-4">
        <Spinner label="Loading" />
      </div>
    );
  } else if (detail.isError || !node) {
    body = <PanelError error={detail.error} onRetry={() => void detail.refetch()} />;
  } else if (!target) {
    body = (
      <Notice title="This item has no source file">
        Directories, packages and the repository itself have no code of their own.
      </Notice>
    );
  } else if (source.isPending) {
    body = (
      <div className="p-4">
        <Spinner label="Loading source" />
      </div>
    );
  } else if (source.isError || !data) {
    body = <PanelError error={source.error} onRetry={() => void source.refetch()} />;
  } else if (binary) {
    body = (
      <Notice title="Binary file" tone="warn">
        This file does not look like text, so its content is not shown.
      </Notice>
    );
  } else if (data.totalLines === 0) {
    body = <Notice title="This file is empty" />;
  } else {
    body = (
      <SourceView
        source={data}
        selStart={target.selStart}
        selEnd={target.selEnd}
        callSiteLine={callSiteLine}
        notice={truncationNotice(data, target)}
      />
    );
  }

  const canCopy = data !== undefined && !binary && data.totalLines > 0;

  return (
    <section
      ref={wrapper}
      aria-label="Code"
      data-testid="code-panel"
      data-fullscreen={full ? "true" : undefined}
      {...(full ? { role: "dialog", "aria-modal": true } : {})}
      onKeyDown={onKeyDown}
      className={clsx("flex min-h-0 flex-col bg-surface", full ? "fixed inset-0 z-50" : "h-full")}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-semibold" title={target?.file}>
            {target?.file ?? "Code"}
          </p>
          {data && (
            <p className="text-[11px] text-muted">
              {rangeLabel(data)}
              {data.language ? ` · ${data.language}` : ""}
            </p>
          )}
        </div>
        <span role="status" aria-live="polite" className="text-xs text-muted">
          {message}
        </span>
        <button
          type="button"
          className={BUTTON}
          disabled={!canCopy}
          onClick={() => data && void copy(data.content)}
        >
          Copy
        </button>
        {github !== undefined && (
          <a
            href={github}
            target="_blank"
            rel="noopener noreferrer"
            className={clsx(BUTTON, "inline-flex items-center")}
          >
            Open on GitHub
          </a>
        )}
        <button
          ref={fullButton}
          type="button"
          className={BUTTON}
          aria-pressed={full}
          onClick={() => setFull((value) => !value)}
        >
          {full ? "Exit full screen" : "Full screen"}
        </button>
        {onClose && (
          <button type="button" className={BUTTON} onClick={onClose}>
            Close
          </button>
        )}
      </header>
      {body}
    </section>
  );
}

function PanelError(props: { error: unknown; onRetry: () => void }) {
  const code = (props.error as { code?: unknown } | null)?.code;
  if (code === "FILE_NOT_FOUND") {
    return (
      <Notice title="Source not available" tone="warn">
        The file is missing from the analysis, is binary, or is larger than 1 MB.
      </Notice>
    );
  }
  const { title, message } = describeError(props.error);
  return (
    <div role="alert" className="space-y-2 p-4 text-sm">
      <p className="font-semibold text-danger">{title}</p>
      <p className="text-muted">{message}</p>
      <button type="button" className={BUTTON} onClick={props.onRetry}>
        Try again
      </button>
    </div>
  );
}
