import { QueryClientProvider } from "@tanstack/react-query";
import { type ComponentType, lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { queries, useConnected, usePath } from "./api";
import { Empty, Link, Toasts } from "./ui";

/** A redeploy renames every chunk, so a tab opened before it 404s on views it hasn't loaded: reload into the new build once. */
const view = (load: () => Promise<{ default: ComponentType<{ path: string }> }>) =>
  lazy(() =>
    load().catch(() => {
      const last = Number(sessionStorage.getItem("reloaded"));

      if (Date.now() - last > 10_000) {
        sessionStorage.setItem("reloaded", String(Date.now()));
        location.reload();
      }

      return { default: () => <Empty>This view didn't load. Reload the page to try again.</Empty> };
    }),
  );

const ROUTES = [
  { path: "/", label: "Usage", view: view(() => import("./views/Usage")) },
  { path: "/live", label: "Live", view: view(() => import("./views/Live")) },
  { path: "/accounts", label: "Accounts", view: view(() => import("./views/Accounts")) },
  { path: "/files", label: "Files", view: view(() => import("./views/Files")) },
  { path: "/plugins", label: "Plugins", view: view(() => import("./views/Plugins")) },
  { path: "/executor", label: "Executor", view: view(() => import("./views/Executor")) },
];

const routeOf = (path: string) => ROUTES.slice(1).find((r) => path === r.path || path.startsWith(`${r.path}/`)) ?? ROUTES[0];

const THEMES = ["system", "light", "dark"] as const;

type Theme = (typeof THEMES)[number];

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => THEMES.find((t) => t === localStorage.getItem("theme")) ?? "system");

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  return [theme, () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])] as const;
}

function App() {
  const path = usePath();
  const route = routeOf(path);
  const View = route.view;
  const connected = useConnected();
  const [theme, nextTheme] = useTheme();

  useEffect(() => {
    document.title = `${route.label} · deck`;
  }, [route]);

  return (
    <div className="shell">
      <header className="top">
        <Link className="brand" to="/">
          deck
        </Link>
        <nav className="tabs" aria-label="Views">
          {ROUTES.map((r) => (
            <Link key={r.path} to={r.path} current={r === route}>
              {r.label}
            </Link>
          ))}
        </nav>
        <span className="spacer" />
        <span className="status">
          <span className={connected ? "dot live" : "dot"} />
          {connected ? "Live" : "Connecting…"}
        </span>
        <button className="small" onClick={nextTheme} aria-label={`Theme: ${theme}. Switch theme`}>
          {theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}
        </button>
      </header>
      <main className="view">
        <Suspense fallback={<Empty>Loading…</Empty>}>
          <View path={path} />
        </Suspense>
      </main>
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queries}>
    <App />
  </QueryClientProvider>,
);
