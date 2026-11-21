import clsx from "clsx";
import { LanguageBadge } from "./language-badge.tsx";
import type { TreeRow } from "./tree-model.ts";

/** Number of parse errors recorded on a file node (0 when none). */
export function parseErrorCount(meta: Record<string, unknown> | undefined): number {
  const value = meta?.parseErrors;
  return typeof value === "number" && value > 0 ? value : 0;
}

function Chevron(props: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      className={clsx("shrink-0 text-muted transition-transform", props.open && "rotate-90")}
    >
      <path
        d="M4 2l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      className="shrink-0 text-accent"
    >
      <path
        d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.4 1.5h6.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
        fill="currentColor"
        opacity="0.75"
      />
    </svg>
  );
}

export interface TreeRowViewProps {
  row: TreeRow;
  selected: boolean;
  /** The one row that is in the tab order (roving tabindex). */
  tabbable: boolean;
  onActivate: (row: TreeRow) => void;
  onFocusRow: (id: string) => void;
  registerRef: (id: string, element: HTMLDivElement | null) => void;
}

/**
 * One row. The tree is a flat list of role="treeitem" rows that carry aria-level, which is
 * the accessible way to describe a hierarchy that is rendered flat.
 */
export function TreeRowView(props: TreeRowViewProps) {
  const { row, selected } = props;
  const { item } = row;
  const meta = item.node.meta;
  const isTest = meta?.isTest === true;
  const errors = parseErrorCount(meta);

  return (
    <div
      role="treeitem"
      tabIndex={props.tabbable ? 0 : -1}
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={item.isDir ? row.expanded : undefined}
      aria-selected={selected}
      data-tree-id={item.id}
      ref={(element) => props.registerRef(item.id, element)}
      onClick={() => props.onActivate(row)}
      onFocus={() => props.onFocusRow(item.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onActivate(row);
        }
      }}
      style={{ paddingLeft: `${row.depth * 14 + 6}px` }}
      title={item.path}
      className={clsx(
        "flex h-7 cursor-pointer select-none items-center gap-1.5 rounded pr-2 text-sm",
        selected ? "bg-accent-soft font-semibold text-accent-strong" : "hover:bg-surface-2",
      )}
    >
      {item.isDir ? (
        <>
          <Chevron open={row.expanded} />
          <FolderIcon />
        </>
      ) : (
        <>
          <span className="w-3 shrink-0" aria-hidden="true" />
          <LanguageBadge language={item.node.language} />
        </>
      )}
      <span className={clsx("min-w-0 flex-1 truncate", isTest && "italic")}>{item.name}</span>
      {isTest && (
        <span className="shrink-0 rounded border border-line px-1 text-[10px] uppercase text-muted">
          test
        </span>
      )}
      {errors > 0 && (
        <span
          className="shrink-0 rounded bg-warn-soft px-1 text-[10px] font-bold text-warn"
          title={`${errors} parse ${errors === 1 ? "error" : "errors"}`}
        >
          <span aria-hidden="true">!</span>
          <span className="sr-only">
            {errors} parse {errors === 1 ? "error" : "errors"}
          </span>
        </span>
      )}
    </div>
  );
}
