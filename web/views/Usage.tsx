import { useEffect, useRef, useState } from "react";
import type { Bucket, Dimension, GroupBy, Measure, Range, Totals, UsageRow, UsageView } from "../../src/contract";
import { api, setParams, useApi, useLive, useLiveList, useSearch } from "../api";
import { Columns, Spark } from "../chart";
import { Empty, Link, Meter, STANDING, Seg, fail, fmt, when } from "../ui";

const RANGES = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["6m", "6 months"],
] as const satisfies readonly (readonly [Range, string])[];

const GROUPS = [
  ["agent", "Agents"],
  ["session", "Sessions"],
  ["project", "Projects"],
  ["model", "Models"],
  ["harness", "Harnesses"],
  ["device", "Devices"],
  ["account", "Accounts"],
] as const satisfies readonly (readonly [GroupBy, string])[];

const usdAxis = (n: number) => `$${fmt.axis(n)}`;

const MEASURES = [
  ["tokens", "Tokens", (r: UsageRow) => r.amount.tokens, fmt.tokens, fmt.axis],
  ["api", "API value", (r: UsageRow) => r.amount.apiUsd, fmt.usd, usdAxis],
  ["plan", "Plan cost", (r: UsageRow) => r.amount.planUsd, fmt.usd, usdAxis],
  ["fiveHour", "5h points", (r: UsageRow) => r.points.fiveHour ?? 0, fmt.pts, fmt.pts],
  ["week", "Week points", (r: UsageRow) => r.points.week ?? 0, fmt.pts, fmt.pts],
] as const satisfies readonly (readonly [Measure, string, (r: UsageRow) => number, (n: number) => string, (n: number) => string])[];

const DIMENSIONS: [Dimension, string][] = [
  ["app", "Apps"],
  ["harness", "Harnesses"],
  ["model", "Models"],
  ["project", "Projects"],
  ["device", "Devices"],
  ["account", "Accounts"],
];

const PAGE = 50;
const PHONE_ROWS = 10;

const oneOf = <T extends string>(options: readonly (readonly [T, ...unknown[]])[], value: string | null, fallback: T) =>
  options.find(([v]) => v === value)?.[0] ?? fallback;

function useQueryState() {
  const params = new URLSearchParams(useSearch());
  const where = DIMENSIONS.flatMap(([d]) => (params.get(`w.${d}`) ? [[d, params.get(`w.${d}`)!.split(",")] as const] : []));

  return {
    range: oneOf(RANGES, params.get("range"), "7d"),
    by: oneOf(GROUPS, params.get("by"), "agent"),
    measure: oneOf(MEASURES, params.get("measure"), "api"),
    where,
    q: params.get("q") ?? "",
    selected: params.get("sel"),
    all: params.has("all"),
  };
}

type State = ReturnType<typeof useQueryState>;

function usagePath(s: Pick<State, "range" | "by" | "measure" | "where" | "q">, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ range: s.range, by: s.by, measure: s.measure });

  for (const [d, values] of s.where) params.set(`w.${d}`, values.join(","));

  if (s.q) params.set("q", s.q);

  for (const [k, v] of Object.entries(extra)) params.set(k, v);

  return `/usage?${params}`;
}

/** Keeps the last answer on screen while a new query loads, so the frame never jumps. */
function useKept<T>(data: T | null) {
  const [kept, setKept] = useState(data);

  if (data && data !== kept) setKept(data);

  return data ?? kept;
}

const tickOf = (b: Bucket, i: number) => {
  const d = new Date(b.at);

  if (b.size === "1h") return d.getHours() % 3 === 0 ? d.toLocaleTimeString("en", { hour: "numeric" }) : "";

  if (b.size === "4h") return d.getHours() < 4 ? d.toLocaleDateString("en", { weekday: "short", day: "numeric" }) : "";

  if (b.size === "1d")
    return d.getDate() === 1 || i === 0 ? d.toLocaleDateString("en", { month: "short", day: "numeric" }) : String(d.getDate());

  return d.toLocaleDateString("en", { month: "short", day: "numeric" });
};

