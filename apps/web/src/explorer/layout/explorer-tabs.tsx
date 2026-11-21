import clsx from "clsx";
import { type KeyboardEvent, useRef } from "react";
import { type ExplorerTab, TABS, useExplorerParams } from "../url-state.ts";

export const TAB_LABELS: Record<ExplorerTab, string> = {
  map: "Map",
  flow: "Call flow",
  deps: "Dependencies",
};

/** Next tab for an arrow/Home/End key, or undefined for any other key. Pure, for tests. */
export function nextTab(current: ExplorerTab, key: string): ExplorerTab | undefined {
  const index = TABS.indexOf(current);
  let target: number;
  if (key === "ArrowRight") target = (index + 1) % TABS.length;
  else if (key === "ArrowLeft") target = (index - 1 + TABS.length) % TABS.length;
  else if (key === "Home") target = 0;
  else if (key === "End") target = TABS.length - 1;
  else return undefined;
  return TABS[target];
}

/**
 * WAI-ARIA tabs with a roving tabindex: only the selected tab is in the Tab order, the
 * arrow keys move between tabs (and select them, "automatic activation").
 */
export function ExplorerTabs() {
  const { params, setParams } = useExplorerParams();
  const refs = useRef<Partial<Record<ExplorerTab, HTMLButtonElement | null>>>({});

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: ExplorerTab) {
    const next = nextTab(tab, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setParams({ tab: next }, { push: true });
    refs.current[next]?.focus();
  }

  return (
    <div role="tablist" aria-label="Views" className="flex gap-1">
      {TABS.map((tab) => {
        const selected = params.tab === tab;
        return (
          <button
            key={tab}
            ref={(el) => {
              refs.current[tab] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${tab}`}
            aria-selected={selected}
            aria-controls="explorer-canvas"
            tabIndex={selected ? 0 : -1}
            onClick={() => setParams({ tab }, { push: true })}
            onKeyDown={(e) => onKeyDown(e, tab)}
            className={clsx(
              "h-8 rounded-md px-3 text-sm font-medium",
              selected
                ? "bg-accent text-accent-fg"
                : "border border-line-strong text-fg hover:bg-surface-2",
            )}
          >
            {TAB_LABELS[tab]}
          </button>
        );
      })}
    </div>
  );
}
