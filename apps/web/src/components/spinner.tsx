/** Small spinning ring. `label` is read by screen readers; the ring itself is decorative. */
export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
      <span
        aria-hidden="true"
        className="inline-block size-4 animate-spin rounded-full border-2 border-line border-t-accent"
      />
      <span>{label}&hellip;</span>
    </span>
  );
}
