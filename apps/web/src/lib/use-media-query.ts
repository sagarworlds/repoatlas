import { useCallback, useSyncExternalStore } from "react";

function canMatch(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/**
 * Tracks a CSS media query. useSyncExternalStore is React's tool for reading a value that
 * lives outside React (here the browser) and re-rendering when it changes.
 * Without matchMedia (SSR, jsdom) the answer is always `false`.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatch()) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = () => (canMatch() ? window.matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Below this width the tree and detail panel become drawers (docs/UI.md). */
export const NARROW_QUERY = "(max-width: 899px)";

export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}
