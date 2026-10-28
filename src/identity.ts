import { basename, join } from "node:path";
import type { Who } from "./contract";
import { source } from "./sources";

type Thread = { app: string; thread: string; name: string };

export type Names = {
  /** Thread by its current Claude session, from `hex threads`. */
  current: Record<string, Thread>;
  /** Thread by the first 8 characters of a past session id, from `hex log` messages whose meta names the session's log. */
  logged: Record<string, Thread>;
  /** Threads by name, across apps. */
  named: Record<string, Thread[]>;
};

export type Session = { sessionId: string; title: string | null; project: string; repository?: string | null };

const JOB = /^(.+)\/([\w.@-]+)$/;

/** tokenhub's GitHub import names each session `github:<run>:<attempt>:…` and titles it `<workflow> #<run>`. */
const RUN = /^github:(\d+):/;

export function threadLink(app: string, thread: string) {
  if (app === "t3") return `t3-thread://v1/${thread}`;

  if (app !== "telegram") return null;
  const [chat, topic] = thread.split(":");
  const internal = chat.replace(/^-100/, "");

  return topic ? `https://t.me/c/${internal}/${topic}` : `https://t.me/c/${internal}`;
}

/**
 * Who a session is, in order:
 * a GitHub Actions run, by tokenhub's session id; its thread's current session; a past session of a thread, by hex's log; a title that names exactly one thread;
 * a bin/job title `<owner>/<unit>`; any other title; else its project. A name alone never joins two threads.
 */
export function whoOf(names: Names, session: Session): Who {
  const run = session.sessionId.match(RUN)?.[1];

  if (run) {
    const repo = projectOf(session).replace(/^https:\/\/github\.com\//, "");
    const workflow = session.title?.replace(/ #\d+$/, "").trim() || "workflow";

    return { kind: "action", repo, workflow, run, href: `https://github.com/${repo}/actions/runs/${run}` };
  }

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
    case "action":
      return `g:${who.repo}:${who.workflow}`;
  }
}

/** The agent a session ranks under: an Actions run's agent is its workflow, which links to the repo's runs. */
export const agentOf = (who: Who): Who =>
  who.kind === "action" ? { ...who, run: null, href: `https://github.com/${who.repo}/actions` } : who;

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
    case "action":
      return { label: `${basename(who.repo)} · ${who.workflow}`, detail: "GitHub Actions" };
  }
}

export const appOf = (who: Who) =>
  who.kind === "thread" ? who.app : who.kind === "job" ? "job" : who.kind === "action" ? "actions" : "other";

type ThreadRow = Thread & { session?: string };

type LogRow = { to: string; meta?: { app?: string; log?: string } };

/** What `hex <command> --json` prints, through the hex command, so the deck never reads hex.db's tables. */
async function hexJson<T>(hex: string, command: string) {
  const run = Bun.spawn([join(hex, ".hex", "bin", "hex"), command, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);

  if (code) throw new Error(`hex ${command}: ${error.trim() || `exited ${code}`}`);

  // SAFETY: hex's --json output is a list of the rows it documents.
  return JSON.parse(out) as T[];
}

/**
 * The thread key of each past session by the first 8 characters of its id, from messages whose meta names the session's log.
 * Only hex's old log import wrote those, so hex's whole log is read once, not at every change.
 */
let pastSessions: Promise<Map<string, string>> | undefined;

async function readPast(hex: string) {
  const past = new Map<string, string>();

  for (const { to, meta } of await hexJson<LogRow>(hex, "log")) {
    const id = meta?.log?.match(/-([0-9a-f]{8})\.md$/)?.[1];

    if (id && meta?.app) past.set(id, key(meta.app, to));
  }

  return past;
}

const key = (app: string, thread: string) => `${app}\n${thread}`;

async function load(hex: string): Promise<Names> {
  pastSessions ??= readPast(hex).catch((error) => {
    pastSessions = undefined;
    throw error;
  });
  const [rows, past] = await Promise.all([hexJson<ThreadRow>(hex, "threads"), pastSessions]);
  const threads = new Map<string, Thread>();
  const current: Record<string, Thread> = {};
  const logged: Record<string, Thread> = {};

  for (const { app, thread, name, session } of rows) {
    const row = { app, thread, name };

    threads.set(key(app, thread), row);

    if (session) current[session] = row;
  }

  for (const [id, at] of past) {
    const thread = threads.get(at);

    if (thread) logged[id] = thread;
  }

  const named: Record<string, Thread[]> = {};

  for (const thread of threads.values()) (named[thread.name] ??= []).push(thread);

  return { current, logged, named };
}

/** hex's thread names, read again each time `hex watch` says hex.db changed. */
export const names = (hex: string) =>
  source({
    name: "hex names",
    load: () => load(hex),
    follow: [join(hex, ".hex", "bin", "hex"), "watch"],
  });
