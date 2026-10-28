import { gzipSync } from "bun";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { BunRequest } from "bun";
import { actionRuns } from "./actions";
import { compressed, webAssets } from "./assets";
import { loadConfig } from "./config";
import type { AccountsView } from "./contract";
import { Executor } from "./executor";
import { Git, GitError } from "./git";
import { labelOf, names, whoOf } from "./identity";
import { liveMap, processes, type Live } from "./live";
import { plugins, setPlugin } from "./plugins";
import { source, watch } from "./sources";
import { Stream } from "./stream";
import { tokenhub } from "./tokenhub";
import { tracker } from "./tracker";
import type { Draft } from "./types";
import { parseQuery, usageView, withLive, type Labels } from "./usage";

const config = await loadConfig();
const production = process.env.NODE_ENV === "production";
const repos = new Git(config);
const stream = new Stream();
const executor = config.executor ? new Executor(config.executor) : null;
const hub = config.tokenhub ? tokenhub(config.tokenhub) : null;
const usage = config.tracker ? tracker(config.tracker, config.timezone, () => stream.size > 0) : null;
const threads = names(config.hex);
const running = processes(config.claude, config.hex);
const web = await webAssets(config.web, production);
const executorOverview = executor ? source({ name: "executor", load: () => executor.overview() }) : null;

let live: Live = { sessions: new Map(), map: {} };

function publish() {
  live = liveMap({ processes: running.value, pool: hub?.pool.value, names: threads.value, tracked: usage?.latest() });
  stream.publish(live.map);
}

let views = new Map<string, ReturnType<typeof usageView>>();
let labelsKey = "";

function usageChanged() {
  views = new Map();
  stream.stale("usage");
}

running.on(publish);

threads.on(() => (publish(), usageChanged()));

usage?.on(() => (publish(), usageChanged()));

hub?.pool.on(() => {
  publish();
  const next = JSON.stringify(labels().accounts);

  if (next === labelsKey) return;
  labelsKey = next;
  usageChanged();
});

hub?.logs.on(() => stream.stale("accounts"));

if (config.tokenhub) watch([{ path: config.tokenhub.state, only: /^github-imported\.json$/ }], () => stream.stale("accounts"));

function labels(): Labels {
  return {
    accounts: Object.fromEntries(hub?.pool.value?.accounts.map((a) => [a.id, a.label]) ?? []),
    devices: Object.fromEntries(usage?.latest()?.devices.map((d) => [d.id, d.label]) ?? []),
  };
}

const watching = new Map<string, () => void>();

/** Watches every repo, workspace and settings file once, and lets go of workspaces that are gone, so one re-created at the same path gets a fresh watcher. */
async function watchFiles() {
  const wanted: [path: string, tag: string, recursive: boolean, only: RegExp][] = [
    [config.claude, "plugins", false, /^settings\.json$/],
    [join(config.claude, "plugins"), "plugins", false, /^installed_plugins\.json$/],
  ];

  if (config.drafts) wanted.push([config.drafts.dir, "drafts", false, /^[^.]/]);

  for (const repo of config.repos) {
    wanted.push([
      join(repo.path, ".git"),
      `repo:${repo.id}`,
      true,
      /^(index|HEAD|refs\/(?!t3\/)|logs|COMMIT_EDITMSG|ORIG_HEAD)(?!.*\.lock$)/,
    ]);

    for (const ws of await repos.workspaces(repo)) if (ws.name) wanted.push([ws.path, `ws:${ws.id}`, true, /^(?!\.git(\/|$))/]);
  }

  const paths = new Set(wanted.map(([path]) => path));

  for (const [path, stop] of watching) {
    if (paths.has(path)) continue;
    stop();
    watching.delete(path);
  }

  for (const [path, tag, recursive, only] of wanted) {
    if (!watching.has(path))
      watching.set(
        path,
        watch([{ path, recursive, only }], () => stream.stale(tag), 80),
      );
  }
}

