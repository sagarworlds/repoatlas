import clsx from "clsx";
import { type FocusEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useSearch } from "../../api/hooks.ts";
import type { AnalysisRecordDto, GraphNode, NodeKind } from "../../api/types.ts";
import { ErrorState } from "../../components/error-state.tsx";
import { Spinner } from "../../components/spinner.tsx";
import { matchesSearchHotkey } from "../../lib/hotkeys.ts";
import { useExplorerParams } from "../url-state.ts";
import {
  KIND_FILTERS,
  moveIndex,
  navigationForNode,
  secondaryText,
  toggleKind,
} from "./search-navigation.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";

const DEBOUNCE_MS = 200;
const EMPTY_RESULTS: GraphNode[] = [];

/**
 * Search combobox (WAI-ARIA pattern): focus stays in the input, the highlighted result is
 * announced through `aria-activedescendant`. Opened by clicking, "/" or Ctrl/Cmd+K.
 */
export function SearchBox(props: { analysisId: string; analysis: AnalysisRecordDto }) {
  const { setParams } = useExplorerParams();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<NodeKind[]>([]);
  const [active, setActive] = useState(0);

  const trimmed = text.trim();
  const debounced = useDebouncedValue(trimmed, DEBOUNCE_MS);
  const query = useSearch(props.analysisId, debounced, kinds.length > 0 ? kinds : undefined);

  const hasQuery = debounced !== "";
  const results = hasQuery ? (query.data?.results ?? EMPTY_RESULTS) : EMPTY_RESULTS;
  // Waiting = the user typed something the request has not been sent for, or it is in flight.
  const waiting = trimmed !== "" && (trimmed !== debounced || query.isFetching);
  const failed = hasQuery && query.isError && !query.isFetching;

  // Start at the first result whenever the result list changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `results` is the trigger on purpose
  useEffect(() => setActive(0), [results]);

  // Global shortcuts. The listener lives on document; the matcher decides what is ours.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!matchesSearchHotkey(event)) return;
      event.preventDefault(); // only reached when we handle the key
      setOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function select(node: GraphNode) {
    setParams(navigationForNode(node), { push: true });
    setOpen(false);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        setActive((i) => moveIndex(i, event.key === "ArrowDown" ? 1 : -1, results.length));
        return;
      }
      case "Enter": {
        const node = results[active];
        if (open && node) {
          event.preventDefault();
          select(node);
        }
        return;
      }
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        return;
    }
  }

  // Close when focus leaves the whole widget (input + panel).
  function onBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !wrapperRef.current?.contains(next)) setOpen(false);
  }

  const activeId = open && results[active] ? `${listId}-opt-${active}` : undefined;
  const showList = results.length > 0 && !failed;

  return (
    <search ref={wrapperRef} onBlur={onBlur} className="relative" data-testid="search-box">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search symbols and files"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-keyshortcuts="/ Control+K Meta+K"
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        placeholder="Search (press / or Ctrl+K)"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onKeyDown={onInputKeyDown}
        className="h-8 w-full rounded-md border border-line-strong bg-bg px-3 text-sm placeholder:text-muted"
      />

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[min(34rem,calc(100vw-1.5rem))] rounded-md border border-line bg-surface shadow-lg">
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 border-b border-line p-2">
            <legend className="sr-only">Filter by kind</legend>
            {KIND_FILTERS.map((f) => {
              const on = kinds.includes(f.kind);
              return (
                <button
                  key={f.kind}
                  type="button"
                  aria-pressed={on}
                  // Keep keyboard focus in the input while clicking a chip.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setKinds((k) => toggleKind(k, f.kind))}
                  className={clsx(
                    "h-7 rounded-full border px-2.5 text-xs",
                    on
                      ? "border-accent bg-accent-soft font-semibold text-fg"
                      : "border-line text-muted hover:bg-surface-2",
                  )}
                >
                  {on && <span aria-hidden="true">{"✓ "}</span>}
                  {f.label}
                </button>
              );
            })}
          </fieldset>

          <div className="max-h-80 overflow-auto">
            {trimmed === "" && (
              <p className="p-3 text-sm text-muted">
                Type to search functions, classes and files by name.
              </p>
            )}
            {failed && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
            {trimmed !== "" && waiting && results.length === 0 && !failed && (
              <div className="p-3">
                <Spinner label="Searching" />
              </div>
            )}
            {hasQuery && !waiting && !failed && results.length === 0 && (
              <p className="p-3 text-sm text-muted" role="status">
                {`No matches for "${debounced}".`}
              </p>
            )}
            <div
              id={listId}
              role="listbox"
              aria-label="Search results"
              className={clsx(!showList && "hidden")}
            >
              {results.map((node, index) => (
                <ResultRow
                  key={node.id}
                  id={`${listId}-opt-${index}`}
                  node={node}
                  active={index === active}
                  onHover={() => setActive(index)}
                  onSelect={() => select(node)}
                />
              ))}
            </div>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {showList ? `${results.length} results` : ""}
          </p>
        </div>
      )}
    </search>
  );
}

function ResultRow(props: {
  id: string;
  node: GraphNode;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { node } = props;
  return (
    // Options are operated through the input's keyboard handling (aria-activedescendant);
    // the mouse handlers are an extra.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled on the combobox input
    <div
      id={props.id}
      role="option"
      tabIndex={-1}
      aria-selected={props.active}
      // mousedown would blur the input before the click lands, so keep focus.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={props.onHover}
      onClick={props.onSelect}
      className={clsx(
        "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
        props.active && "bg-accent-soft",
      )}
    >
      <span className="w-16 shrink-0 rounded border border-line px-1 text-center text-xs text-muted">
        {node.kind}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{node.name}</span>
        <span className="block truncate text-xs text-muted">{secondaryText(node)}</span>
      </span>
      {node.language && <span className="shrink-0 text-xs text-muted">{node.language}</span>}
    </div>
  );
}
