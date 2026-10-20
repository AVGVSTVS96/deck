import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tokenhub as Settings } from "./config";
import type { Account, AccountsView, Connection, LimitWindow, Move, MoveCause, Policy, PolicyResult, Pool } from "./contract";
import { source } from "./sources";

type WireWindow = { usedPercentage: number; resetsAt: number | null; sampledAt: number | null; effectiveThreshold: number } | null;

type WireAccount = {
  id: string;
  label: string;
  tier: string;
  needsReauth: boolean;
  selectionPool: "open" | "capacity-fallback" | "blocked";
  reasons: string[];
  heldSessions: number;
  waitingSessions: number;
  session: WireWindow;
  week: WireWindow;
  since: number | null;
  signInUntil: number | null;
  heldResets: { kind: string; left: number; expiresAt: number | null }[];
  atLimit: { available: boolean; nextAt: number | null } | null;
};

type Wire = {
  revision: string;
  config: Policy;
  selectedAccountId: string | null;
  rankedAccountIds: string[];
  accounts: WireAccount[];
  bindings: { sessionId: string; accountId: string; waiting: boolean; host: string; name?: string | null; cwd?: string | null }[];
  notes: string[];
  error?: { code: string; message: string };
};

export type Seat = { session: string; account: string; host: string; waiting: boolean; name: string | null; cwd: string | null };

export type PoolState = { accounts: Account[]; pool: Pool; seats: Seat[] };

const FIVE_HOURS = 5 * 3_600_000;
const WEEK = 7 * 86_400_000;
const HISTORY_MS = 7 * 86_400_000;
const MOVES_MS = 86_400_000;
const SAME_MOVE_MS = 300_000;

function windowOf(wire: WireWindow, length: number, fallbackCutoff: number): LimitWindow {
  if (!wire) return { used: null, cutoff: fallbackCutoff, resetsAt: null, sampledAt: null, elapsed: null };
  const { usedPercentage, resetsAt, sampledAt, effectiveThreshold } = wire;
  const elapsed = resetsAt && sampledAt ? Math.round(Math.min(1, Math.max(0, 1 - (resetsAt - sampledAt) / length)) * 1000) / 1000 : null;

  return { used: usedPercentage, cutoff: effectiveThreshold, resetsAt, sampledAt, elapsed };
}

const PLANS: [RegExp, string][] = [
  [/max.?20x/, "Max 20x"],
  [/max.?5x/, "Max 5x"],
  [/max/, "Max"],
  [/pro/, "Pro"],
];

const planOf = (tier: string) => PLANS.find(([pattern]) => pattern.test(tier))?.[1] ?? tier;

function standingOf(account: WireAccount, next: string | null): Account["standing"] {
  if (account.needsReauth) return "signed-out";

  if (account.id === next) return "next";

  return account.selectionPool === "open" ? "open" : account.selectionPool === "capacity-fallback" ? "tight" : "limited";
}

function parse(wire: Wire): PoolState {
  const next = wire.selectedAccountId;
  const chosen = wire.accounts.find((a) => a.id === next);

  return {
    accounts: wire.accounts.map((a) => {
      const rank = wire.rankedAccountIds.indexOf(a.id);

      return {
        id: a.id,
        label: a.label,
        plan: planOf(a.tier),
        since: a.since,
        signInUntil: a.signInUntil,
        rank: rank < 0 ? null : rank + 1,
        standing: standingOf(a, next),
        reasons: a.reasons,
        fiveHour: windowOf(a.session, FIVE_HOURS, wire.config.sessionCutoff),
        week: windowOf(a.week, WEEK, wire.config.weeklyCutoff),
        working: a.heldSessions,
        idle: a.waitingSessions,
        heldResets: a.heldResets,
        atLimit: a.atLimit,
      };
    }),
    pool: {
      next,
      decision: chosen ? `New sessions go to ${chosen.label}. ${chosen.reasons.join(" ")}` : "No account can take a new session.",
      order: wire.rankedAccountIds,
      policy: wire.config,
      revision: wire.revision,
      notes: wire.notes,
    },
    seats: wire.bindings.map((b) => ({
      session: b.sessionId,
      account: b.accountId,
      host: b.host,
      waiting: b.waiting,
      name: b.name ?? null,
      cwd: b.cwd ?? null,
    })),
  };
}

type Logged = {
  at: string | number;
  sessionId?: string;
  accountId?: string;
  account?: string;
  event?: string | null;
  from?: string;
  level?: string;
  fiveHour?: number | null;
  week?: number | null;
};

