// Stable colours per top-level directory. The palette follows the Okabe-Ito colour-blind
// safe set; the light variant is darkened where the original is too pale on a light page.
// Colour is never the only signal (shapes, dashes and labels carry the rest).

const DARK_PALETTE = [
  "#E69F00", // orange
  "#56B4E9", // sky blue
  "#2FC79A", // bluish green
  "#F0E442", // yellow
  "#4C9BE8", // blue
  "#F0824A", // vermillion
  "#E79BC6", // reddish purple
  "#B4A7F5", // violet
] as const;

const LIGHT_PALETTE = [
  "#B26B00",
  "#1F7FB8",
  "#00805F",
  "#8F7A00",
  "#0056A3",
  "#C24E00",
  "#A8478A",
  "#6A55C8",
] as const;

const NEUTRAL_DARK = "#9AA8A0";
const NEUTRAL_LIGHT = "#5F6B65";

/** FNV-1a 32-bit hash: tiny, deterministic, the same in every browser. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export const PALETTE_SIZE = DARK_PALETTE.length;

/** Palette slot for a group key; -1 for the neutral colour (root-level files, externals). */
export function paletteIndex(group: string): number {
  if (group === "" || group.startsWith("\u0000")) return -1;
  return hashString(group) % PALETTE_SIZE;
}

export function groupColor(group: string, dark: boolean): string {
  const index = paletteIndex(group);
  if (index < 0) return dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;
  return palette[index] ?? (dark ? NEUTRAL_DARK : NEUTRAL_LIGHT);
}
