import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard.ts";

/**
 * Copy helper for buttons. `message` is a short status ("Copied" / "Copy failed") that
 * clears itself; render it in an aria-live region so screen readers announce it.
 */
export function useCopy(): { message: string; copy: (text: string) => Promise<void> } {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleanup function returned from an effect runs on unmount (like IDisposable.Dispose).
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    setMessage(ok ? "Copied to clipboard" : "Copy failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), 2500);
  }, []);

  return { message, copy };
}
