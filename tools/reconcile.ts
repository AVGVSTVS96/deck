import type { Tracked } from "../src/tracker";
import type { GroupBy, Range, UsageView } from "../src/contract";

const [deck = "http://127.0.0.1:4810", tracker = "http://127.0.0.1:8787", ...picked] = process.argv.slice(2);
const all: Range[] = ["today", "yesterday", "7d", "30d", "6m"];
const ranges = picked.length ? all.filter((range) => picked.includes(range)) : all;
const groupings: GroupBy[] = ["agent", "session", "project", "model", "harness", "device", "account"];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Totals = { tokens: number; costUSD: number; subscriptionUSD: number; requests: number; sessions: number };

async function trackerTotals(range: Range): Promise<Totals> {
  const request = {
    _tag: "Request",
    id: "0",
    tag: range === "yesterday" ? "GetSessionUsage" : "GetUsage",
    payload: { range, timezone },
    headers: [],
  };

  const response = await fetch(`${tracker}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: `${JSON.stringify(request)}\n`,
  });

  const frame = (await response.text()).split("\n").find((line) => line.includes('"Exit"')) ?? "{}";

  const value = JSON.parse(frame).exit.value;

  if (range !== "yesterday") return value.totals;
  const tracked: Tracked = value;

  return tracked.sessions.reduce(
    (total, session) => ({
      tokens: total.tokens + session.amount.tokens,
      costUSD: total.costUSD + session.amount.apiUsd,
      subscriptionUSD: total.subscriptionUSD + session.amount.planUsd,
      requests: total.requests + session.amount.requests,
      sessions: total.sessions + 1,
    }),
    { tokens: 0, costUSD: 0, subscriptionUSD: 0, requests: 0, sessions: 0 },
  );
}

const deckUsage = async (range: Range, by: GroupBy): Promise<UsageView> =>
  (await fetch(`${deck}/api/usage?range=${range}&by=${by}&limit=1000000`)).json();

const off = (a: number, b: number) => (b ? Math.abs(a - b) / b : Math.abs(a));
let worst = 0;

for (const range of ranges) {
  const [truth, views] = await Promise.all([trackerTotals(range), Promise.all(groupings.map((by) => deckUsage(range, by)))]);
  const { totals } = views[0];

  const checks: [string, number, number][] = [
    ["tokens", totals.tokens, truth.tokens],
    ["API $", totals.apiUsd, truth.costUSD],
    ["plan $", totals.planUsd, truth.subscriptionUSD],
    ["requests", totals.requests, truth.requests],
    ["sessions", totals.sessions, truth.sessions],
  ];

  for (const view of views) {
    const rows = view.rows.reduce((sum, row) => ({ tokens: sum.tokens + row.amount.tokens, api: sum.api + row.amount.apiUsd }), {
      tokens: 0,
      api: 0,
    });

    checks.push(
      [`rows by ${view.query.by}, tokens`, rows.tokens, totals.tokens],
      [`rows by ${view.query.by}, API $`, rows.api, totals.apiUsd],
    );
  }

  console.log(`\n${range}`);

  for (const [name, mine, theirs] of checks) {
    worst = Math.max(worst, off(mine, theirs));
    console.log(
      `  ${name.padEnd(26)} deck ${mine.toFixed(2).padStart(18)}  against ${theirs.toFixed(2).padStart(18)}  off ${(off(mine, theirs) * 100).toFixed(4)}%`,
    );
  }
}

console.log(`\nworst ${(worst * 100).toFixed(4)}%`);

const onePercent = 0.01;

process.exitCode = worst <= onePercent ? 0 : 1;