const ownHosts = new Set([config.host, hostname(), "localhost", "127.0.0.1"].map((name) => `${name}:${config.port}`));

function trusted(req: Request) {
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");

  return ownHosts.has(host) && (origin ? origin === `http://${host}` : req.method === "GET" || req.method === "HEAD");
}

const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 });
const encoder = new TextEncoder();

function reply<T>(req: Request, data: T, status = 200) {
  const body = encoder.encode(JSON.stringify(data ?? { ok: true }));
  const headers = { "content-type": "application/json", "cache-control": "no-store" };

  if (status !== 200) return new Response(body, { status, headers });

  return compressed(req, body, body.byteLength > 1024 ? gzipSync(body) : null, headers);
}

const json =
  <T>(handler: (req: BunRequest) => Promise<T> | T) =>
  async (req: BunRequest) => {
    if (!trusted(req)) return forbidden();

    try {
      return reply(req, await handler(req));
    } catch (error) {
      return reply(req, { error: error instanceof Error ? error.message : String(error) }, error instanceof GitError ? 409 : 500);
    }
  };

const param = (req: BunRequest, name: string) => req.params[name];
const query = (req: BunRequest, name: string) => new URL(req.url).searchParams.get(name) ?? "";

function need<T>(value: T | null, what: string): T {
  if (!value) throw new Error(`${what} isn't set up in deck's config.`);

  return value;
}

async function drafts(): Promise<Draft[]> {
  if (!config.drafts) return [];
  const { dir, targets } = config.drafts;
  const names = (await readdir(dir).catch(() => [])).filter((name) => !name.startsWith("."));

  return names.toSorted().map((name) => {
    const [repo, ...path] = (targets[name] ?? "").split(":");

    return { name, target: repo && path.length ? { repo, path: path.join(":") } : null };
  });
}

async function usageRoute(req: BunRequest) {
  const q = parseQuery(new URL(req.url).searchParams);
  const data = await need(usage, "token-tracker").get(q.range);

  if (!data.value) throw new Error(data.error ?? "token-tracker hasn't answered yet.");

  if (!threads.value) await threads.ready();

  const key = JSON.stringify(q);
  let view = views.get(key);

  if (!view) {
    if (views.size > 64) views.clear();
    view = usageView({ tracked: data.value, names: threads.value!, labels: labels() }, q);
    views.set(key, view);
  }

  return withLive(view, [...live.sessions.values()], data);
}

function sessionLabel(id: string) {
  const record = usage?.latest()?.sessions.find((s) => s.sessionId === id);
  const named = live.sessions.get(id);

  if (named) return named.label;

  if (!threads.value) return null;

  const who = whoOf(threads.value, {
    sessionId: id,
    title: record?.title ?? null,
    project: record?.project ?? "",
    repository: record?.repository,
  });

  return who.kind === "project" && !record ? null : labelOf(who).label;
}

async function accountsRoute(): Promise<AccountsView> {
  const { logs, pool, hosts } = need(hub, "tokenhub");
  const settings = need(config.tokenhub, "tokenhub");
  const seats = pool.value?.seats ?? [];

  if (!logs.value) throw new Error(logs.error ?? "tokenhub's logs haven't loaded yet.");

  return {
    history: logs.value.history,
    moves: logs.value.moves.map((move) => ({ ...move, label: sessionLabel(move.session) })),
    hosts: (await hosts()).map((h) => ({ ...h, seats: seats.filter((s) => s.host === h.host).length })),
    actions: await actionRuns(settings.state, config.actions),
  };
}

async function executorRoute() {
  const overview = need(executorOverview, "Executor");

  if (overview.value === undefined) await overview.ready();
  else if (Date.now() - overview.at > 30_000) void overview.refresh();

  if (overview.value === undefined) throw new Error(overview.error ?? "Executor didn't answer.");

  return overview.value;
}