const titleOf = (b: Bucket) => {
  const d = new Date(b.at);

  if (b.size === "1h") return d.toLocaleString("en", { weekday: "short", hour: "numeric" });

  if (b.size === "4h") return `${d.toLocaleString("en", { weekday: "short", month: "short", day: "numeric", hour: "numeric" })}, 4 hours`;

  if (b.size === "1d") return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });

  return `Week of ${d.toLocaleDateString("en", { month: "short", day: "numeric" })}`;
};

export default function Usage() {
  const state = useQueryState();
  const { range, by, measure, selected } = state;
  const path = usagePath(state, state.all ? { limit: "100000" } : { limit: String(PAGE) });
  const usage = useApi<UsageView>(path, "usage");
  const view = useKept(usage.data);
  const m = MEASURES.find(([key]) => key === measure)!;

  if (!view) return usage.error ? <Empty>{usage.error}</Empty> : <Empty>Reading usage…</Empty>;

  const chosen = view.rows.find((r) => r.key === selected) ?? null;

  return (
    <div className={usage.fetching && !usage.data ? "page usage fade dim" : "page usage fade"}>
      <header className="head">
        <div>
          <h1>Usage</h1>
          <p className="lede">
            {period(view)} · {view.period.timezone} ·{" "}
            {view.sources.devices.length === 1 ? view.sources.devices[0].label : `${view.sources.devices.length} devices`}
          </p>
        </div>
        <Seg label="Range" value={range} options={RANGES} onChange={(v) => setParams({ range: v, sel: null })} />
        <button onClick={() => void exportCsv(state, view)}>Export CSV</button>
      </header>

      <Filters state={state} view={view} />

      {view.sources.trackerError && (
        <p className="alert">token-tracker didn't answer: {view.sources.trackerError}. These numbers are from its last good read.</p>
      )}

      <Summary totals={view.totals} previous={view.previous} />

      <div className="split">
        <div className="main-col">
          <section className="section ranking" aria-labelledby="ranking-title">
            <div className="section-head">
              <h2 id="ranking-title">
                Usage by{" "}
                {GROUPS.find(([g]) => g === by)![1]
                  .toLowerCase()
                  .replace(/s$/, "")}
              </h2>
              <Seg label="Group by" value={by} options={GROUPS} onChange={(v) => setParams({ by: v, sel: null, all: null })} />
              <span className="spacer" />
              <Search value={state.q} />
              <label className="sort">
                <span className="muted small">Sort</span>
                <select value={measure} onChange={(e) => setParams({ measure: e.currentTarget.value })}>
                  {MEASURES.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label} ↓
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Ranking view={view} measure={m} selected={selected} all={state.all} />
            <div className="table-foot muted small">
              <span>
                {fmt.int(view.rowCount)} {view.rowCount === 1 ? "group" : "groups"} · {fmt.int(view.totals.sessions)} sessions
                {view.coverage.totalApiUsd > 0 && ` · named ${fmt.pct(view.coverage.namedApiUsd / view.coverage.totalApiUsd)} of API value`}
              </span>
              {view.rowCount > view.rows.length && (
                <button className="small" onClick={() => setParams({ all: "1" })}>
                  Show all {fmt.int(view.rowCount)}
                </button>
              )}
              {state.all && view.rowCount > PAGE && (
                <button className="small" onClick={() => setParams({ all: null })}>
                  Show top {PAGE}
                </button>
              )}
            </div>
          </section>

          <section className="section activity" aria-labelledby="activity-title">
            <div className="section-head">
              <h2 id="activity-title">Activity</h2>
              <span className="sub">
                {m[1]} per {bucketWord(view.buckets[0])}, top seven and the rest
              </span>
            </div>
            <div className="pad">
              <Columns
                labels={view.buckets.map(tickOf)}
                titles={view.buckets.map(titleOf)}
                series={view.series}
                format={m[3]}
                axis={m[4]}
                caption={`${m[1]} per ${bucketWord(view.buckets[0])} for the top seven ${by}s`}
              />
            </div>
          </section>
        </div>

        <aside className="side">
          <Limits />
          <Detail view={view} row={chosen ?? view.rows[0] ?? null} picked={chosen !== null} state={state} />
        </aside>
      </div>

      <Footer view={view} />
    </div>
  );
}

