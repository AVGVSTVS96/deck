import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { usePath } from "./api";
import { Link, Toasts } from "./ui";
import { Accounts } from "./views/Accounts";
import { Agents } from "./views/Agents";
import { Executor } from "./views/Executor";
import { Files } from "./views/Files";
import { Plugins } from "./views/Plugins";
import { System } from "./views/System";

const ICONS = {
  system:
    "M5 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm6 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-6 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5 6.5v3M6.5 11h3M6.1 6.1l3.8 3.8",
  files: "M4 2.5h5l3 3v8H4ZM9 2.5v3h3M6 8.5h4M6 11h4",
  agents: "M2.5 3.5h11v8h-11ZM5 6l2 1.5L5 9M8.5 9H11M6 13.5h4",
  plugins: "M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0ZM8 11v3",
  executor: "M9 1.5 4 9h4l-1 5.5L12 7H8Z",
  accounts: "M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 13.5c.6-2.4 2.6-4 5-4s4.4 1.6 5 4",
};

const VIEWS = [
  { path: "/", label: "System", icon: ICONS.system },
  { path: "/files", label: "Files", icon: ICONS.files },
  { path: "/agents", label: "Agents", icon: ICONS.agents },
  { path: "/plugins", label: "Plugins", icon: ICONS.plugins },
  { path: "/executor", label: "Executor", icon: ICONS.executor },
  { path: "/accounts", label: "Accounts", icon: ICONS.accounts },
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
        {view.path === "/" && <System />}
        {view.path === "/files" && <Files path={path} />}
        {view.path === "/agents" && <Agents />}
        {view.path === "/plugins" && <Plugins />}
        {view.path === "/executor" && <Executor path={path} />}
        {view.path === "/accounts" && <Accounts />}
      </main>
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
