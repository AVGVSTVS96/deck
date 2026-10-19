import { useState } from "react";
import type { Agents as AgentsData, AppThreads, PoolAccount, Thread } from "../../src/types";
import { relativeTime, useLoad } from "../api";
import { Empty, Meter } from "../ui";

export const APP_LABEL = new Map([
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["buzz", "Buzz"],
  ["t3", "T3 Code"],
  ["voice", "Voice"],
  ["imessage", "iMessage"],
  ["other", "Other Claude sessions"],
  ["mac", "Mac"],
]);

export const accountHue = (accounts: PoolAccount[], label: string | null) => {
  const index = accounts.findIndex((a) => a.label === label);

  return index < 0 ? null : index;
};

export function Agents() {
  const agents = useLoad<AgentsData>("/agents", (e) => e.type === "agents");

  if (agents.error) return <Empty>{agents.error}</Empty>;

  if (!agents.data) return <Empty>Finding sessions…</Empty>;
  const { apps, pool, tokenhub } = agents.data;
  const all = apps.flatMap((a) => a.threads);
  const running = all.filter((t) => t.running).length;
  const accounts = pool?.accounts ?? [];

  return (
    <div className="page agents">
      <header className="page-head">
        <h1>Agents</h1>
        <p className="lede">
          <b>{running}</b> of {all.length} sessions are running right now
          {pool && (
            <>
              , drawing on <b>{accounts.length}</b> pooled accounts
            </>
          )}
          .
        </p>
      </header>

      <section className="pool">
        <div className="section-head">
          <h2>Token pool</h2>
          {tokenhub && (
            <a href={tokenhub} target="_blank" rel="noreferrer">
              Open tokenhub ↗
            </a>
          )}
        </div>
        {pool ? (
          <div className="pool-grid">
            {accounts.map((a, i) => (
              <PoolCard key={a.id} account={a} hue={i} sessions={all.filter((t) => t.account === a.label)} />
            ))}
          </div>
        ) : (
          <Empty>{tokenhub ? "tokenhub didn't answer." : "No token pool configured."}</Empty>
        )}
        {pool && (
          <p className="muted small">
            Pool routing as of {relativeTime(pool.at)}. The marker on each bar is where the pool moves new sessions to the next account.
          </p>
        )}
      </section>

      {apps.map((app) => (
        <AppSection key={app.app} app={app} accounts={accounts} />
      ))}
    </div>
  );
}

const IDLE_SHOWN = 6;

function AppSection({ app, accounts }: { app: AppThreads; accounts: PoolAccount[] }) {
  const [all, setAll] = useState(false);
  const sorted = app.threads.toSorted((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
  const running = sorted.filter((t) => t.running).length;
  const shown = all ? sorted : sorted.slice(0, Math.max(running, IDLE_SHOWN));

  return (
    <section className="threads">
      <div className="section-head">
        <h2>
          <span className={app.connected ? "dot live" : "dot off"} title={app.connected ? "Hub is connected" : "Not connected"} />
          {APP_LABEL.get(app.app) ?? app.app}
        </h2>
        <span className="muted">
          {running} running · {app.threads.length} threads
        </span>
      </div>
      <ul className="thread-list">
        {shown.map((t) => (
          <ThreadRow key={t.id} thread={t} hue={accountHue(accounts, t.account)} />
        ))}
        {shown.length < sorted.length && (
          <li className="thread more-row">
            <button className="quiet small" onClick={() => setAll(true)}>
              Show {sorted.length - shown.length} idle
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

function PoolCard({ account, hue, sessions }: { account: PoolAccount; hue: number; sessions: Thread[] }) {
  return (
    <article className={account.selected ? "pool-card next" : "pool-card"} data-hue={hue}>
      <div className="pool-title">
        <span className="swatch" />
        <span className="who">{account.label}</span>
        {account.selected && <span className="chip live">next session</span>}
        {account.needsReauth && <span className="chip bad">sign in again</span>}
        {!account.eligible && !account.needsReauth && <span className="chip warn">held back</span>}
      </div>
      {account.session && <Meter label="5 hours" used={account.session.used} threshold={account.session.threshold ?? undefined} />}
      {account.week && <Meter label="Week" used={account.week.used} threshold={account.week.threshold ?? undefined} />}
      <div className="pool-foot">
        <span title="Sessions the pool holds on this account">
          <b>{account.held}</b> held
        </span>
        <span title="hex threads bound to this account">
          <b>{sessions.length}</b> hex threads
        </span>
        {account.session && <span className="muted">resets {relativeTime(account.session.resetsAt)}</span>}
      </div>
    </article>
  );
}

function ThreadRow({ thread, hue }: { thread: Thread; hue: number | null }) {
  return (
    <li className={thread.running ? "thread on" : "thread"}>
      <span className={thread.running ? "dot live" : "dot off"} title={thread.running ? "Running" : "Idle"} />
      <span className="tname">{thread.name}</span>
      {thread.cwd && <span className="cwd">{thread.cwd.replace(/^\/(home|Users)\/[^/]+/, "~")}</span>}
      <span className="spacer" />
      {thread.account && (
        <span className="acct" data-hue={hue ?? undefined} title={`Bound to ${thread.account}`}>
          {thread.account.split("@")[0]}
        </span>
      )}
      {thread.link && (
        <a className="open" href={thread.link} target="_blank" rel="noreferrer">
          Open ↗
        </a>
      )}
    </li>
  );
}