const period = (view: UsageView) => {
  const from = new Date(view.period.from);
  const to = new Date(view.period.to);
  const day = { month: "short", day: "numeric" } as const;

  return from.toDateString() === to.toDateString()
    ? to.toLocaleDateString("en", { weekday: "long", ...day })
    : `${from.toLocaleDateString("en", day)} – ${to.toLocaleDateString("en", day)}`;
};

const bucketWord = (b: Bucket | undefined) =>
  !b ? "bucket" : b.size === "1h" ? "hour" : b.size === "4h" ? "4 hours" : b.size === "1d" ? "day" : "week";

function Search({ value }: { value: string }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);

  if (value !== seen) {
    setSeen(value);
    setText(value);
  }

  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => setParams({ q: text, sel: null }, true), 250);

    return () => clearTimeout(timer);
  }, [text, value]);

  return (
    <input
      type="search"
      className="search"
      aria-label="Search rows"
      placeholder="Search names, projects…"
      value={text}
      onChange={(e) => setText(e.currentTarget.value)}
    />
  );
}

function Filters({ state, view }: { state: State; view: UsageView }) {
  const active = new Map(state.where);

  return (
    <div className="filters" role="group" aria-label="Filters">
      {DIMENSIONS.map(([d, label]) => (
        <Facet
          key={d}
          label={label}
          options={view.facets[d] ?? []}
          chosen={active.get(d) ?? []}
          onChange={(values) => setParams({ [`w.${d}`]: values.join(","), sel: null })}
        />
      ))}
      {state.where.flatMap(([d, values]) =>
        values.map((v) => (
          <button
            key={`${d}:${v}`}
            className="chip on"
            aria-label={`Remove filter ${v}`}
            onClick={() => setParams({ [`w.${d}`]: values.filter((x) => x !== v).join(","), sel: null })}
          >
            {view.facets[d]?.find((f) => f.id === v)?.label ?? v} ✕
          </button>
        )),
      )}
      {state.where.length > 0 && (
        <button className="quiet small" onClick={() => setParams(Object.fromEntries(DIMENSIONS.map(([d]) => [`w.${d}`, null])))}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function Facet({
  label,
  options,
  chosen,
  onChange,
}: {
  label: string;
  options: { id: string; label: string; count: number }[];
  chosen: string[];
  onChange: (values: string[]) => void;
}) {
  const [find, setFind] = useState("");
  const shown = options.filter((o) => o.label.toLowerCase().includes(find.toLowerCase()));
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      // SAFETY: pointer events on the document always target a DOM node.
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };

    document.addEventListener("pointerdown", close);

    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <details
      className="facet"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !ref.current?.open) return;
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }}
    >
      <summary className="button">
        {label}
        {chosen.length > 0 && <span className="count">{chosen.length}</span>} ▾
      </summary>
      <div className="facet-menu">
        {options.length > 8 && (
          <input
            type="search"
            aria-label={`Find ${label.toLowerCase()}`}
            placeholder="Find…"
            value={find}
            onChange={(e) => setFind(e.currentTarget.value)}
          />
        )}
        {shown.map((o) => (
          <label key={o.id} className="facet-option">
            <input
              type="checkbox"
              checked={chosen.includes(o.id)}
              onChange={(e) => onChange(e.currentTarget.checked ? [...chosen, o.id] : chosen.filter((c) => c !== o.id))}
            />
            <span>{o.label}</span>
            <span className="muted num">{o.count}</span>
          </label>
        ))}
        {!shown.length && <p className="muted small">Nothing matches.</p>}
      </div>
    </details>
  );
}

function Delta({ now, then, unit = "%" }: { now: number; then: number | undefined; unit?: "%" | "count" }) {
  if (then === undefined || then === 0) return null;
  const change = unit === "%" ? (now - then) / then : now - then;
  const text = unit === "%" ? `${Math.abs(Math.round(change * 100))}%` : fmt.int(Math.abs(change));

  return (
    <span className="delta" title="Compared with the previous period of the same length">
      {change >= 0 ? "▲" : "▼"} {text}
    </span>
  );
}

