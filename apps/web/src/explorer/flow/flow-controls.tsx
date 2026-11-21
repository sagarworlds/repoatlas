import { CONFIDENCES } from "@repoatlas/schema";
import type { Confidence } from "../../api/types.ts";

const DEPTHS = [0, 1, 2, 3, 4] as const;

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  "name-match": "All (including name matches)",
  inferred: "Inferred or better",
  exact: "Exact only",
};

interface FlowControlsProps {
  up: number;
  down: number;
  conf: Confidence;
  onChange: (patch: { up?: number; down?: number; conf?: Confidence }) => void;
}

const SELECT = "h-8 rounded-md border border-line-strong bg-surface px-2 text-sm";

export function FlowControls({ up, down, conf, onChange }: FlowControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-3 py-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted">Callers depth</span>
        <select
          className={SELECT}
          value={up}
          onChange={(e) => onChange({ up: Number.parseInt(e.target.value, 10) })}
        >
          {DEPTHS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-muted">Callees depth</span>
        <select
          className={SELECT}
          value={down}
          onChange={(e) => onChange({ down: Number.parseInt(e.target.value, 10) })}
        >
          {DEPTHS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-muted">Min confidence</span>
        <select
          className={SELECT}
          value={conf}
          onChange={(e) => {
            // The option values come from CONFIDENCES, so this lookup always succeeds.
            const picked = CONFIDENCES.find((c) => c === e.target.value);
            if (picked) onChange({ conf: picked });
          }}
        >
          {CONFIDENCES.map((c) => (
            <option key={c} value={c}>
              {CONFIDENCE_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <span className="text-xs text-muted" aria-hidden="true">
        Dashed edges are name matches (least certain).
      </span>
    </div>
  );
}
