import type { ReactNode } from "react";

const primaryButton =
  "h-8 rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg hover:bg-accent-strong";

/** Centered message drawn over the canvas area. */
function Overlay(props: { children: ReactNode; role?: "status" | "alert" }) {
  return (
    <div
      role={props.role}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg/80 p-6 text-center text-sm"
    >
      {props.children}
    </div>
  );
}

export function LoadingOverlay() {
  return (
    <Overlay role="status">
      <span className="text-muted">Loading map&hellip;</span>
    </Overlay>
  );
}

export function ErrorOverlay(props: { title: string; message: string; onRetry: () => void }) {
  return (
    <Overlay role="alert">
      <p className="font-semibold">{props.title}</p>
      <p className="max-w-md text-muted">{props.message}</p>
      <button type="button" className={primaryButton} onClick={props.onRetry}>
        Try again
      </button>
    </Overlay>
  );
}

export function EmptyOverlay() {
  return (
    <Overlay role="status">
      <p className="font-semibold">No files of a supported language here</p>
      <p className="max-w-md text-muted">
        Nothing to draw for these settings. Try including tests, choosing another level, or going up
        to the repository root.
      </p>
    </Overlay>
  );
}

/** Visible notice for the truncated flag (API cap or our own 2,000 node cap). */
export function TruncationNotice(props: { shown: number; droppedByCap: number }) {
  return (
    <div
      role="status"
      className="border-b border-line bg-accent-soft px-3 py-1.5 text-xs"
      data-testid="map-truncated"
    >
      This map is truncated: showing {props.shown} nodes
      {props.droppedByCap > 0 ? ` (${props.droppedByCap} more hidden)` : ""}. Focus on a folder or
      lower the depth to see the rest.
    </div>
  );
}