function Summary({ totals, previous }: { totals: Totals; previous: Totals | null }) {
  const cells = [
    {
      label: "Tokens",
      value: fmt.tokens(totals.tokens),
      delta: <Delta now={totals.tokens} then={previous?.tokens} />,
      foot: `${fmt.pct(totals.cacheHitRate)} cache hit · ${fmt.tokens(totals.requests)} requests`,
    },
    {
      label: "API value",
      value: fmt.usd(totals.apiUsd),
      delta: <Delta now={totals.apiUsd} then={previous?.apiUsd} />,
      foot: "The same use at API prices",
    },
    {
      label: "Plan cost",
      value: fmt.usd(totals.planUsd),
      delta: <Delta now={totals.planUsd} then={previous?.planUsd} />,
      foot: "Monthly fees spread over use",
    },
    {
      label: "Limit points",
      value: totals.points.week === null ? "–" : fmt.pts(totals.points.week),
      delta: null,
      foot: `week · ${fmt.pts(totals.points.fiveHour)} five-hour, all accounts`,
    },
    {
      label: "Sessions",
      value: fmt.int(totals.sessions),
      delta: <Delta now={totals.sessions} then={previous?.sessions} unit="count" />,
      foot: totals.unpricedTokens ? `${fmt.tokens(totals.unpricedTokens)} tokens unpriced` : "with any use in range",
    },
  ];

  return (
    <dl className="summary">
      {cells.map((c) => (
        <div key={c.label}>
          <dt>{c.label}</dt>
          <dd>
            <span className="figure">{c.value}</span>
            {c.delta}
          </dd>
          <dd className="muted small">{c.foot}</dd>
        </div>
      ))}
    </dl>
  );
}

type MeasureDef = (typeof MEASURES)[number];

const shortAccount = (label: string) => label.split("@")[0];

function Ranking({ view, measure, selected, all }: { view: UsageView; measure: MeasureDef; selected: string | null; all: boolean }) {
  const [key, , value] = measure;
  const accounts = useLiveList("a:");
  const accountLabel = (id: string) => (id ? (accounts.find(([k]) => k === id)?.[1].label ?? id) : "none");
  const max = Math.max(...view.rows.map(value), 0) || 1;

  const sorted: [Measure, string, string][] = [
    ["tokens", "Tokens", "tokens"],
    ["api", "API $", "api"],
    ["plan", "Plan $", "plan"],
    ["fiveHour", "5h pts", "pts"],
    ["week", "Week pts", "pts"],
  ];

  if (!view.rows.length)
    return (
      <Empty>
        {view.query.search || Object.keys(view.query.where).length
          ? "Nothing matches these filters and search."
          : "No usage in this range yet."}
      </Empty>
    );

  return (
    <div className="table-wrap">
      <table className="table rank" data-all={all || undefined}>
        <caption className="sr">Usage ranked by {measure[1].toLowerCase()}. Select a row for its sessions and limit detail.</caption>
        <thead>
          <tr>
            <th className="n idx">#</th>
            <th>Name</th>
            <th className="share">Share · activity</th>
            <th className="accts">Accounts</th>
            {sorted.map(([k, label]) => (
              <th key={k} className="n" aria-sort={k === key ? "descending" : undefined}>
                <button onClick={() => setParams({ measure: k })}>
                  {label}
                  {k === key && " ↓"}
                </button>
              </th>
            ))}
            <th className="n last">Last</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r, i) => (
            <tr
              key={r.key}
              data-row
              tabIndex={0}
              aria-selected={r.key === selected}
              onClick={() => setParams({ sel: r.key === selected ? null : r.key })}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setParams({ sel: r.key === selected ? null : r.key });
              }}
            >
              <td className="n idx mono">{String(i + 1).padStart(2, "0")}</td>
              <td className="name">
                <span className="who">
                  <i className="swatch" data-c={r.color} />
                  <b>{r.label}</b>
                  {r.live && <span className={`dot ${r.live}`} title={r.live} aria-label={r.live} />}
                </span>
                <span className="muted small">{r.detail}</span>
              </td>
              <td className="share">
                <span className="bar" data-c={r.color}>
                  <i style={{ width: `${(value(r) / max) * 100}%` }} />
                </span>
                <Spark values={r.series} color={r.color} />
              </td>
              <td className="accts muted small">{r.byAccount.map((a) => shortAccount(accountLabel(a.account))).join(" · ") || "–"}</td>
              <td className="n" data-label="Tokens">
                {fmt.tokens(r.amount.tokens)}
              </td>
              <td className="n" data-label="API $">
                {fmt.usd(r.amount.apiUsd)}
              </td>
              <td className="n" data-label="Plan $">
                {fmt.usd(r.amount.planUsd)}
              </td>
              <td className="n" data-label="5h pts">
                {fmt.pts(r.points.fiveHour)}
              </td>
              <td className="n" data-label="Week pts">
                {fmt.pts(r.points.week)}
              </td>
              <td className="n last muted" data-label="Last">
                {when(r.lastActiveAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!all && view.rows.length > PHONE_ROWS && (
        <button className="phone-more" onClick={() => setParams({ all: "1" })}>
          Show all {fmt.int(view.rowCount)}
        </button>
      )}
    </div>
  );
}