async function readLog(path: string): Promise<Logged[]> {
  const text = await Bun.file(path)
    .text()
    .catch(() => "");

  return text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

const timeOf = (at: string | number) => new Date(at).getTime();

/** Starts and moves of the last day: a session's first hook binding is a start, a later one on another account is a move. */
function movesOf(attribution: Logged[], recovery: Logged[], since: number): Omit<Move, "label">[] {
  const bound = attribution.filter((r) => (r.event === "start" || r.event === "failure") && r.sessionId && r.accountId);
  const bySession = Map.groupBy(bound, (r) => r.sessionId!);
  const moves: Omit<Move, "label">[] = [];

  for (const [session, rows] of bySession) {
    rows.forEach((row, i) => {
      const before = rows[i - 1];
      const at = timeOf(row.at);

      if (at < since || before?.accountId === row.accountId) return;
      moves.push({
        at,
        session,
        from: before?.accountId ?? null,
        to: row.accountId!,
        cause: !before ? "start" : before.event === "failure" ? "limit" : "restart",
      });
    });
  }

  for (const row of recovery) {
    const at = timeOf(row.at);

    if (!row.sessionId || !row.accountId || at < since) continue;
    const cause: MoveCause = row.event === "move" ? (row.level === "soon" ? "early" : "over") : "limit";
    const same = moves.find((m) => m.session === row.sessionId && m.to === row.accountId && Math.abs(m.at - at) < SAME_MOVE_MS);

    if (same) same.cause = cause;
    else if (row.from && row.from !== row.accountId) moves.push({ at, session: row.sessionId, from: row.from, to: row.accountId, cause });
  }

  return moves.toSorted((a, b) => b.at - a.at);
}

export type History = Omit<AccountsView, "moves" | "hosts"> & { moves: Omit<Move, "label">[] };

/** The Mac and other remote hosts, by when they last reported their seats. Read per request: a heartbeat isn't news. */
async function hosts(state: string) {
  const remote = join(state, "remote");
  const names = (await readdir(remote).catch(() => [])).flatMap((name) => (name.endsWith(".json") ? [name.slice(0, -5)] : []));

  const seen = await Promise.all(
    names.map((name) =>
      stat(join(remote, `${name}.json`)).then(
        (s) => s.mtimeMs,
        () => null,
      ),
    ),
  );

  return [{ host: "server", seenAt: null }, ...names.map((host, i) => ({ host, seenAt: seen[i] }))];
}

async function history(state: string): Promise<History> {
  const now = Date.now();

  const [readings, attribution, recovery] = await Promise.all(
    ["usage-history.ndjson", "attribution.ndjson", "recovery.ndjson"].map((name) => readLog(join(state, name))),
  );

  const lines = new Map<string, AccountsView["history"][number]>();

  for (const r of readings) {
    const at = timeOf(r.at);

    if (!r.account || at < now - HISTORY_MS) continue;

    for (const kind of ["fiveHour", "week"] as const) {
      const used = r[kind];

      if (used == null) continue;
      const key = `${r.account}\n${kind}`;
      const line = lines.get(key) ?? { account: r.account, kind, points: [] };

      line.points.push([at, used]);
      lines.set(key, line);
    }
  }

  return {
    history: [...lines.values()],
    moves: movesOf(attribution, recovery, now - MOVES_MS),
  };
}

type RoutingInput = { config: Policy; expectedRevision?: string };

async function routing({ dir, state, config }: Settings, mode: "snapshot" | "preview" | "save", input?: RoutingInput): Promise<Wire> {
  const run = Bun.spawn([process.execPath, join(dir, "routing.ts"), mode], {
    cwd: dir,
    env: { ...process.env, TOKENHUB_STATE: state, TOKENHUB_CONFIG: config },
    stdin: input ? new Blob([JSON.stringify(input)]) : "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 20_000,
  });

  const [text] = await Promise.all([new Response(run.stdout).text(), run.exited]);

  if (!text.trim()) throw new Error(`tokenhub's routing.ts ${mode} gave no answer (exit ${run.exitCode ?? run.signalCode}).`);

  return JSON.parse(text);
}

/** The only tokenhub client: its routing CLI for the pool, its logs for history and moves, tokenhub-onboard for sign-in. */
export function tokenhub(settings: Settings) {
  const { state, config, onboard } = settings;

  const pool = source({
    name: "tokenhub pool",
    load: async () => {
      const wire = await routing(settings, "snapshot");

      if (wire.error) throw new Error(wire.error.message);

      return parse(wire);
    },
    watch: [
      ...["usage", "resets", "plans", "holds", "seats", "remote"].map((name) => ({ path: join(state, name) })),
      { path: config, only: /^(config|accounts)\.json$/ },
    ],
    debounceMs: 1_000,
  });

  const logs = source({
    name: "tokenhub logs",
    load: () => history(state),
    watch: [{ path: state, only: /^(usage-history|attribution|recovery)\.ndjson$/ }],
    debounceMs: 30_000,
  });

  async function policy(proposed: Policy, revision: string, save: boolean): Promise<PolicyResult> {
    const input: RoutingInput = { config: proposed };

    if (save) input.expectedRevision = revision;
    const wire = await routing(settings, save ? "save" : "preview", input);

    if (wire.error?.code === "revision_conflict") {
      await pool.refresh();

      if (!pool.value) throw new Error(pool.error ?? "tokenhub's pool couldn't be read.");

      return { pool: pool.value.pool, saved: false, conflict: true };
    }

    if (wire.error) throw new Error(wire.error.message);

    if (save) await pool.refresh();

    return { pool: parse(wire).pool, saved: save, conflict: false };
  }

  async function connect(path: string, body?: { email: string } | { code: string }): Promise<Connection> {
    const origin = new URL(onboard).origin;

    const response = await fetch(`${origin}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json", origin } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);

    if (!response) throw new Error("tokenhub's sign-in service didn't answer.");
    const result = await response.json().catch(() => null);

    if (!response.ok) throw new Error(result?.error ?? `tokenhub's sign-in service answered ${response.status}.`);

    return result;
  }

  const sign = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unknown sign-in.");

    return id;
  };

  return {
    pool,
    logs,
    hosts: () => hosts(state),
    policy,
    connect: {
      start: (email: string) => connect("/api/start", { email }),
      status: (id: string) => connect(`/api/status/${sign(id)}`),
      code: (id: string, code: string) => connect(`/api/code/${sign(id)}`, { code }),
    },
  };
}

export type Tokenhub = ReturnType<typeof tokenhub>;
