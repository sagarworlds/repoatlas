import { Link, Outlet, Route, Routes } from "react-router-dom";
import { Logo } from "./components/logo.tsx";
import { ThemeToggle } from "./components/theme-toggle.tsx";
import { ExplorerPage } from "./explorer/explorer-page.tsx";
import { HomePage } from "./pages/home.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";

/** Header + page area shared by every route. */
function Shell() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4">
        <Link to="/" aria-label="RepoAtlas home" className="rounded text-fg">
          <Logo />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-3">
          <Link to="/" className="text-sm text-muted hover:text-fg">
            Home
          </Link>
          <ThemeToggle />
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

/** Route table. The router itself (BrowserRouter) is created in main.tsx. */
export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="a/:analysisId" element={<ExplorerPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
