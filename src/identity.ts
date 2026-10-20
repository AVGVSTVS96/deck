import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Who } from "./contract";
import { source } from "./sources";

type Thread = { app: string; thread: string; name: string };

export type Names = {
  /** Thread by its current Claude session (threads.json). */
  current: Record<string, Thread>;
  /** Thread by the first 8 characters of a past session id, from hex.db messages whose meta names the session's log. */
  logged: Record<string, Thread>;
  /** Threads by name, across apps. */
  named: Record<string, Thread[]>;
  apps: string[];
};

export type Session = { sessionId: string; title: string | null; project: string; repository?: string | null };

const JOB = /^(.+)\/([\w.@-]+)$/;

export function threadLink(app: string, thread: string) {
  if (app !== "telegram") return null;
  const [chat, topic] = thread.split(":");
  const internal = chat.replace(/^-100/, "");

  return topic ? `https://t.me/c/${internal}/${topic}` : `https://t.me/c/${internal}`;
}

/**
 * Who a session is, in order:
 * its thread's current session; a past session of a thread, by hex.db's log; a title that names exactly one thread;
 * a bin/job title `<owner>/<unit>`; any other title; else its project. A name alone never joins two threads.
 */
export function whoOf(names: Names, session: Session): Who {
  const thread = names.current[session.sessionId] ?? names.logged[session.sessionId.slice(0, 8)];
  const title = session.title?.trim() || null;
  const titled = title ? names.named[title] : undefined;
  const found = thread ?? (titled?.length === 1 ? titled[0] : undefined);

  if (found) return { kind: "thread", ...found, href: threadLink(found.app, found.thread) };
  const job = title?.match(JOB);

  if (job) return { kind: "job", owner: job[1], unit: job[2] };

  return title ? { kind: "session", title, project: projectOf(session), href: null } : { kind: "project", project: projectOf(session) };
}

export const projectOf = (session: Pick<Session, "project" | "repository">) => session.repository ?? session.project;

/** The agent row a session ranks under. */
export function rowOf(who: Who, sessionKey: string) {
  switch (who.kind) {
    case "thread":
      return `t:${who.app}:${who.thread}`;
    case "job":
      return `j:${who.owner ?? ""}/${who.unit}`;
    case "session":
      return `s:${sessionKey}`;
    case "project":
      return `p:${who.project}`;
  }
}

export function labelOf(who: Who) {
  switch (who.kind) {
    case "thread":
      return { label: who.name, detail: who.app };
    case "job":
      return { label: who.unit, detail: who.owner ? `job of ${who.owner}` : "job" };
    case "session":
      return { label: who.title, detail: basename(who.project) };
    case "project":
      return { label: basename(who.project) || who.project, detail: "untitled sessions" };
  }
}

export const appOf = (who: Who) => (who.kind === "thread" ? who.app : who.kind === "job" ? "job" : "other");

async function load(hex: string): Promise<Names> {
  const state = join(hex, "state");
  const apps = (await readdir(state).catch(() => [])).filter((app) => existsSync(join(state, app, "threads.json")));
  const threads = new Map<string, Thread>();
  const current: Record<string, Thread> = {};
  const logged: Record<string, Thread> = {};
  const key = (app: string, thread: string) => `${app}\n${thread}`;

  const dbPath = join(state, "hex.db");
  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;

  try {
    for (const row of db?.query<Thread, []>("select app, thread, name from threads").all() ?? []) {
      threads.set(key(row.app, row.thread), row);
    }

    for (const app of apps) {
      const file: Record<string, { name?: string; session?: string }> = await Bun.file(join(state, app, "threads.json")).json();

      for (const [thread, entry] of Object.entries(file)) {
        const known = { app, thread, name: entry.name ?? threads.get(key(app, thread))?.name ?? thread };

        threads.set(key(app, thread), known);

        if (entry.session) current[entry.session] = known;
      }
    }

    const logs = db?.query<{ app: string; thread: string; log: string }, []>(
      `select distinct json_extract(meta, '$.app') as app, "to" as thread, json_extract(meta, '$.log') as log
       from messages where json_extract(meta, '$.log') is not null and json_extract(meta, '$.app') is not null`,
    );

    for (const row of logs?.all() ?? []) {
      const id = row.log.match(/-([0-9a-f]{8})\.md$/)?.[1];
      const thread = threads.get(key(row.app, row.thread));

      if (id && thread) logged[id] = thread;
    }
  } finally {
    db?.close();
  }

  const named: Record<string, Thread[]> = {};

  for (const thread of threads.values()) (named[thread.name] ??= []).push(thread);

  return { current, logged, named, apps };
}

/** hex's thread names, reloaded when a threads.json changes and every 5 minutes for hex.db. */
export const names = (hex: string) =>
  source({
    name: "hex names",
    load: () => load(hex),
    watch: [{ path: join(hex, "state"), recursive: true, only: /^[^/]+\/threads\.json$/ }],
    everyMs: 5 * 60_000,
  });
