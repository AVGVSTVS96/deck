import { lazy, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { usePath } from "./api";
import { Link, Toasts } from "./ui";

const Executor = lazy(() => import("./views/Executor").then((m) => ({ default: m.Executor })));
const Files = lazy(() => import("./views/Files").then((m) => ({ default: m.Files })));
const Plugins = lazy(() => import("./views/Plugins").then((m) => ({ default: m.Plugins })));

const ICONS = {
  files: "M4 2.5h5l3 3v8H4ZM9 2.5v3h3M6 8.5h4M6 11h4",
  plugins: "M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0ZM8 11v3",
  executor: "M9 1.5 4 9h4l-1 5.5L12 7H8Z",
};

const VIEWS = [
  { path: "/", label: "Plugins", icon: ICONS.plugins },
  { path: "/files", label: "Files", icon: ICONS.files },
  { path: "/executor", label: "Executor", icon: ICONS.executor },
];

function viewOf(path: string) {
  return VIEWS.slice(1).find((v) => path === v.path || path.startsWith(`${v.path}/`)) ?? VIEWS[0];
}

function App() {
  const path = usePath();
  const view = viewOf(path);
  useEffect(() => {
    document.title = view.path === "/" ? "deck" : `${view.label} · deck`;
  }, [view]);

  return (
    <div className="shell">
      <nav className="rail">
        <Link className="brand" to="/">
          deck
        </Link>
        {VIEWS.map((v) => (
          <Link key={v.path} to={v.path} className={v === view ? "nav on" : "nav"}>
            <svg className="glyph" viewBox="0 0 16 16" aria-hidden>
              <path d={v.icon} />
            </svg>
            <span className="label">{v.label}</span>
          </Link>
        ))}
      </nav>
      <main className="view">
        <Suspense>
          {view.path === "/" && <Plugins />}
          {view.path === "/files" && <Files path={path} />}
          {view.path === "/executor" && <Executor path={path} />}
        </Suspense>
      </main>
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
