import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import type { AgentUsage, Agents, AppThreads, Host, Move, MoveCause, Policy, PoolAccount, Start, Window } from "./types";

type ThreadEntry = { name?: string; session?: string; cwd?: string };

type PoolWindow = { usedPercentage: number; resetsAt: number; sampledAt: number | null; effectiveThreshold?: number } | null;

type RoutingAccount = {
  id: string;
  label: string;
  tier: string;
  needsReauth: boolean;
  eligible: boolean;
  selectionPool: "open" | "capacity-fallback" | "blocked";
  heldSessions: number;
  waitingSessions: number;
  headroom: { remainingPercentagePoints: number; divisor: number; score: number | null; minimum: number } | null;
  usageAgeMs: number | null;
  usageStale: boolean;
  reasons: string[];
  session: PoolWindow;
  week: PoolWindow;
};

type Binding = { sessionId: string; accountId: string; waiting: boolean; host?: string; name?: string | null; cwd?: string | null };

type Routing = {
  at: string;
  revision: string;
  config: Policy;
  selectedAccountId: string | null;
  rankedAccountIds: string[];
  accounts: RoutingAccount[];
  bindings: Binding[];
  notes: string[];
};

type Job = { id: string; sessionId?: string; name: string; surface: string; state: string; updatedAt?: string };

type GithubRun = { at: string; url: string; workflowPath: string; tokens?: number; costUSD: number; models: string[] };

type PoolStatus = {
  generatedAt: string;
  bindings: Record<string, string>;
  jobs: Job[];
  surfaces: { name: string; tokens: number; costUSD: number; subscriptionUSD?: number; sessions: number }[];
  github: {
    repo: string;
    url: string;
    workflows: {
      path: string;
      name: string;
      kind: string;
      telemetry: string;
      sourceAvailable: boolean;
      run: { status: string; conclusion: string | null; url: string } | null;
    }[];
    history: GithubRun[];
    activity: GithubRun[];
  }[];
  coverage: AgentUsage["coverage"];
};

type Logged = { at: string; sessionId?: string; accountId?: string; event?: string | null; from?: string; level?: string };

const tokenhubState = join(homedir(), ".local/state/tokenhub");
const MOVES_MS = 86_400_000;
const SAME_MOVE_MS = 300_000;

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

