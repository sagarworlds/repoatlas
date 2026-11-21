import { useEffect } from "react";

/** Sets "<title> - RepoAtlas" while the component is mounted and restores the old title after. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} - RepoAtlas`;
    // The returned function is the effect's cleanup (like Dispose).
    return () => {
      document.title = previous;
    };
  }, [title]);
}
