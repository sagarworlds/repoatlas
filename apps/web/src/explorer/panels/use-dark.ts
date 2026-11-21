import { useSyncExternalStore } from "react";
import { isDarkNow } from "../../lib/theme.ts";

function subscribe(onChange: () => void): () => void {
  // The theme toggle flips a class on <html>, so watch that attribute.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** True while the dark theme is active; re-renders when the theme changes. */
export function useIsDark(): boolean {
  // useSyncExternalStore reads state that lives outside React (here: a DOM class).
  return useSyncExternalStore(subscribe, isDarkNow, () => false);
}
