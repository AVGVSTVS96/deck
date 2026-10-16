import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BunRequest } from "bun";
import app from "../web/index.html";
import { agents } from "./agents";
import { loadConfig } from "./config";
import { Events } from "./events";
import { Executor } from "./executor";
import { Git, GitError } from "./git";
import { plugins, setPlugin } from "./plugins";
import type { Draft } from "./types";

const config = await loadConfig();
const repos = new Git(config);
const events = new Events();
const executor = config.executor ? new Executor(config.executor) : null;

async function watchAll() {
  const workspaces = await Promise.all(config.repos.map((repo) => repos.workspaces(repo)));

  for (const repo of config.repos) {
    events.watch(
      join(repo.path, ".git"),
      { type: "repo", repo: repo.id },
      { recursive: true, only: /^(index|HEAD|refs|logs|COMMIT_EDITMSG|ORIG_HEAD)/ },
    );
  }

  for (const ws of workspaces.flat()) {
    if (ws.name) events.watch(ws.path, { type: "ws", id: ws.id }, { recursive: true, only: /^(?!\.git(\/|$))/ });
  }

  const state = join(config.hex, "state");

  for (const name of await readdir(state).catch(() => [])) {
    if (existsSync(join(state, name, "threads.json")))
      events.watch(join(state, name), { type: "agents" }, { only: /^(threads\.json|hub\.sock)$/ });
  }

  events.watch(join(config.claude, "sessions"), { type: "agents" }, { only: /^\d+\.json$/ });
  events.watch(config.claude, { type: "plugins" }, { only: /^settings\.json$/ });
  events.watch(join(config.claude, "plugins"), { type: "plugins" }, { only: /^installed_plugins\.json$/ });
}

const json =
  <T>(handler: (req: BunRequest) => Promise<T> | T) =>
  async (req: BunRequest) => {
    try {
      return Response.json((await handler(req)) ?? { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return Response.json({ error: message }, { status: error instanceof GitError ? 409 : 500 });
    }
  };

const param = (req: BunRequest, name: string) => req.params[name];
const query = (req: BunRequest, name: string) => new URL(req.url).searchParams.get(name) ?? "";

const needExecutor = () => {
  if (!executor) throw new Error("Executor isn't set up in deck's config.");

  return executor;
};

async function drafts(): Promise<Draft[]> {
  if (!config.drafts) return [];
  const { dir, targets } = config.drafts;
  const names = (await readdir(dir).catch(() => [])).filter((name) => !name.startsWith("."));

  return names.toSorted().map((name) => {
    const [repo, ...path] = (targets[name] ?? "").split(":");

    return { name, target: repo && path.length ? { repo, path: path.join(":") } : null };
  });
}

await watchAll();

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": app,
    "/api/events": () => events.stream(),
    "/api/repos": json(() => Promise.all(config.repos.map((repo) => repos.summary(repo)))),
    "/api/repos/:repo/workspaces": {
      POST: json(async (req) => {
        const { name } = await req.json();
        const id = await repos.create(repos.repo(param(req, "repo")), name);
        await watchAll();

        return { id };
      }),
    },
    "/api/repos/:repo/push": { POST: json((req) => repos.push(param(req, "repo"))) },
    "/api/ws/:ws": {
      DELETE: json(async (req) => {
        const { ws } = await repos.workspace(param(req, "ws"));
        events.unwatch(ws.path);

        return repos.discard(ws.id);
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
    "/api/agents": json(() => agents(config)),
    "/api/plugins": json(() => plugins(config)),
    "/api/plugins/:id": { POST: json(async (req) => setPlugin(config, param(req, "id"), (await req.json()).enabled === true)) },
    "/api/executor": json(() => needExecutor().overview()),
    "/api/executor/:slug": json((req) => needExecutor().source(param(req, "slug"))),
    "/api/executor/:slug/file": { PUT: json(async (req) => needExecutor().save(param(req, "slug"), query(req, "path"), await req.text())) },
    "/api/executor/:slug/deploy": { POST: json((req) => needExecutor().deploy(param(req, "slug"))) },
    "/api/executor/:slug/connect": {
      POST: json(async (req) => needExecutor().connect(param(req, "slug"), (await req.json()).requirement)),
    },
    "/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
    "/*": app,
  },
});

console.log(`deck on ${server.url}`);
