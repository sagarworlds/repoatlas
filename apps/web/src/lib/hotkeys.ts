// Keyboard shortcut matching as pure functions, so they can be unit tested without a DOM event.

/** The parts of a KeyboardEvent we look at. A real KeyboardEvent satisfies this shape. */
export interface HotkeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

/** True when the user is typing text (input, textarea, select or contenteditable). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable || target.getAttribute("contenteditable") === "true";
}

/**
 * Search shortcuts: Ctrl/Cmd+K works everywhere; a bare "/" only when the user is not
 * typing somewhere (otherwise they could not type a slash).
 */
export function matchesSearchHotkey(event: HotkeyEventLike): boolean {
  const key = event.key.toLowerCase();
  if (key === "k" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    return true;
  }
  if (key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return !isEditableTarget(event.target);
  }
  return false;
}