async function readLog(name: string): Promise<Logged[]> {
  const text = await Bun.file(join(tokenhubState, name))
    .text()
    .catch(() => "");

  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function history(since: number) {
  const [attribution, recovery] = await Promise.all([readLog("attribution.ndjson"), readLog("recovery.ndjson")]);
  const bound = attribution.filter((r) => (r.event === "start" || r.event === "failure") && r.sessionId && r.accountId);
  const sessions = Map.groupBy(bound, (r) => r.sessionId!);
  const moves: Omit<Move, "name">[] = [];
  const starts: Start[] = [];

  for (const [session, rows] of sessions) {
    rows.forEach((row, i) => {
      const before = rows[i - 1];

      if (Date.parse(row.at) < since || before?.accountId === row.accountId) return;

      if (!before) starts.push({ at: row.at, account: row.accountId! });
      else
        moves.push({
          at: row.at,
          session,
          from: before.accountId!,
          to: row.accountId!,
          cause: before.event === "failure" ? "limit" : "restart",
        });
    });
  }

  for (const row of recovery) {
    if (!row.sessionId || !row.accountId || Date.parse(row.at) < since) continue;

    const { sessionId, accountId, at } = row;
    const cause: MoveCause = row.event === "move" ? (row.level === "soon" ? "early" : "over") : "limit";
    const from = row.from ?? sessions.get(sessionId)?.findLast((r) => r.at <= at)?.accountId;

    const same = moves.findIndex(
      (m) => m.session === sessionId && m.to === accountId && Math.abs(Date.parse(m.at) - Date.parse(at)) < SAME_MOVE_MS,
    );

    if (same >= 0) moves[same].cause = cause;
    else if (from && from !== accountId) moves.push({ at, session: sessionId, from, to: accountId, cause });
  }

  return { moves: moves.toSorted((a, b) => b.at.localeCompare(a.at)), starts };
}

const seenAt = (path: string) =>
  stat(path).then(
    (s) => s.mtimeMs,
    () => null,
  );

async function hosts(bindings: Binding[]): Promise<Host[]> {
  const remote = join(tokenhubState, "remote");
  const names = (await readdir(remote).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  const seen = await Promise.all(names.map((name) => seenAt(join(remote, `${name}.json`))));
  const count = (host: string) => bindings.filter((b) => (b.host ?? "server") === host).length;

  return [
    { host: "server", seenAt: null, seats: count("server") },
    ...names.map((host, i) => ({ host, seenAt: seen[i], seats: count(host) })),
  ];
}

function threadLink(app: string, id: string) {
  if (app !== "telegram") return null;
  const [chat, topic] = id.split(":");
  const internal = chat.replace(/^-100/, "");

  return topic ? `https://t.me/c/${internal}/${topic}` : `https://t.me/c/${internal}`;
}

const standing = (account: RoutingAccount) => (account.selectionPool === "capacity-fallback" ? "tight" : account.selectionPool);

export async function agents(config: Config): Promise<Agents> {
  const state = join(config.hex, "state");
  const names = (await readdir(state).catch(() => [])).filter((name) => existsSync(join(state, name, "threads.json")));

  const [live, routing, status, logged] = await Promise.all([
    liveSessions(config),
    config.tokenhub ? getJson<Routing>(`${config.tokenhub}/api/pool/routing`) : null,
    config.tokenhub ? getJson<PoolStatus>(`${config.tokenhub}/api/pool/status`) : null,
    config.tokenhub ? history(Date.now() - MOVES_MS) : null,
  ]);

  const running = new Set(live.map((s) => s.sessionId));
  const labels = new Map(routing?.accounts.map((account) => [account.id, account.label]));
  const bindings = routing?.bindings ?? [];
  const seats = new Map(bindings.map((b) => [b.sessionId, b]));
  const seatOf = (session: string | null) => (session ? seats.get(session) : undefined);

  const accountOf = (session: string | null) => {
    const seat = seatOf(session);

    return (seat && labels.get(seat.accountId)) ?? (session && status?.bindings[session]) ?? null;
  };

  const working = (session: string | null) => {
    const seat = seatOf(session);

    return seat ? !seat.waiting : null;
  };

  const apps: AppThreads[] = await Promise.all(
    names.map(async (app) => {
      const threads: Record<string, ThreadEntry> = await Bun.file(join(state, app, "threads.json")).json();

      return {
        app,
        connected: existsSync(join(state, app, "hub.sock")),
        threads: Object.entries(threads).map(([id, entry]) => {
          const session = entry.session ?? null;

          return {
            id,
            name: entry.name ?? id,
            session,
            cwd: entry.cwd ?? null,
            running: session ? running.has(session) : false,
            working: working(session),
            account: accountOf(session),
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
        working: working(s.sessionId),
        account: accountOf(s.sessionId),
        link: null,
      })),
    });
  }

  const elsewhere = bindings.filter((b) => b.host && b.host !== "server");

  for (const [host, seated] of Map.groupBy(elsewhere, (b) => b.host!)) {
    apps.push({
      app: host,
      connected: true,
      threads: seated.map((b) => ({
        id: b.sessionId,
        name: b.name ?? "Claude session",
        session: b.sessionId,
        cwd: b.cwd ?? null,
        running: true,
        working: !b.waiting,
        account: labels.get(b.accountId) ?? null,
        link: null,
      })),
    });
  }

  if (!routing) return { apps, pool: null, tokenhub: config.tokenhub };

  const sessionNames = new Map([
    ...(status?.jobs ?? []).flatMap((job) => (job.sessionId ? [[job.sessionId, job.name] as const] : [])),
    ...apps.flatMap((app) => app.threads.flatMap((t) => (t.session && app.app !== "other" ? [[t.session, t.name] as const] : []))),
  ]);

  const label = (id: string) => labels.get(id) ?? id.slice(0, 8);

  const accounts: PoolAccount[] = routing.accounts.map((account) => {
    const rank = routing.rankedAccountIds.indexOf(account.id);

    return {
      id: account.id,
      label: account.label,
      tier: account.tier,
      needsReauth: account.needsReauth,
      eligible: account.eligible,
      selected: account.id === routing.selectedAccountId,
      rank: rank < 0 ? null : rank + 1,
      standing: standing(account),
      held: account.heldSessions,
      idle: account.waitingSessions,
      room: account.headroom && {
        left: account.headroom.remainingPercentagePoints,
        sessions: account.headroom.divisor,
        each: account.headroom.score,
        minimum: account.headroom.minimum,
      },
      session: toWindow(account.session),
      week: toWindow(account.week),
      sampledAt: account.session?.sampledAt ?? null,
      stale: account.usageStale,
      reasons: account.reasons,
    };
  });

  return {
    apps,
    pool: {
      at: routing.at,
      accounts,
      policy: routing.config,
      revision: routing.revision,
      notes: routing.notes,
      moves: (logged?.moves ?? []).map(({ at, session, from, to, cause }) => ({
        at,
        session,
        name: sessionNames.get(session) ?? null,
        from: label(from),
        to: label(to),
        cause,
      })),
      starts: (logged?.starts ?? []).map(({ at, account }) => ({ at, account: label(account) })),
      hosts: await hosts(bindings),
    },
    tokenhub: config.tokenhub,
  };
}

const RANGES = new Set(["today", "7d", "30d", "6m"]);

export async function agentUsage(config: Config, range: string): Promise<AgentUsage> {
  if (!config.tokenhub) throw new Error("No tokenhub is set in deck's config.");

  if (!RANGES.has(range)) throw new Error(`Unknown range ${range}`);
  const status = await getJson<PoolStatus>(`${config.tokenhub}/api/pool/status?range=${range}`);

  if (!status) throw new Error("tokenhub didn't answer.");

  return {
    at: status.generatedAt,
    surfaces: status.surfaces.map((s) => ({
      name: s.name,
      tokens: s.tokens,
      api: s.costUSD,
      plan: s.subscriptionUSD ?? s.costUSD,
      sessions: s.sessions,
    })),
    blocked: status.jobs
      .filter((j) => j.state === "blocked")
      .map((j) => ({ id: j.id, name: j.name, surface: j.surface, since: j.updatedAt ?? status.generatedAt })),
    github: status.github
      .flatMap((repo) =>
        repo.workflows.map((w) => {
          const activity = repo.activity.filter((run) => run.workflowPath === w.path);
          const runs = [...activity, ...repo.history.filter((run) => run.workflowPath === w.path)];

          return {
            repo: repo.repo.replace(/^[^/]+\//, ""),
            url: repo.url,
            name: w.name,
            kind: w.kind,
            telemetry: w.telemetry,
            run: w.run && { result: w.run.conclusion ?? w.run.status, url: w.run.url },
            missing: w.run ? null : w.sourceAvailable ? "No run found" : "Source unavailable",
            runs: new Set(runs.map((run) => run.url)).size,
            tokens: activity.length ? activity.reduce((sum, run) => sum + (run.tokens ?? 0), 0) : null,
            api: runs.length ? runs.reduce((sum, run) => sum + run.costUSD, 0) : null,
            models: [...new Set(runs.flatMap((run) => run.models))],
          };
        }),
      )
      .toSorted((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || (b.api ?? 0) - (a.api ?? 0) || a.repo.localeCompare(b.repo)),
    coverage: status.coverage,
  };
}
