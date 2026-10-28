import type { Config } from "./config";
import type { ActionsView } from "./contract";
import { source } from "./sources";
import type { Tracked } from "./tracker";

type Item = { date: string; unitType: string; quantity: number; netAmount: number; repositoryName?: string };

type Spend = { at: number; repo: string; minutes: number; billedUsd: number };

type Billing = { user: string; items: Spend[]; error: string | null };

const DAY = 86_400_000;
const DAYS = 7;

async function tokenOf(vault: string, user: string) {
  const run = Bun.spawn(["enclave", "get", vault, user], { stdout: "pipe", stderr: "pipe" });
  const [token, error] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);

  if (run.exitCode) throw new Error(`No ${user} token in the vault's ${vault}: ${error.trim()}`);

  return token.trim();
}

/** One UTC day of a user's metered GitHub usage; asked for by day, each item carries the time it was used. */
async function dayOf(user: string, token: string, at: number): Promise<Item[]> {
  const date = new Date(at);
  const query = `year=${date.getUTCFullYear()}&month=${date.getUTCMonth() + 1}&day=${date.getUTCDate()}`;

  const response = await fetch(`https://api.github.com/users/${user}/settings/billing/usage?${query}`, {
    headers: { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "deck" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`GitHub billing for ${user} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);

  return (await response.json()).usageItems ?? [];
}

async function billing(user: string, vault: string): Promise<Billing> {
  try {
    const token = await tokenOf(vault, user);
    const now = Date.now();
    const days = await Promise.all(Array.from({ length: DAYS + 1 }, (_, i) => dayOf(user, token, now - i * DAY)));

    const items = days.flat().map((item) => ({
      at: new Date(item.date).getTime(),
      repo: item.repositoryName ?? "",
      minutes: item.unitType.toLowerCase() === "minutes" ? item.quantity : 0,
      billedUsd: item.netAmount,
    }));

    return { user, items, error: null };
  } catch (error) {
    return { user, items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Actions minutes per GitHub account, read from each account's billing usage: no repo is watched or changed. */
export function github({ users, vault }: NonNullable<Config["github"]>, watching: () => boolean) {
  return source({
    name: "github billing",
    load: () => Promise.all(users.map((user) => billing(user, vault))),
    everyMs: 15 * 60_000,
    active: watching,
  });
}

/** The last week by local day: each GitHub account's Actions minutes by repo, and each Claude account's limit use no session here explains. */
export function actionsView(accounts: Billing[], tracked: Tracked | undefined, timezone: string): ActionsView {
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format;
  const now = Date.now();
  const days = [...new Set(Array.from({ length: DAYS }, (_, i) => dayKey(now - (DAYS - 1 - i) * DAY)))];
  const index = (at: number) => days.indexOf(dayKey(at));

  const spent = accounts.map(({ user, items, error }) => {
    const repos = new Map<string, number[]>();
    let minutes = 0;
    let billedUsd = 0;

    for (const item of items) {
      const i = index(item.at);

      if (i < 0) continue;
      billedUsd += item.billedUsd;

      if (!item.minutes) continue;
      minutes += item.minutes;
      const row = repos.get(item.repo) ?? days.map(() => 0);

      row[i] += item.minutes;
      repos.set(item.repo, row);
    }

    return { user, minutes, billedUsd, error, repos: [...repos].map(([repo, perDay]) => ({ repo, minutes: perDay })) };
  });

  const elsewhere = new Map<string, number[]>();

  for (const window of tracked?.windows ?? []) {
    if (window.kind !== "week") continue;

    for (const [at, points] of window.rises) {
      const i = index(at);

      if (i < 0) continue;
      const row = elsewhere.get(window.account) ?? days.map(() => 0);

      row[i] += points;
      elsewhere.set(window.account, row);
    }
  }

  return { days, github: spent, elsewhere: [...elsewhere].map(([account, points]) => ({ account, points })) };
}
