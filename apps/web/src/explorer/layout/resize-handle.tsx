import { type KeyboardEvent, type PointerEvent, useRef } from "react";

interface ResizeHandleProps {
  /** Current panel height in px. */
  value: number;
  min: number;
  max: number;
  onChange: (height: number) => void;
  label: string;
}

const KEY_STEP = 24;

/**
 * Horizontal drag handle above a bottom panel. Dragging up makes the panel taller.
 * Pointer events (not mouse events) cover mouse, touch and pen with one code path.
 */
export function ResizeHandle({ value, min, max, onChange, label }: ResizeHandleProps) {
  // useRef keeps a mutable value between renders without causing a re-render.
  const drag = useRef<{ startY: number; startValue: number } | null>(null);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    drag.current = { startY: event.clientY, startValue: value };
    // jsdom has no pointer capture, hence the optional call.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    const next = state.startValue + (state.startY - event.clientY);
    onChange(Math.min(Math.max(next, min), Math.max(min, max)));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp") onChange(Math.min(value + KEY_STEP, Math.max(min, max)));
    else if (event.key === "ArrowDown") onChange(Math.max(value - KEY_STEP, min));
    else return;
    event.preventDefault();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator needs a div (an hr cannot take focus or children)
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, Math.round(max))}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="group col-span-3 col-start-1 row-start-2 h-2 shrink-0 cursor-row-resize touch-none border-y border-line bg-surface-2 hover:bg-accent-soft"
    >
      <div className="mx-auto mt-[2px] h-0.5 w-10 rounded bg-muted group-hover:bg-accent" />
    </div>
  );
}
