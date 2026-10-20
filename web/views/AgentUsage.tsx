import { useState } from "react";
import type { AgentUsage as Usage } from "../../src/types";
import { relativeTime, useLoad } from "../api";
import { Empty } from "../ui";

const RANGES = [
  { value: "today", label: "1 day" },
  { value: "7d", label: "1 week" },
  { value: "30d", label: "1 month" },
  { value: "6m", label: "6 months" },
];

const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const money = (value: number) => (value < 10 ? cents : dollars).format(value);

const resultTone = (result: string) => (result === "success" ? "chip live" : result === "failure" ? "chip bad" : "chip");

export function AgentUsage() {
  const [range, setRange] = useState("30d");
  const usage = useLoad<Usage>(`/agents/usage?range=${range}`);
  const data = usage.data;
  const most = Math.max(1, ...(data?.surfaces.map((s) => s.tokens) ?? []));

  return (
    <>
      <div className="usage-split">
        <section className="by-agent">
          <div className="section-head">
            <h2>Where usage is going</h2>
            <div className="seg" role="group" aria-label="Date range">
              {RANGES.map((r) => (
                <button
                  key={r.value}
                  className={r.value === range ? "on" : undefined}
                  aria-pressed={r.value === range}
                  onClick={() => setRange(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          {data ? (
            <div className="surface-table">
              <div className="surface-row head muted small">
                <span>Agent</span>
                <span>Tokens</span>
                <span className="r">Sessions</span>
                <span className="r" title="This usage's share of what your subscriptions cost">
                  Plan
                </span>
                <span className="r" title="What the same tokens would cost at API prices">
                  API
                </span>
              </div>
              {data.surfaces.map((s) => (
                <div key={s.name} className="surface-row">
                  <span className="tname">{s.name}</span>
                  <span className="surface-bar">
                    <span className="minitrack">
                      <span style={{ width: `${(s.tokens / most) * 100}%` }} />
                    </span>
                    <span className="num small">{tokens.format(s.tokens)}</span>
                  </span>
                  <span className="num r muted">{s.sessions}</span>
                  <span className="num r">{money(s.plan)}</span>
                  <span className="num r muted">{money(s.api)}</span>
                </div>
              ))}
              {data.surfaces.length === 0 && <p className="muted small">No measured activity in this range.</p>}
            </div>
          ) : (
            <Empty>{usage.error ?? "Reading usage…"}</Empty>
          )}
          <p className="muted small">
            Bars are tokens, so they hold still whichever price you read. Plan is this usage's share of your subscriptions; API is the list
            price.
          </p>
        </section>

        <section className="attention">
          <div className="section-head">
            <h2>Needs attention</h2>
            {data && <span className={data.blocked.length ? "chip bad" : "chip"}>{data.blocked.length}</span>}
          </div>
          <ul className="thread-list">
            {data?.blocked.map((job) => (
              <li key={job.id} className="thread on">
                <span className="dot warn" title="Blocked" />
                <span className="tname">{job.name}</span>
                <span className="spacer" />
                <span className="muted small">
                  {job.surface} · since {relativeTime(job.since)}
                </span>
              </li>
            ))}
            {data && data.blocked.length === 0 && <li className="thread muted small">No hex background session is blocked.</li>}
          </ul>
          <p className="muted small">Blocked native background sessions, matched to their hex threads.</p>
        </section>
      </div>

      {data && data.github.length > 0 && (
        <section className="github">
          <div className="section-head">
            <h2>GitHub agents</h2>
            <span className="muted small">
              {new Set(data.github.map((w) => w.repo)).size} repositories · {data.github.length} workflows
            </span>
          </div>
          <div className="gh-scroll">
            <table className="gh-table">
              <thead>
                <tr className="muted small">
                  <th>Repository</th>
                  <th>Workflow</th>
                  <th>Latest run</th>
                  <th className="r">Tokens</th>
                  <th>Models</th>
                  <th className="r">API value</th>
                </tr>
              </thead>
              <tbody>
                {data.github.map((w) => (
                  <tr key={`${w.repo}${w.name}${w.kind}`}>
                    <td>
                      <a className="open" href={w.url} target="_blank" rel="noreferrer">
                        {w.repo} ↗
                      </a>
                    </td>
                    <td>
                      {w.name}
                      <span className="muted small"> · {w.kind}</span>
                    </td>
                    <td>
                      {w.run ? (
                        <a className={resultTone(w.run.result)} href={w.run.url} target="_blank" rel="noreferrer">
                          {w.run.result}
                        </a>
                      ) : (
                        <span className="muted small">{w.missing}</span>
                      )}
                      <div className="muted small">{w.telemetry}</div>
                    </td>
                    <td className="num r">{w.tokens === null ? "—" : tokens.format(w.tokens)}</td>
                    <td className="muted small gh-models">{w.models.join(", ") || "Not recorded"}</td>
                    <td className="num r">{w.api === null ? "—" : cents.format(w.api)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Tokens and models are captured activity in this range. GitHub runners keep their own logins, so their account and plan share are
            unknown; empty captures and expired logs stay unknown.
          </p>
        </section>
      )}

      {data && (
        <details className="pool-notes">
          <summary>Coverage and measurement</summary>
          <dl className="facts">
            {data.coverage.map((c) => (
              <div key={c.name} className="coverage-row">
                <dt>
                  {c.name} <span className="chip">{c.status}</span>
                </dt>
                <dd>{c.detail}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small">
            Agent snapshot {relativeTime(data.at)}. Collectors update every five minutes; account quotas refresh separately.
          </p>
        </details>
      )}
    </>
  );
}
