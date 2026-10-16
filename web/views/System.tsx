import type { Agents, Changes, ExecutorOverview, Plugin, RepoSummary, Window, Workspace } from "../../src/types";
import { relativeTime, useLoad } from "../api";
import { Empty, Link } from "../ui";
import { APP_LABEL } from "./Agents";

const DOT_CAP = 40;

export function System() {
  const repos = useLoad<RepoSummary[]>("/repos", (e) => e.type === "repo" || e.type === "ws");
  const agents = useLoad<Agents>("/agents", (e) => e.type === "agents");
  const plugins = useLoad<Plugin[]>("/plugins", (e) => e.type === "plugins");
  const executor = useLoad<ExecutorOverview>("/executor");
  const worktrees = repos.data?.flatMap((r) => r.workspaces.filter((w) => w.name)) ?? [];
  const threads = agents.data?.apps.flatMap((a) => a.threads) ?? [];

  return (
    <div className="page system">
      <header className="page-head">
        <h1>How hex fits together</h1>
        <p className="lede">
          Edits start in a worktree, ship into the live files, and every running session reads those live files, on an account from the
          pool.
        </p>
      </header>

      <div className="flowmap">
        <Stage title="Edits" sub="worktrees, yours to change">
          {worktrees.length ? (
            worktrees.map((ws) => <WorktreeNode key={ws.id} ws={ws} />)
          ) : (
            <p className="muted small">No worktrees. Press Edit on any file to start one.</p>
          )}
          <Link className="more" to="/files">
            Browse files →
          </Link>
        </Stage>
        <Arrow label="ship" />
        <Stage title="Live files" sub="what sessions read">
          {repos.data?.map((r) => (
            <Link key={r.id} to={`/files/${r.id}`} className="node">
              <div className="node-title">
                <span className="dot live" />
                <b>{r.name}</b>
                <span className="muted">{r.branch ?? "detached"}</span>
              </div>
              <div className="node-sub">{r.about}</div>
              {(r.unpushed ?? 0) > 0 && <div className="node-sub warn">{r.unpushed} unpushed</div>}
            </Link>
          )) ?? <Empty>…</Empty>}
        </Stage>
        <Arrow label="read by" />
        <Stage
          title="Sessions"
          sub={agents.data ? `${threads.filter((t) => t.running).length} of ${threads.length} running` : "hex threads"}
        >
          {agents.data?.apps.map((app) => (
            <Link key={app.app} to="/agents" className="node">
              <div className="node-title">
                <span className={app.connected ? "dot live" : "dot off"} />
                <b>{APP_LABEL.get(app.app) ?? app.app}</b>
                <span className="muted">
                  {app.threads.filter((t) => t.running).length}/{app.threads.length}
                </span>
              </div>
              <div className="dots" aria-label={`${app.threads.filter((t) => t.running).length} running of ${app.threads.length}`}>
                {app.threads
                  .toSorted((a, b) => Number(b.running) - Number(a.running))
                  .slice(0, DOT_CAP)
                  .map((t) => (
                    <i key={t.id} className={t.running ? "on" : ""} title={t.name} />
                  ))}
                {app.threads.length > DOT_CAP && <span className="more-dots">+{app.threads.length - DOT_CAP}</span>}
              </div>
            </Link>
          )) ?? <Empty>…</Empty>}
        </Stage>
        <Arrow label="run on" back />
        <Stage title="Accounts" sub="the token pool">
          {agents.data?.pool?.accounts.map((a, i) => (
            <Link key={a.id} to="/agents" className="node account" hue={i}>
              <div className="node-title">
                <span className="swatch" />
                <b title={a.label}>{a.label}</b>
                {a.selected && <span className="chip live">next</span>}
              </div>
              <div className="minibars">
                <MiniBar label="5h" window={a.session} />
                <MiniBar label="wk" window={a.week} />
              </div>
            </Link>
          )) ?? <p className="muted small">{agents.data ? "No pool connected." : "…"}</p>}
        </Stage>
      </div>

      <div className="sidecar">
        <section>
          <div className="section-head">
            <h2>Plugins sessions load</h2>
            <Link to="/plugins">Manage →</Link>
          </div>
          <div className="chips">
            {plugins.data
              ?.filter((p) => p.kind !== "claude" || p.enabled)
              .map((p) => (
                <span key={p.id} className={`chip ${p.state === "connected" || p.enabled ? "live" : ""}`} title={p.description}>
                  {p.name}
                </span>
              ))}
          </div>
        </section>
        <section>
          <div className="section-head">
            <h2>Executor tools they call</h2>
            <Link to="/executor">Manage →</Link>
          </div>
          <div className="chips">
            {executor.data?.apps.map((a) => (
              <span
                key={a.id}
                className={`chip ${a.accounts.some((x) => x.health === "healthy") ? "live" : ""}`}
                title={a.deployedAt ? `deployed ${relativeTime(a.deployedAt)}` : ""}
              >
                {a.name}
              </span>
            )) ?? <span className="muted small">{executor.error ?? "…"}</span>}
          </div>
        </section>
      </div>
    </div>
  );
}

function Stage({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="stage">
      <h2>{title}</h2>
      <p className="muted small">{sub}</p>
      <div className="stage-body">{children}</div>
    </section>
  );
}

function Arrow({ label, back }: { label: string; back?: boolean }) {
  return (
    <div className={back ? "arrow-col back" : "arrow-col"} aria-hidden>
      <span className="arrow-label">{label}</span>
      <span className="arrow-line" />
    </div>
  );
}

function MiniBar({ label, window }: { label: string; window: Window | null }) {
  const used = Math.round(window?.used ?? 0);

  return (
    <div className="minibar" title={`${label === "5h" ? "5 hours" : "Week"}: ${used}% used`}>
      <span className="muted">{label}</span>
      <span className="minitrack">
        <span style={{ width: `${used}%` }} />
        {window?.threshold != null && <i style={{ left: `${window.threshold}%` }} />}
      </span>
      <span className="num">{used}%</span>
    </div>
  );
}

function WorktreeNode({ ws }: { ws: Workspace }) {
  const changes = useLoad<Changes>(
    `/ws/${encodeURIComponent(ws.id)}/changes`,
    (e) => (e.type === "ws" && e.id === ws.id) || (e.type === "repo" && e.repo === ws.repo),
  );

  const c = changes.data;

  return (
    <Link to={`/files/${ws.id}`} className="node">
      <div className="node-title">
        <span className="dot wt" />
        <b>{ws.name}</b>
        <span className="muted">{ws.repo}</span>
      </div>
      {c && (
        <div className="node-sub">
          <span className="commits" title={`${c.ahead} commits to ship`}>
            {Array.from({ length: Math.min(c.ahead, 12) }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          {c.ahead} to ship{c.dirty ? " · uncommitted edits" : ""}
        </div>
      )}
    </Link>
  );
}
