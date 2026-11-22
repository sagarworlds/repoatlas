import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateAnalysis } from "../api/hooks.ts";
import { EXAMPLES, isExampleAvailable } from "../config/examples.ts";
import { describeError } from "../lib/error-text.ts";
import { addRecent } from "../lib/recent.ts";
import { parseRepoInput, validateRef } from "../lib/repo-input.ts";
import { LanguageChips } from "./language-chips.tsx";

/** The analyze form: repository input, optional ref, examples, inline + server errors. */
export function AnalyzeForm() {
  const navigate = useNavigate();
  const create = useCreateAnalysis();
  const repoId = useId();
  const refId = useId();
  const [repoText, setRepoText] = useState("");
  const [refText, setRefText] = useState("");
  const [repoError, setRepoError] = useState<string | undefined>();
  const [refError, setRefError] = useState<string | undefined>();

  function start(repoInput: string, refInput: string) {
    const parsed = parseRepoInput(repoInput);
    const refProblem = validateRef(refInput);
    setRepoError(parsed.ok ? undefined : parsed.message);
    setRefError(refProblem);
    if (!parsed.ok || refProblem) return;

    const ref = refInput.trim();
    create.mutate(
      { repoUrl: parsed.repoUrl, ...(ref !== "" && { ref }) },
      {
        onSuccess: (result) => {
          addRecent({
            id: result.id,
            repo: `${result.owner}/${result.repo}`,
            ref: result.ref,
            date: new Date().toISOString(),
            status: result.status,
          });
          navigate(`/a/${encodeURIComponent(result.id)}`);
        },
      },
    );
  }

  const serverError = create.isError ? describeError(create.error) : undefined;

  return (
    <div className="space-y-5">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          start(repoText, refText);
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <div>
            <label htmlFor={repoId} className="mb-1 block text-sm font-medium">
              GitHub repository
            </label>
            <input
              id={repoId}
              value={repoText}
              onChange={(e) => setRepoText(e.target.value)}
              placeholder="owner/repo or https://github.com/owner/repo"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={repoError !== undefined}
              aria-describedby={repoError ? `${repoId}-error` : undefined}
              className="h-11 w-full rounded-md border border-line-strong bg-surface px-3 font-mono text-sm placeholder:font-sans placeholder:text-muted"
            />
            {repoError && (
              <p id={`${repoId}-error`} role="alert" className="mt-1 text-sm text-danger">
                {repoError}
              </p>
            )}
          </div>
          <div>
            <label htmlFor={refId} className="mb-1 block text-sm font-medium">
              Ref <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id={refId}
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              placeholder="branch, tag or commit (default branch)"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={refError !== undefined}
              aria-describedby={refError ? `${refId}-error` : undefined}
              className="h-11 w-full rounded-md border border-line-strong bg-surface px-3 font-mono text-sm placeholder:font-sans placeholder:text-muted"
            />
            {refError && (
              <p id={`${refId}-error`} role="alert" className="mt-1 text-sm text-danger">
                {refError}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={create.isPending}
            className="h-11 rounded-md bg-accent px-5 text-sm font-semibold text-accent-fg hover:bg-accent-strong disabled:opacity-60"
          >
            {create.isPending ? "Starting…" : "Analyze repository"}
          </button>
          <LanguageChips />
        </div>
      </form>

      {serverError && (
        <div role="alert" className="rounded-md border border-danger bg-danger-soft p-3 text-sm">
          <p className="font-semibold text-danger">{serverError.title}</p>
          <p className="mt-0.5">{serverError.message}</p>
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-medium text-muted">Try an example</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {EXAMPLES.map((example) => (
            <li key={example.repo}>
              <button
                type="button"
                disabled={!isExampleAvailable(example) || create.isPending}
                onClick={() => {
                  setRepoText(example.repo);
                  setRefText("");
                  start(example.repo, "");
                }}
                className="flex w-full items-start justify-between gap-3 rounded-md border border-line bg-surface p-3 text-left hover:border-accent disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-line"
              >
                <span>
                  <span className="block font-mono text-sm font-medium">{example.repo}</span>
                  <span className="block text-xs text-muted">{example.description}</span>
                </span>
                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
                  {isExampleAvailable(example)
                    ? example.language
                    : `${example.language} · coming soon`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
