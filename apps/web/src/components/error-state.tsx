import { describeError } from "../lib/error-text.ts";

/** Panel-level error with an optional retry button. Text only; nothing is rendered as HTML. */
export function ErrorState(props: { error: unknown; onRetry?: () => void }) {
  const { title, message } = describeError(props.error);
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
      <p className="font-semibold text-danger">
        <span aria-hidden="true">{"✕"} </span>
        {title}
      </p>
      <p className="text-muted">{message}</p>
      {props.onRetry && (
        <button
          type="button"
          onClick={props.onRetry}
          className="h-8 rounded-md border border-line-strong px-3 hover:bg-surface-2"
        >
          Try again
        </button>
      )}
    </div>
  );
}
