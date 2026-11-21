import type { GraphLevel } from "../../api/types.ts";
import { isExpandable, type MapNode } from "./graph-model.ts";
import { MapBreadcrumb } from "./map-breadcrumb.tsx";

export interface MapStatusBarProps {
  rootId: string;
  repoLabel: string;
  level: GraphLevel;
  nodeCount: number;
  edgeCount: number;
  /** The selected node when it is part of the drawn graph. */
  selected: MapNode | undefined;
  expanding: string | undefined;
  onNavigate: (rootId: string) => void;
  onExpand: (id: string) => void;
  onFocus: (id: string) => void;
}

const actionClass =
  "h-7 rounded-md border border-line-strong bg-surface px-2 text-xs font-medium text-fg hover:bg-surface-2 disabled:opacity-50";

/** Breadcrumb on the left, counts and Expand/Focus actions for the selection on the right. */
export function MapStatusBar(props: MapStatusBarProps) {
  const { selected } = props;
  const canAct = selected !== undefined && isExpandable(selected, props.level);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-surface px-3 py-1.5 text-xs">
      <MapBreadcrumb
        rootId={props.rootId}
        repoLabel={props.repoLabel}
        onNavigate={props.onNavigate}
      />
      <div className="flex flex-wrap items-center gap-2">
        {canAct && selected && (
          <>
            <span className="max-w-48 truncate text-muted" title={selected.path || selected.label}>
              {selected.label}
            </span>
            <button
              type="button"
              className={actionClass}
              disabled={props.expanding !== undefined}
              onClick={() => props.onExpand(selected.id)}
            >
              {props.expanding === selected.id ? "Expanding…" : "Expand"}
            </button>
            <button
              type="button"
              className={actionClass}
              onClick={() => props.onFocus(selected.id)}
            >
              Focus
            </button>
          </>
        )}
        <span className="text-muted" aria-live="polite">
          {props.nodeCount} nodes &middot; {props.edgeCount} edges
        </span>
      </div>
    </div>
  );
}
