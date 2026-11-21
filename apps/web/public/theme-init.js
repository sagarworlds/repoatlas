// Sets the theme class on <html> before first paint to avoid a light/dark flash.
// Keep the storage key in sync with src/lib/theme.ts.
(() => {
  try {
    const saved = localStorage.getItem("repoatlas.theme");
    const dark =
      saved === "dark" ||
      ((saved === null || saved === "system") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch {
    // storage blocked: fall back to the CSS default
  }
})();
