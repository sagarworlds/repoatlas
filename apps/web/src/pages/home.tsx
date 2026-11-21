import { AnalyzeForm } from "../components/analyze-form.tsx";
import { RecentAnalyses } from "../components/recent-analyses.tsx";

export function HomePage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-10 px-4 py-10">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Explore any public GitHub repo as a map
        </h1>
        <p className="max-w-2xl text-muted">
          Paste a repository and RepoAtlas lays out its folders, files, classes and functions, and
          how they import and call each other. Nothing from the repository is ever executed.
        </p>
      </section>
      <AnalyzeForm />
      <RecentAnalyses />
    </div>
  );
}
