import { useState } from "react";
import type { AppThreads, Host, Move, MoveCause, Policy, PolicyCheck, Pool, PoolAccount, Seat, Thread } from "../../src/types";
import { api, relativeTime, useAgents } from "../api";
import { Busy, Empty, Meter, toast, useAction } from "../ui";
import { AgentUsage } from "./AgentUsage";

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

const short = (label: string) => label.split("@")[0];

const pct = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 1 : 0 })}%`;

const hoursUntil = (at: number) => Math.max(0, (at - Date.now()) / 3_600_000);

export function Agents() {
  const agents = useAgents();

  if (agents.error) return <Empty>{agents.error}</Empty>;

  if (!agents.data) return <Empty>Finding sessions…</Empty>;
  const { apps, pool, tokenhub } = agents.data;
  const all = apps.flatMap((a) => a.threads);
  const running = all.filter((t) => t.running).length;
  const accounts = pool?.accounts ?? [];
  const seated = accounts.reduce((sum, a) => sum + a.seats.length, 0);
  const next = accounts.find((a) => a.selected);

  return (
    <div className="page agents">
      <header className="page-head agents-head">
        <div>
          <h1>Agents</h1>
          <p className="lede">
            <b>{running}</b> of {all.length} sessions are running
            {pool && (
              <>
                , <b>{seated}</b> seated on {accounts.length} pooled accounts. New sessions go to{" "}
                <b data-hue={accountHue(accounts, next?.label ?? null) ?? undefined} className="hue-ink">
                  {next?.label ?? "no account"}
                </b>
              </>
            )}
            .
          </p>
        </div>
        {tokenhub && (
          <a className="open" href={tokenhub} target="_blank" rel="noreferrer">
            Open tokenhub ↗
          </a>
        )}
      </header>

      {pool ? (
        <>
          <Routing pool={pool} />
          <Moves pool={pool} />
        </>
      ) : (
        <Empty>{tokenhub ? "tokenhub didn't answer." : "No token pool configured."}</Empty>
      )}

      {apps.map((app) => (
        <AppSection key={app.app} app={app} accounts={accounts} host={pool?.hosts.find((h) => h.host === app.app)} />
      ))}

      {tokenhub && <AgentUsage />}

      {pool && (
        <details className="pool-notes">
          <summary>How the pool routes sessions</summary>
          {pool.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          <p>Held limit resets are shown on the accounts, never spent here. One is used only when you run /limit-reset yourself.</p>
        </details>
      )}
    </div>
  );
}

function decision(next: PoolAccount | undefined, accounts: PoolAccount[], policy: Policy) {
  if (!next) return "Every account needs its sign-in renewed.";

  if (next.standing === "blocked") return "Every account is past a cutoff, so new sessions go to the one that frees up first.";

  if (next.standing === "tight")
    return `No account has ${pct(next.room?.minimum ?? 2)} of five-hour room per working session left, so the one with the most room takes it.`;

  if (!accounts.some((a) => a !== next && a.standing === "open")) return "It's the only account with room under both cutoffs.";
  const left = policy.weeklyCutoff - (next.week?.used ?? 0);
  const hours = next.week ? hoursUntil(next.week.resetsAt) : 0;

  return `Every open account has room, so the pool spends the week that would go unused first: ${pct(left)} of this week left with ${Math.round(hours)} hours to go, ${next.pace.toFixed(2)}% an hour.`;
}

function Routing({ pool }: { pool: Pool }) {
  const ranked = pool.accounts.toSorted((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const next = pool.accounts.find((a) => a.selected);

  return (
    <section className="routing">
      <div className="section-head">
        <h2>Routing</h2>
        <span className="muted small">
          as of {relativeTime(pool.at)} · <Hosts hosts={pool.hosts} />
        </span>
      </div>
      <div className="decide" data-hue={next ? pool.accounts.indexOf(next) : undefined}>
        <span className="swatch" />
        <div>
          <b>Next new session → {next?.label ?? "none"}</b>
          <p>{decision(next, pool.accounts, pool.policy)}</p>
        </div>
      </div>
      <ol className="rank-list">
        {ranked.map((account) => (
          <RankRow key={account.id} account={account} hue={pool.accounts.indexOf(account)} policy={pool.policy} />
        ))}
      </ol>
      <div className="seat-key muted small">
        <span>
          <i className="seat working" /> working
        </span>
        <span>
          <i className="seat" /> idle, not counted as load
        </span>
        <span>
          <i className="seat working remote" /> on the Mac
        </span>
        <span>
          <i className="seat next" /> next new session
        </span>
        <span>
          <i className="tick" /> cutoff
        </span>
      </div>
      <PolicyLine pool={pool} />
    </section>
  );
}

function Hosts({ hosts }: { hosts: Host[] }) {
  return hosts.map((h, i) => (
    <span key={h.host}>
      {i > 0 && " · "}
      {h.host} {h.seats} seated
      {h.seenAt !== null && <span title={new Date(h.seenAt).toLocaleString()}>, checked in {relativeTime(h.seenAt)}</span>}
    </span>
  ));
}

function RankRow({ account, hue, policy }: { account: PoolAccount; hue: number; policy: Policy }) {
  const working = account.seats.filter((s) => s.working).length;
  const idle = account.seats.length - working;
  const room = account.room;

  return (
    <li className={account.selected ? "rank-row next" : "rank-row"} data-hue={hue} data-standing={account.standing}>
      <span className="rank-n num">{account.rank ?? "–"}</span>
      <div className="rank-who">
        <div className="pool-title">
          <span className="swatch" />
          <span className="who" title={account.label}>
            {account.label}
          </span>
        </div>
        <div className="chips">
          {account.selected && <span className="chip live">next session</span>}
          {account.standing === "tight" && <span className="chip warn">tight</span>}
          {account.needsReauth && <span className="chip bad">sign in again</span>}
          {account.standing === "blocked" && !account.needsReauth && <span className="chip bad">blocked</span>}
          <span className="muted small">{account.tier}</span>
        </div>
      </div>
      {account.session ? (
        <Meter
          label={`5 hours · resets ${relativeTime(account.session.resetsAt)}`}
          used={account.session.used}
          threshold={policy.sessionCutoff}
        />
      ) : (
        <span className="muted small">No five-hour sample</span>
      )}
      {account.week ? (
        <Meter label={`Week · resets ${relativeTime(account.week.resetsAt)}`} used={account.week.used} threshold={policy.weeklyCutoff} />
      ) : (
        <span className="muted small">No weekly sample</span>
      )}
      <div className="rank-why">
        {room?.each != null ? (
          <>
            <span className="num big">{pct(room.each)}</span>
            <span className="muted small" title="Five-hour room under the cutoff, split across working sessions plus the next one">
              room each · {pct(room.left)} ÷ {room.sessions}
            </span>
          </>
        ) : (
          <span className="muted small">Quota unknown</span>
        )}
        <span className="muted small" title="Weekly room left under the cutoff, per hour until the week resets">
          week to spend {account.pace.toFixed(2)}%/h
        </span>
      </div>
      <div className="rank-seats">
        {(account.seats.length > 0 || account.selected) && <Seats seats={account.seats} next={account.selected} />}
        <span className="muted small">
          {working} working · {idle} idle
          {account.sampledAt !== null && (
            <span className={account.stale ? "warn" : undefined}>
              {" "}
              · quota read {relativeTime(account.sampledAt)}
              {account.stale && ", stale"}
            </span>
          )}
        </span>
      </div>
      {account.standing !== "open" && <p className="rank-reason small">{account.reasons.join(" ")}</p>}
    </li>
  );
}

function Seats({ seats, next }: { seats: Seat[]; next: boolean }) {
  const ordered = seats.toSorted((a, b) => Number(b.working) - Number(a.working) || a.host.localeCompare(b.host));

  return (
    <span className="seats" role="img" aria-label={`${seats.length} seated sessions`}>
      {ordered.map((s) => (
        <i
          key={s.session}
          className={["seat", s.working && "working", s.host !== "server" && "remote"].filter(Boolean).join(" ")}
          title={`${s.name ?? "Claude session"} · ${s.working ? "working" : "idle"}${s.host === "server" ? "" : ` · ${s.host}`}`}
        />
      ))}
      {next && <i className="seat next" title="The next new session lands here" />}
    </span>
  );
}

const POLICY_FIELDS: { key: keyof Policy; label: string; max: number; unit: string }[] = [
  { key: "sessionCutoff", label: "Five-hour cutoff", max: 100, unit: "%" },
  { key: "weeklyCutoff", label: "Weekly cutoff", max: 100, unit: "%" },
  { key: "agentsPerAccount", label: "Agents per account", max: 500, unit: "" },
];

function PolicyLine({ pool }: { pool: Pool }) {
  const [draft, setDraft] = useState<Policy | null>(null);
  const [check, setCheck] = useState<PolicyCheck | null>(null);
  const { busy, run } = useAction();
  const { policy } = pool;
  const changed = draft !== null && POLICY_FIELDS.some((f) => draft[f.key] !== policy[f.key]);

  const send = (operation: "preview" | "save") =>
    run(operation, async () => {
      const result = await api<PolicyCheck>("/agents/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, policy: draft, revision: check?.revision ?? pool.revision }),
      });

      if (result.saved) {
        toast("Policy saved. Running sessions keep their account until they hit a limit.");
        setDraft(null);
        setCheck(null);
      } else setCheck(result);
    });

  if (!draft)
    return (
      <div className="policy">
        <span className="small">
          New sessions skip an account at <b>{policy.sessionCutoff}%</b> of five hours or <b>{policy.weeklyCutoff}%</b> of the week. A fresh
          account takes up to <b>{policy.agentsPerAccount}</b> working agents.
        </span>
        <button className="quiet small" onClick={() => setDraft({ ...policy })}>
          Change policy
        </button>
      </div>
    );

  return (
    <div className="policy editing">
      <div className="policy-fields">
        {POLICY_FIELDS.map((f) => (
          <label key={f.key}>
            <span className="muted small">{f.label}</span>
            <span className="policy-input">
              <input
                type="number"
                min={1}
                max={f.max}
                value={draft[f.key]}
                onChange={(e) => {
                  setCheck(null);
                  setDraft({ ...draft, [f.key]: Number(e.target.value) });
                }}
              />
              {f.unit}
            </span>
          </label>
        ))}
      </div>
      {check && (
        <p className="small">
          With this policy the next session goes to <b>{check.next ?? "no account"}</b>
          {check.order.some((o) => o.standing !== "open") &&
            `; ${check.order
              .filter((o) => o.standing !== "open")
              .map((o) => `${short(o.label)} is ${o.standing}`)
              .join(", ")}`}
          . Nothing changes until you save.
        </p>
      )}
      <div className="chips">
        <Busy on={busy === "preview"} className="small" disabled={!changed} onClick={() => send("preview")}>
          Preview
        </Busy>
        <Busy on={busy === "save"} className="small primary" disabled={!check} onClick={() => send("save")}>
          Save policy
        </Busy>
        <button
          className="quiet small"
          onClick={() => {
            setDraft(null);
            setCheck(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const CAUSES: Record<MoveCause, { label: string; say: (m: Move) => string }> = {
  limit: { label: "Hit a limit", say: (m) => `Hit a limit on ${short(m.from)}, continued on ${short(m.to)}` },
  over: {
    label: "Past cutoff, moved while idle",
    say: (m) => `${short(m.from)} passed its cutoff; the recovery bridge moved it while idle`,
  },
  early: { label: "Moved early", say: (m) => `${short(m.from)} was close to its cutoff; moved early while idle` },
  restart: { label: "Restarted, reseated", say: (m) => `Restarted and the pool seated it on ${short(m.to)}; no limit was hit first` },
};

const CAUSE_ORDER: MoveCause[] = ["limit", "over", "early", "restart"];

const DAY_MS = 86_400_000;
const MOVES_SHOWN = 6;

function Moves({ pool }: { pool: Pool }) {
  const [all, setAll] = useState(false);
  const end = Date.parse(pool.at);
  const start = end - DAY_MS;
  const x = (at: string | number) => `${((new Date(at).getTime() - start) / DAY_MS) * 100}%`;
  const lane = new Map(pool.accounts.map((a, i) => [a.label, i]));

  const counts = CAUSE_ORDER.flatMap((cause) => {
    const count = pool.moves.filter((m) => m.cause === cause).length;

    return count ? [{ cause, count }] : [];
  });

  const ticks = Array.from({ length: 24 }, (_, i) => {
    const at = new Date(start + (i + 1) * 3_600_000);

    at.setMinutes(0, 0, 0);

    return at;
  }).filter((at) => at.getHours() % 6 === 0 && end - at.getTime() > 2 * 3_600_000);

  const shown = all ? pool.moves : pool.moves.slice(0, MOVES_SHOWN);

  return (
    <section className="moves">
      <div className="section-head">
        <h2>Account moves, last 24 hours</h2>
        <span className="muted small">
          {pool.starts.length} sessions started · {pool.moves.length} moved
        </span>
      </div>
      <div className="lanes">
        {pool.accounts.map((a, i) => (
          <div key={a.id} className="lane" data-hue={i}>
            <span className="lane-name" title={a.label}>
              <span className="swatch" />
              {short(a.label)}
            </span>
            <div className="lane-track">
              {pool.starts
                .filter((s) => s.account === a.label)
                .map((s) => (
                  <i
                    key={s.session}
                    className="start"
                    style={{ left: x(s.at) }}
                    title={`Session started ${new Date(s.at).toLocaleTimeString()}`}
                  />
                ))}
            </div>
          </div>
        ))}
        <div className="lane-overlay" style={{ height: `calc(${pool.accounts.length} * var(--lane))` }}>
          {pool.moves.map((m) => {
            const from = lane.get(m.from) ?? 0;
            const to = lane.get(m.to) ?? 0;

            return (
              <i
                key={`${m.session}${m.at}${m.to}`}
                className={`hop ${m.cause}`}
                data-down={to > from || undefined}
                style={{
                  left: x(m.at),
                  top: `calc(${Math.min(from, to) + 0.5} * var(--lane))`,
                  height: `calc(${Math.abs(to - from)} * var(--lane))`,
                }}
                title={`${new Date(m.at).toLocaleTimeString()} · ${m.name ?? m.session.slice(0, 8)}: ${CAUSES[m.cause].say(m)}`}
              />
            );
          })}
        </div>
        <div className="lane-axis">
          {ticks.map((at) => (
            <span key={at.getTime()} style={{ left: x(at.getTime()) }}>
              {at.toLocaleTimeString([], { hour: "numeric" })}
            </span>
          ))}
          <span className="now">now</span>
        </div>
      </div>
      <div className="seat-key muted small">
        <span>
          <i className="start-key" /> session started
        </span>
        {counts.map(({ cause, count }) => (
          <span key={cause}>
            <i className={`hop-key ${cause}`} /> {CAUSES[cause].label} <b className="num">{count}</b>
          </span>
        ))}
      </div>
      {pool.moves.length > 0 && (
        <ul className="thread-list move-list">
          {shown.map((m) => (
            <li key={`${m.session}${m.at}${m.to}`} className="thread on">
              <i className={`hop-key ${m.cause}`} />
              <span className="when num muted small">{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              <span className="tname">{m.name ?? <code>{m.session.slice(0, 8)}</code>}</span>
              <span className="move-path small">
                <span className="acct" data-hue={lane.get(m.from)}>
                  {short(m.from)}
                </span>
                →
                <span className="acct" data-hue={lane.get(m.to)}>
                  {short(m.to)}
                </span>
              </span>
              <span className="move-why muted small">{CAUSES[m.cause].say(m)}</span>
            </li>
          ))}
          {shown.length < pool.moves.length && (
            <li className="thread more-row">
              <button className="quiet small" onClick={() => setAll(true)}>
                Show {pool.moves.length - shown.length} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

const IDLE_SHOWN = 6;

function AppSection({ app, accounts, host }: { app: AppThreads; accounts: PoolAccount[]; host?: Host }) {
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
          {host?.seenAt != null && ` · checked in ${relativeTime(host.seenAt)}`}
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

const threadState = (t: Thread) =>
  !t.running ? ["dot off", "Not running"] : t.working === false ? ["dot idle", "Running, idle between turns"] : ["dot live", "Working"];

function ThreadRow({ thread, hue }: { thread: Thread; hue: number | null }) {
  const [dot, state] = threadState(thread);

  return (
    <li className={thread.running ? "thread on" : "thread"}>
      <span className={dot} title={state} />
      <span className="tname">{thread.name}</span>
      {thread.cwd && <span className="cwd">{thread.cwd.replace(/^\/(home|Users)\/[^/]+/, "~")}</span>}
      <span className="spacer" />
      {thread.account && (
        <span
          className={thread.working === null ? "acct past" : "acct"}
          data-hue={hue ?? undefined}
          title={thread.working === null ? `Last ran on ${thread.account}` : `Seated on ${thread.account}`}
        >
          {short(thread.account)}
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