async function executorChanged<T>(work: Promise<T>) {
  const result = await work;

  void executorOverview?.refresh().then(() => stream.stale("executor"));

  return result;
}

await Promise.all([running.refresh(), threads.refresh(), hub?.pool.refresh(), hub?.logs.refresh(), watchFiles()]);

publish();

void usage?.get("7d");

void executorOverview?.refresh();

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0,
  routes: {
    "/api/events": (req) => (trusted(req) ? stream.respond() : forbidden()),
    "/api/usage": json(usageRoute),
    "/api/accounts": json(accountsRoute),
    "/api/accounts/policy": {
      POST: json(async (req) => {
        const body = await req.json();

        return need(hub, "tokenhub").policy(body.policy, String(body.revision ?? ""), body.save === true);
      }),
    },
    "/api/accounts/connect": { POST: json(async (req) => need(hub, "tokenhub").connect.start(String((await req.json()).email ?? ""))) },
    "/api/accounts/connect/:id": {
      GET: json((req) => need(hub, "tokenhub").connect.status(param(req, "id"))),
      POST: json(async (req) => need(hub, "tokenhub").connect.code(param(req, "id"), String((await req.json()).code ?? ""))),
    },
    "/api/repos": json(() => Promise.all(config.repos.map((repo) => repos.summary(repo)))),
    "/api/repos/:repo/workspaces": {
      POST: json(async (req) => {
        const { name } = await req.json();
        const id = await repos.create(repos.repo(param(req, "repo")), name);
        await watchFiles();

        return { id };
      }),
    },
    "/api/repos/:repo/push": { POST: json((req) => repos.push(param(req, "repo"))) },
    "/api/ws/:ws": {
      DELETE: json(async (req) => {
        const result = await repos.discard(param(req, "ws"));
        await watchFiles();

        return result;
      }),
    },
    "/api/ws/:ws/files": json((req) => repos.files(param(req, "ws"))),
    "/api/ws/:ws/changes": json((req) => repos.changes(param(req, "ws"))),
    "/api/ws/:ws/file": {
      GET: json((req) => repos.read(param(req, "ws"), query(req, "path"))),
      PUT: json(async (req) => repos.write(param(req, "ws"), query(req, "path"), await req.text())),
    },
    "/api/ws/:ws/commit": { POST: json(async (req) => repos.commit(param(req, "ws"), (await req.json()).message)) },
    "/api/ws/:ws/ship": { POST: json((req) => repos.ship(param(req, "ws"))) },
    "/api/drafts": json(drafts),
    "/api/drafts/:name": json(async (req) => {
      const name = param(req, "name");

      if (!config.drafts || !(await drafts()).some((d) => d.name === name)) throw new Error(`No draft ${name}`);

      return { contents: await Bun.file(join(config.drafts.dir, name)).text() };
    }),
    "/api/plugins": json(() => plugins(config)),
    "/api/plugins/:id": { POST: json(async (req) => setPlugin(config, param(req, "id"), (await req.json()).enabled === true)) },
    "/api/executor": json(executorRoute),
    "/api/executor/:slug": json((req) => need(executor, "Executor").source(param(req, "slug"))),
    "/api/executor/:slug/file": {
      PUT: json(async (req) => need(executor, "Executor").save(param(req, "slug"), query(req, "path"), await req.text())),
    },
    "/api/executor/:slug/deploy": { POST: json((req) => executorChanged(need(executor, "Executor").deploy(param(req, "slug")))) },
    "/api/executor/:slug/connect": {
      POST: json(async (req) => executorChanged(need(executor, "Executor").connect(param(req, "slug"), (await req.json()).requirement))),
    },
    "/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
  },
  fetch: (req) => (req.method === "GET" || req.method === "HEAD" ? web(req) : new Response("not found", { status: 404 })),
});

console.log(`deck on ${server.url}`);