function Limits() {
  const accounts = useLiveList("a:").map(([, a]) => a);
  const pool = useLive("pool");
  const order = pool?.order ?? [];
  const ranked = accounts.toSorted((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

  return (
    <section className="section" aria-labelledby="limits-title">
      <div className="section-head">
        <h2 id="limits-title">Current limits</h2>
        <span className="spacer" />
        <Link to="/accounts">Accounts →</Link>
      </div>
      <div className="pad limits">
        {!ranked.length && <p className="muted">No account readings yet.</p>}
        {ranked.map((a) => (
          <div key={a.id} className="limit">
            <div className="limit-name">
              <b>{a.label}</b>
              {a.id === pool?.next && <span className="chip next">next</span>}
              <span className="muted small">{STANDING[a.standing]}</span>
            </div>
            <div className="limit-meters">
              <Meter label="5 hours" window={a.fiveHour} />
              <Meter label="Week" window={a.week} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Detail({ view, row, picked, state }: { view: UsageView; row: UsageRow | null; picked: boolean; state: State }) {
  const accounts = useLiveList("a:").map(([, a]) => a);
  const name = (id: string) => (id ? (accounts.find((a) => a.id === id)?.label ?? id) : "No account");
  const drills = state.by === "agent" && row !== null && row.sessions > 1;

  const sessions = useApi<UsageView>(
    drills ? usagePath({ ...state, by: "session", q: "" }, { within: row.key, limit: "12" }) : null,
    "usage",
  );

  if (!row) return null;
  const weekTotal = row.byAccount.reduce((n, a) => n + (a.week ?? 0), 0) || 1;

  return (
    <section className="section detail" aria-labelledby="detail-title" aria-live="polite">
      <div className="section-head">
        <div>
          <h2 id="detail-title">{row.label}</h2>
          <p className="muted small">{picked ? row.detail : `Top row · ${row.detail}`}</p>
        </div>
        <span className="spacer" />
        {row.who && "href" in row.who && row.who.href && (
          <a href={row.who.href} target="_blank" rel="noreferrer">
            Open ↗
          </a>
        )}
        {picked && (
          <button className="quiet small" onClick={() => setParams({ sel: null })} aria-label="Close detail">
            ✕
          </button>
        )}
      </div>
      <div className="pad">
        <div className="figures">
          <div>
            <span className="figure">{fmt.pts(row.points.fiveHour)}</span>
            <span className="muted small">5-hour limit points</span>
          </div>
          <div>
            <span className="figure">{fmt.pts(row.points.week)}</span>
            <span className="muted small">Weekly limit points</span>
          </div>
          <div>
            <span className="figure">{fmt.usd(row.amount.apiUsd)}</span>
            <span className="muted small">{fmt.tokens(row.amount.tokens)} tokens</span>
          </div>
        </div>

        {row.byAccount.length > 0 ? (
          <table className="table by-account">
            <caption className="sr">Limit points by account</caption>
            <thead>
              <tr>
                <th>Account</th>
                <th className="n">5h</th>
                <th className="n">Week</th>
                <th className="share">Share of week</th>
              </tr>
            </thead>
            <tbody>
              {row.byAccount.map((a) => (
                <tr key={a.account}>
                  <td>{name(a.account)}</td>
                  <td className="n">{fmt.pts(a.fiveHour)}</td>
                  <td className="n">{fmt.pts(a.week)}</td>
                  <td className="share">
                    <span className="bar ink">
                      <i style={{ width: `${((a.week ?? 0) / weekTotal) * 100}%` }} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">No limit readings cover this row's use, so its share of account limits is unknown.</p>
        )}

        {drills && (
          <div className="drill">
            <h3 className="small muted">Sessions</h3>
            {sessions.data ? (
              <ul className="sessions">
                {sessions.data.rows.map((s) => (
                  <li key={s.key}>
                    <span className="clip">{s.label}</span>
                    <span className="num">{fmt.tokens(s.amount.tokens)}</span>
                    <span className="num">{fmt.usd(s.amount.apiUsd)}</span>
                    <span className="num muted">{when(s.lastActiveAt)}</span>
                  </li>
                ))}
                {sessions.data.rowCount > sessions.data.rows.length && (
                  <li className="muted small">
                    and {sessions.data.rowCount - sessions.data.rows.length} more ·{" "}
                    <Link to={`/?${new URLSearchParams({ range: state.range, by: "session", measure: state.measure, q: row.label })}`}>
                      see all
                    </Link>
                  </li>
                )}
              </ul>
            ) : (
              <p className="muted small">{sessions.error ?? "Reading sessions…"}</p>
            )}
          </div>
        )}

        {view.coverage.unassigned.length > 0 && (
          <div className="drill">
            <h3 className="small muted">Not tied to any session this period</h3>
            <ul className="sessions">
              {view.coverage.unassigned.map((u) => (
                <li key={`${u.account}:${u.kind}`}>
                  <span className="clip">{name(u.account)}</span>
                  <span className="muted">{u.kind === "week" ? "week" : "5h"}</span>
                  <span className="num">{fmt.pts(u.points)} pts</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="muted small">
          Points are estimates: each rise in an account's limit reading is split across the sessions using it then, by API value.
          {view.coverage.limitsSince && ` Readings start ${when(view.coverage.limitsSince)}.`}
        </p>
      </div>
    </section>
  );
}

function Footer({ view }: { view: UsageView }) {
  const { coverage, sources } = view;

  return (
    <footer className="foot muted small">
      {coverage.totalApiUsd > 0 && <span>Named threads and jobs: {fmt.pct(coverage.namedApiUsd / coverage.totalApiUsd)} of API value</span>}
      <span>Limit readings since {coverage.limitsSince ? when(coverage.limitsSince) : "never"}</span>
      <span>token-tracker read {sources.trackerAt ? when(sources.trackerAt) : "never"}</span>
      {sources.devices.map((d) => (
        <span key={d.id}>
          {d.label} synced {d.syncedAt ? when(d.syncedAt) : "never"}
        </span>
      ))}
    </footer>
  );
}

const csvCell = (v: string | number | null) => {
  const text = String(v ?? "");

  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

async function exportCsv(state: State, view: UsageView) {
  try {
    const all = await api<UsageView>(usagePath(state, { limit: String(Math.max(view.rowCount, 1)) }));

    const head = [
      "key",
      "label",
      "detail",
      "tokens",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "requests",
      "apiUsd",
      "planUsd",
      "fiveHourPoints",
      "weekPoints",
      "sessions",
      "lastActive",
    ];

    const lines = all.rows.map((r) =>
      [
        r.key,
        r.label,
        r.detail,
        r.amount.tokens,
        r.amount.input,
        r.amount.output,
        r.amount.cacheRead,
        r.amount.cacheWrite,
        r.amount.requests,
        r.amount.apiUsd.toFixed(4),
        r.amount.planUsd.toFixed(4),
        r.points.fiveHour,
        r.points.week,
        r.sessions,
        new Date(r.lastActiveAt).toISOString(),
      ]
        .map(csvCell)
        .join(","),
    );

    const link = document.createElement("a");

    link.href = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }));
    link.download = `deck-usage-${state.range}-${state.by}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
