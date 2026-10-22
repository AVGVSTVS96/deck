import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LiveSession, LiveState, LiveValue, Who } from "./contract";
import { labelOf, projectOf, rowOf, whoOf, type Names } from "./identity";
import { source } from "./sources";
import type { PoolState } from "./tokenhub";
import type { Tracked } from "./tracker";

type Running = { sessionId: string; cwd: string; name: string | null; busy: boolean; startedAt: number };

type Blocked = { sessionId: string; name: string | null; cwd: string; since: number };

export type Processes = { running: Running[]; blocked: Blocked[]; apps: Record<string, boolean> };

const json = (path: string) =>
  Bun.file(path)
    .json()
    .catch(() => null);

async function read(claude: string, hex: string): Promise<Processes> {
  const sessionsDir = join(claude, "sessions");
  const jobsDir = join(claude, "jobs");
  const state = join(hex, "state");

  const files = (await readdir(sessionsDir).catch(() => [])).filter((name) => /^\d+\.json$/.test(name));
  const sessions = await Promise.all(files.map((name) => json(join(sessionsDir, name))));
  const running = new Map<string, Running>();

  for (const s of sessions) {
    if (!s?.sessionId || !existsSync(`/proc/${s.pid}`)) continue;
    running.set(s.sessionId, {
      sessionId: s.sessionId,
      cwd: s.cwd ?? "",
      name: s.name ?? null,
      busy: s.status === "busy",
      startedAt: s.startedAt ?? 0,
    });
  }

  const jobs = await readdir(jobsDir).catch(() => []);

  const blocked = (
    await Promise.all(
      jobs.map(async (id) => {
        const job = await json(join(jobsDir, id, "state.json"));

        if (job?.state !== "blocked" || !job.sessionId) return null;

        return { sessionId: job.sessionId, name: job.name ?? null, cwd: job.cwd ?? "", since: Date.parse(job.updatedAt) || 0 };
      }),
    )
  ).filter((job) => job !== null);

  const apps = (await readdir(state).catch(() => [])).filter((app) => existsSync(join(state, app, "sessions")));

  return {
    running: [...running.values()].toSorted((a, b) => a.sessionId.localeCompare(b.sessionId)),
    blocked: blocked.toSorted((a, b) => a.sessionId.localeCompare(b.sessionId)),
    apps: Object.fromEntries(apps.map((app) => [app, existsSync(join(state, app, "hub.sock"))])),
  };
}

/** Running Claude sessions, blocked jobs and which hex apps are connected, re-read when any of them changes. */
export const processes = (claude: string, hex: string) =>
  source({
    name: "processes",
    load: () => read(claude, hex),
    watch: [
      { path: join(claude, "sessions"), only: /^\d+\.json$/ },
      { path: join(claude, "jobs"), recursive: true, only: /^[^/]+\/state\.json$/ },
      { path: join(hex, "state"), recursive: true, only: /^[^/]+\/(hub\.sock|sessions)$/ },
    ],
  });

type Inputs = { processes: Processes | undefined; pool: PoolState | undefined; names: Names | undefined; tracked: Tracked | undefined };

/**
 * What is true right now, as a flat map the stream diffs per key: `s:<session>`, `a:<account>`, `pool`, `app:<name>`.
 * Only fields that change when something happens enter it, never clocks or sample ages.
 */
export type Live = { sessions: Map<string, LiveSession>; map: Record<string, LiveValue> };

/** When deck first saw each session, for those with no start time of their own, such as the Mac's seats. */
const firstSeen = new Map<string, number>();

export function liveMap({ processes: found, pool, names, tracked }: Inputs): Live {
  const sessions = new Map<string, LiveSession>();
  const seats = new Map(pool?.seats.map((seat) => [seat.session, seat]));
  const known = new Map(tracked?.sessions.map((s) => [s.sessionId, s]));
  const projects = new Map(tracked?.sessions.map((s) => [s.cwd, projectOf(s)]));
  const blocked = new Map(found?.blocked.map((job) => [job.sessionId, job]));

  /** The row is the one Usage ranks this session under; the label may use the process's own name, such as a bin/job `<owner>/<unit>`. */
  const session = (id: string, name: string | null, cwd: string, state: LiveState, since: number, host: string): LiveSession => {
    const record = known.get(id);
    const seen = firstSeen.get(id) ?? Date.now();

    firstSeen.set(id, seen);
    const project = record ? projectOf(record) : (projects.get(cwd) ?? cwd);

    const who = (title: string | null): Who => (names ? whoOf(names, { sessionId: id, title, project }) : { kind: "project", project });

    const ranked = who(record?.title ?? null);
    const shown = name && !record?.title ? who(name) : ranked;

    return {
      id,
      label: labelOf(shown).label,
      row: rowOf(ranked, record?.key ?? id),
      app: ranked.kind === "thread" ? ranked.app : null,
      state,
      account: seats.get(id)?.account ?? null,
      host,
      cwd: cwd || record?.cwd || "",
      since: since || record?.firstAt || seen,
    };
  };

  for (const s of found?.running ?? []) {
    const state: LiveState = blocked.has(s.sessionId) ? "blocked" : s.busy ? "working" : "idle";

    sessions.set(s.sessionId, session(s.sessionId, s.name, s.cwd, state, s.startedAt, "server"));
  }

  for (const job of found?.blocked ?? []) {
    if (!sessions.has(job.sessionId))
      sessions.set(job.sessionId, session(job.sessionId, job.name, job.cwd, "blocked", job.since, "server"));
  }

  for (const seat of pool?.seats ?? []) {
    if (seat.host === "server" || !/^[0-9a-f-]{36}$/.test(seat.session)) continue;
    sessions.set(seat.session, session(seat.session, seat.name, seat.cwd ?? "", seat.waiting ? "idle" : "working", 0, seat.host));
  }

  for (const id of firstSeen.keys()) if (!sessions.has(id)) firstSeen.delete(id);

  const map: Live["map"] = Object.fromEntries([...sessions].map(([id, s]) => [`s:${id}`, s]));

  for (const account of pool?.accounts ?? []) map[`a:${account.id}`] = account;

  if (pool) map.pool = pool.pool;

  for (const [app, connected] of Object.entries(found?.apps ?? {})) map[`app:${app}`] = { connected };

  return { sessions, map };
}
