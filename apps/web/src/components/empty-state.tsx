import type { ReactNode } from "react";

/** Centered "nothing here yet" message with an optional hint or action. */
export function EmptyState(props: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="font-medium">{props.title}</p>
      {props.children && <div className="text-sm text-muted">{props.children}</div>}
    </div>
  );
}
