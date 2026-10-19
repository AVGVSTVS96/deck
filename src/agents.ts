import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { Agents, AppThreads, PoolAccount, Window } from "./types";

type ThreadEntry = { name?: string; session?: string; cwd?: string };

type PoolWindow = { usedPercentage: number; resetsAt: number; effectiveThreshold?: number } | null;

type RoutingAccount = {
  id: string;
  label: string;
  tier: string;
  needsReauth: boolean;
  eligible: boolean;
  heldSessions: number;
  reasons: string[];
  session: PoolWindow;
  week: PoolWindow;
};

type Binding = { sessionId: string; accountId: string; host?: string; name?: string | null; cwd?: string | null };

type Routing = { at: string; selectedAccountId: string; accounts: RoutingAccount[]; bindings?: Binding[] };

type PoolStatus = { bindings: Record<string, string> };

type LiveSession = { pid: number; sessionId: string; cwd: string; kind: string; startedAt: number };

const readSession = (path: string): Promise<LiveSession | null> =>
  Bun.file(path)
    .json()
    .catch(() => null);

async function liveSessions(config: Config) {
  const dir = join(config.claude, "sessions");
  const names = (await readdir(dir).catch(() => [])).filter((name) => /^\d+\.json$/.test(name));
  const sessions = await Promise.all(names.map((name) => readSession(join(dir, name))));

  return sessions.filter((s): s is LiveSession => s !== null && existsSync(`/proc/${s.pid}`));
}

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) }).catch(() => null);

  return response?.ok ? response.json() : null;
}

const toWindow = (window: PoolWindow): Window | null =>
  window ? { used: window.usedPercentage, resetsAt: window.resetsAt, threshold: window.effectiveThreshold ?? null } : null;

function threadLink(app: string, id: string) {
  if (app !== "telegram") return null;
  const [chat, topic] = id.split(":");
  const internal = chat.replace(/^-100/, "");

  return topic ? `https://t.me/c/${internal}/${topic}` : `https://t.me/c/${internal}`;
}

export async function agents(config: Config): Promise<Agents> {
  const state = join(config.hex, "state");
  const names = (await readdir(state).catch(() => [])).filter((name) => existsSync(join(state, name, "threads.json")));

  const [live, routing, status] = await Promise.all([
    liveSessions(config),
    config.tokenhub ? getJson<Routing>(`${config.tokenhub}/api/pool/routing`) : null,
    config.tokenhub ? getJson<PoolStatus>(`${config.tokenhub}/api/pool/status`) : null,
  ]);

  const running = new Set(live.map((s) => s.sessionId));

  const apps: AppThreads[] = await Promise.all(
    names.map(async (app) => {
      const threads: Record<string, ThreadEntry> = await Bun.file(join(state, app, "threads.json")).json();

      return {
        app,
        connected: existsSync(join(state, app, "hub.sock")),
        threads: Object.entries(threads).map(([id, entry]) => {
          return {
            id,
            name: entry.name ?? id,
            session: entry.session ?? null,
            cwd: entry.cwd ?? null,
            running: entry.session ? running.has(entry.session) : false,
            account: (entry.session && status?.bindings[entry.session]) || null,
            link: threadLink(app, id),
          };
        }),
      };
    }),
  );

  const known = new Set(apps.flatMap((app) => app.threads.map((t) => t.session)));
  const others = [...new Map(live.filter((s) => !known.has(s.sessionId)).map((s) => [s.sessionId, s])).values()];

  if (others.length) {
    apps.push({
      app: "other",
      connected: true,
      threads: others.map((s) => ({
        id: s.sessionId,
        name: `${s.kind === "bg" ? "Background" : "Interactive"} session`,
        session: s.sessionId,
        cwd: s.cwd,
        running: true,
        account: status?.bindings[s.sessionId] ?? null,
        link: null,
      })),
    });
  }

  const labels = new Map(routing?.accounts.map((account) => [account.id, account.label]));
  const elsewhere = (routing?.bindings ?? []).filter((b) => b.host && b.host !== "server");

  for (const [host, bindings] of Map.groupBy(elsewhere, (b) => b.host!)) {
    apps.push({
      app: host,
      connected: true,
      threads: bindings.map((b) => ({
        id: b.sessionId,
        name: b.name ?? "Claude session",
        session: b.sessionId,
        cwd: b.cwd ?? null,
        running: true,
        account: labels.get(b.accountId) ?? null,
        link: null,
      })),
    });
  }

  const accounts: PoolAccount[] | undefined = routing?.accounts.map((account) => ({
    id: account.id,
    label: account.label,
    tier: account.tier,
    needsReauth: account.needsReauth,
    eligible: account.eligible,
    selected: account.id === routing.selectedAccountId,
    held: account.heldSessions,
    session: toWindow(account.session),
    week: toWindow(account.week),
    reasons: account.reasons,
  }));

  return {
    apps,
    pool: accounts && routing ? { accounts, at: routing.at } : null,
    tokenhub: config.tokenhub,
  };
}
