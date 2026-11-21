import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl space-y-3 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted">That address does not exist in RepoAtlas.</p>
      <Link to="/" className="inline-block font-medium text-accent-strong underline">
        Back to the home page
      </Link>
    </div>
  );
}
