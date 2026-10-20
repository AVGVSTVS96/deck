import { useState } from "react";
import type { AccountsView, LiveSession, Move, MoveCause } from "../../src/contract";
import { relativeTime, useApi, useLiveList } from "../api";
import { useWidth } from "../chart";
import { Empty, Link, useNow, when } from "../ui";

const STATE_ORDER = { blocked: 0, working: 1, idle: 2 } as const;

const APP_LABEL = new Map([
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["t3", "T3 Code"],
  ["buzz", "Buzz"],
]);

const appName = (app: string | null) => (app ? (APP_LABEL.get(app) ?? app) : "Jobs and other sessions");

export const CAUSE: Record<MoveCause, string> = {
  limit: "hit a limit",
  over: "over a cutoff",
  early: "moved early",
  restart: "restarted",
  start: "started",
};

const DAY = 86_400_000;

const SHOWN = 12;

export default function Live() {
  const sessions = useLiveList("s:").map(([, s]) => s);
  const accounts = useLiveList("a:").map(([, a]) => a);
  const view = useApi<AccountsView>("/accounts", "accounts");
  const name = (id: string | null) => (id === null ? "no account" : (accounts.find((a) => a.id === id)?.label ?? id));
  const sorted = sessions.toSorted((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.since - a.since);
  const blocked = sorted.filter((s) => s.state === "blocked");

  const groups = Map.groupBy(
    sorted.filter((s) => s.state !== "blocked"),
    (s) => s.app,
  );

  const count = (state: LiveSession["state"]) => sessions.filter((s) => s.state === state).length;
  const hosts = new Set(sessions.map((s) => s.host));
  const now = useNow();
  const cutoff = now - DAY;
  const moves = view.data?.moves.filter((m) => m.at >= cutoff).toSorted((a, b) => b.at - a.at) ?? [];
  const [allMoves, setAllMoves] = useState(false);

  return (
    <div className="page live">
      <header className="head">
        <div>
          <h1>Live</h1>
          <p className="lede">
            {count("working")} working · {count("idle")} idle · {count("blocked")} blocked, on {hosts.size}{" "}
            {hosts.size === 1 ? "host" : "hosts"}
          </p>
        </div>
        <AppDots />
      </header>

      {blocked.length > 0 && (
        <section className="section blocked" aria-labelledby="blocked-title">
          <div className="section-head">
            <h2 id="blocked-title">Blocked, waiting on you</h2>
          </div>
          <SessionTable sessions={blocked} name={name} />
        </section>
      )}

      <div className="split">
        <div className="main-col">
          {!sessions.length && <Empty>Nothing is running right now.</Empty>}
          {[...groups].map(([app, list]) => (
            <section key={app ?? "other"} className="section" aria-label={appName(app)}>
              <div className="section-head">
                <h2>{appName(app)}</h2>
                <span className="sub">
                  {list.filter((s) => s.state === "working").length} working · {list.filter((s) => s.state === "idle").length} idle
                </span>
              </div>
              <SessionTable sessions={list} name={name} />
            </section>
          ))}
        </div>

        <aside className="side">
          <section className="section" aria-labelledby="moves-title">
            <div className="section-head">
              <h2 id="moves-title">Last 24 hours</h2>
              <span className="sub">starts and account moves</span>
            </div>
            {moves.length > 0 && <Lanes moves={moves} accounts={accounts.map((a) => [a.id, a.label])} from={cutoff} />}
            {moves.length ? (
              <ol className="moves">
                {(allMoves ? moves : moves.slice(0, SHOWN)).map((m) => (
                  <li key={`${m.at}:${m.session}`}>
                    <span className="num muted">{when(m.at)}</span>
                    <span className="clip">
                      <b>{m.label ?? m.session.slice(0, 8)}</b> <span className={`cause ${m.cause}`}>{CAUSE[m.cause]}</span>
                    </span>
                    <span className="muted small move-path">
                      {m.from ? `${name(m.from)} → ` : "→ "}
                      {name(m.to)}
                    </span>
                  </li>
                ))}
                {moves.length > SHOWN && (
                  <li className="more">
                    <button className="small" onClick={() => setAllMoves(!allMoves)}>
                      {allMoves ? `Show the latest ${SHOWN}` : `Show all ${moves.length}`}
                    </button>
                  </li>
                )}
              </ol>
            ) : (
              <p className="pad muted">{view.error ?? (view.data ? "No starts or moves in the last day." : "Reading moves…")}</p>
            )}
          </section>

          <section className="section" aria-labelledby="hosts-title">
            <div className="section-head">
              <h2 id="hosts-title">Hosts</h2>
            </div>
            <table className="table">
              <caption className="sr">Hosts that hold seats</caption>
              <thead>
                <tr>
                  <th>Host</th>
                  <th className="n">Seats</th>
                  <th className="n">Checked in</th>
                </tr>
              </thead>
              <tbody>
                {(view.data?.hosts ?? []).map((h) => (
                  <tr key={h.host}>
                    <td>
                      <span className="who">
                        <span className={h.seenAt && now - h.seenAt < 10 * 60_000 ? "dot live" : "dot"} />
                        {h.host}
                      </span>
                    </td>
                    <td className="n">{h.seats}</td>
                    <td className="n muted">{h.seenAt ? relativeTime(h.seenAt) : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </aside>
      </div>
    </div>
  );
}

const LANE = 22;

/** One lane per account across the last day: a mark for every session that arrived on it, by cause. */
function Lanes({ moves, accounts, from }: { moves: Move[]; accounts: [id: string, label: string][]; from: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const ids = [...new Set([...accounts.map(([id]) => id), ...moves.map((m) => m.to)])];
  const label = new Map(accounts);
  const left = 8;
  const x = (t: number) => left + ((t - from) / DAY) * Math.max(0, width - left * 2);
  const height = ids.length * LANE + 20;
  const hours = [0, 6, 12, 18, 24].map((h) => from + h * 3_600_000);

  return (
    <div className="chart lanes pad" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${moves.length} starts and moves in the last 24 hours, by account`}>
          {ids.map((id, i) => (
            <g key={id} transform={`translate(0 ${i * LANE})`}>
              <line className="gridline" x1={left} x2={width - left} y1={LANE - 1} y2={LANE - 1} />
              <text className="tick" x={left} y={10}>
                {label.get(id) ?? id}
              </text>
              {moves
                .filter((m) => m.to === id)
                .map((m) => (
                  <rect key={`${m.at}:${m.session}`} className={`mark ${m.cause}`} x={x(m.at) - 1} y={12} width={2} height={8}>
                    <title>{`${m.label ?? m.session} ${CAUSE[m.cause]}, ${when(m.at)}`}</title>
                  </rect>
                ))}
            </g>
          ))}
          {hours.map((t, i) => (
            <text key={t} className="tick" x={x(t)} y={height - 4} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>
              {i === 4 ? "now" : when(t)}
            </text>
          ))}
        </svg>
      )}
      <div className="legend">
        <span>
          <i className="swatch mark-key start" /> started
        </span>
        <span>
          <i className="swatch mark-key restart" /> restarted or moved early
        </span>
        <span>
          <i className="swatch mark-key limit" /> hit a limit or cutoff
        </span>
      </div>
    </div>
  );
}

function AppDots() {
  const apps = useLiveList("app:");

  if (!apps.length) return null;

  return (
    <ul className="apps" aria-label="App connections">
      {apps.map(([app, { connected }]) => (
        <li key={app} className="chip">
          <span className={connected ? "dot live" : "dot"} />
          {appName(app)}
          <span className="sr">{connected ? "connected" : "not connected"}</span>
        </li>
      ))}
    </ul>
  );
}

function SessionTable({ sessions, name }: { sessions: LiveSession[]; name: (id: string | null) => string }) {
  return (
    <table className="table sessions-live">
      <thead>
        <tr>
          <th>Session</th>
          <th>Account</th>
          <th>Host</th>
          <th>Folder</th>
          <th className="n">Since</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <td>
              <span className="who">
                <span className={`dot ${s.state}`} aria-label={s.state} />
                <Link to={`/?sel=${encodeURIComponent(s.row)}`}>{s.label}</Link>
              </span>
            </td>
            <td className="clip">{name(s.account)}</td>
            <td>{s.host}</td>
            <td className="mono muted clip folder" title={s.cwd}>
              {s.cwd.replace(/^\/(home|Users)\/[^/]+/, "~")}
            </td>
            <td className="n muted">{relativeTime(s.since)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
