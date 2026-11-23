/** Code-unit comparison (locale independent), for deterministic ordering. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
