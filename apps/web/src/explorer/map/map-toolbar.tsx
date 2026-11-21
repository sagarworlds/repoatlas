import clsx from "clsx";
import type { Confidence, EdgeKind, GraphLevel } from "../../api/types.ts";

export const LEVELS: readonly { value: GraphLevel; label: string }[] = [
  { value: "dir", label: "Folders" },
  { value: "file", label: "Files" },
  { value: "symbol", label: "Symbols" },
];

/** Edge kinds offered in the toolbar. Only imports/calls exist at folder and file level. */
export const TOOLBAR_EDGE_KINDS: readonly EdgeKind[] = [
  "imports",
  "calls",
  "extends",
  "implements",
  "references",
];

const CONFIDENCE_OPTIONS: readonly { value: Confidence; label: string }[] = [
  { value: "name-match", label: "Any (incl. name matches)" },
  { value: "inferred", label: "Inferred or better" },
  { value: "exact", label: "Exact only" },
];

export interface MapToolbarValues {
  level: GraphLevel;
  kinds: EdgeKind[];
  conf: Confidence;
  tests: boolean;
  ext: boolean;
  depth: number;
}

export interface MapToolbarProps {
  values: MapToolbarValues;
  onChange: (patch: Partial<MapToolbarValues>) => void;
  highlightTop: boolean;
  onToggleHighlightTop: () => void;
  onFit: () => void;
  onExportPng: () => void;
  listOpen: boolean;
  onToggleList: () => void;
  /** Disables canvas-only actions (fit, export) while no canvas exists. */
  canvasReady: boolean;
}

const buttonClass =
  "h-8 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";
const toggledClass = "border-accent bg-accent-soft";

export function MapToolbar(props: MapToolbarProps) {
  const { values, onChange } = props;
  const symbolLevel = values.level === "symbol";

  function toggleKind(kind: EdgeKind) {
    const has = values.kinds.includes(kind);
    // At least one kind must stay selected (the URL parser would restore the defaults anyway).
    if (has && values.kinds.length === 1) return;
    onChange({ kinds: has ? values.kinds.filter((k) => k !== kind) : [...values.kinds, kind] });
  }

  return (
    <div
      role="toolbar"
      aria-label="Map controls"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-3 py-2 text-xs"
    >
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Level of detail</legend>
        <span aria-hidden="true" className="mr-1 text-muted">
          Level
        </span>
        {LEVELS.map((l) => (
          <button
            key={l.value}
            type="button"
            aria-pressed={values.level === l.value}
            onClick={() => onChange({ level: l.value })}
            className={clsx(buttonClass, values.level === l.value && toggledClass)}
          >
            {l.label}
          </button>
        ))}
      </fieldset>

      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Edge kinds</legend>
        <span aria-hidden="true" className="mr-1 text-muted">
          Edges
        </span>
        {TOOLBAR_EDGE_KINDS.map((kind) => {
          const folderOrFile = !symbolLevel && kind !== "imports" && kind !== "calls";
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={values.kinds.includes(kind)}
              disabled={folderOrFile}
              title={folderOrFile ? "Only shown at symbol level" : undefined}
              onClick={() => toggleKind(kind)}
              className={clsx(buttonClass, values.kinds.includes(kind) && toggledClass)}
            >
              {kind}
            </button>
          );
        })}
      </fieldset>

      <label className="flex items-center gap-1.5">
        <span className="text-muted">Confidence</span>
        <select
          value={values.conf}
          onChange={(e) => {
            const next = CONFIDENCE_OPTIONS.find((o) => o.value === e.target.value);
            if (next) onChange({ conf: next.value });
          }}
          className="h-8 rounded-md border border-line-strong bg-surface px-1.5 text-xs text-fg"
        >
          {CONFIDENCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5">
        <span className="text-muted">Depth</span>
        <select
          value={values.depth}
          onChange={(e) => onChange({ depth: Number.parseInt(e.target.value, 10) })}
          className="h-8 rounded-md border border-line-strong bg-surface px-1.5 text-xs text-fg"
        >
          {[1, 2, 3, 4, 5].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={values.tests}
          onChange={(e) => onChange({ tests: e.target.checked })}
        />
        Include tests
      </label>

      <label
        className={clsx("flex items-center gap-1.5", values.level === "dir" && "opacity-50")}
        title={
          values.level === "dir" ? "External packages appear at file and symbol level" : undefined
        }
      >
        <input
          type="checkbox"
          checked={values.ext}
          disabled={values.level === "dir"}
          onChange={(e) => onChange({ ext: e.target.checked })}
        />
        Include external
      </label>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          aria-pressed={props.highlightTop}
          onClick={props.onToggleHighlightTop}
          className={clsx(buttonClass, props.highlightTop && toggledClass)}
        >
          Highlight most connected
        </button>
        <button
          type="button"
          onClick={props.onFit}
          disabled={!props.canvasReady}
          className={buttonClass}
        >
          Fit
        </button>
        <button
          type="button"
          onClick={props.onExportPng}
          disabled={!props.canvasReady}
          className={buttonClass}
        >
          Export PNG
        </button>
        <button
          type="button"
          aria-expanded={props.listOpen}
          aria-controls="map-node-list"
          onClick={props.onToggleList}
          className={clsx(buttonClass, props.listOpen && toggledClass)}
        >
          List of nodes
        </button>
      </div>
    </div>
  );
}
