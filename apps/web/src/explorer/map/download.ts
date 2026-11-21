/** Saves a Blob through a temporary anchor element and releases the object URL afterwards. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke on the next tick so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** "widgets-src-map.png": file-system safe name from the repo and the map root. */
export function pngFilename(repo: string, root: string): string {
  const path = root.replace(/^[a-z]+:/, "");
  const parts = [repo, path === "" ? "map" : path].join("-");
  const safe = parts.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe === "" ? "map" : safe}.png`;
}
