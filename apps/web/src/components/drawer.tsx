import clsx from "clsx";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab / Shift+Tab wrap around inside `container` (a focus trap). */
export function trapTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    event.preventDefault();
    container.focus();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  /** "full" is a full-screen sheet. */
  side: "left" | "right" | "full";
  children: ReactNode;
}

/**
 * Modal panel for narrow screens: focus moves in on open and returns to the trigger on
 * close, Tab is trapped, Escape and the backdrop close it, and the page behind does not scroll.
 */
export function Drawer({ open, onClose, label, side, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep the newest onClose without re-running the effect below when its identity changes.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (panelRef.current) trapTab(event, panelRef.current);
  }

  return (
    <div className="fixed inset-0 z-40" data-testid={`drawer-${side}`}>
      {side !== "full" && (
        // Mouse-only convenience; keyboard users close with Escape or the Close button.
        <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={clsx(
          "absolute flex min-h-0 flex-col bg-surface shadow-xl outline-none",
          side === "left" && "inset-y-0 left-0 w-[min(20rem,90vw)] border-r border-line",
          side === "right" && "inset-y-0 right-0 w-[min(22rem,90vw)] border-l border-line",
          side === "full" && "inset-0",
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">{label}</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-line-strong px-3 text-sm hover:bg-surface-2"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
