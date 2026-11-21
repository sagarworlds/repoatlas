export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true" className="text-accent">
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <circle cx="10" cy="11" r="3" fill="var(--accent-fg)" />
        <circle cx="22" cy="10" r="3" fill="var(--accent-fg)" />
        <circle cx="16" cy="23" r="3" fill="var(--accent-fg)" />
        <path d="M10 11 22 10 16 23Z" fill="none" stroke="var(--accent-fg)" strokeWidth="1.6" />
      </svg>
      <span>RepoAtlas</span>
    </span>
  );
}
