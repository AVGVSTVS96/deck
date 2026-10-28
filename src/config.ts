import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Repo = { id: string; name: string; path: string; about: string; review: boolean };

export type Tokenhub = { dir: string; state: string; config: string; onboard: string };

export type Config = {
  host: string;
  port: number;
  hex: string;
  claude: string;
  repos: Repo[];
  worktrees: string;
  drafts: { dir: string; targets: Record<string, string> } | null;
  tracker: string | null;
  tokenhub: Tokenhub | null;
  timezone: string;
  web: string;
  executor: { apps: string; token: string; api: string } | null;
  github: { users: string[]; vault: string } | null;
};

type FileConfig = Partial<Omit<Config, "repos" | "tokenhub">> & {
  repos?: Partial<Repo>[];
  tokenhub?: Partial<Tokenhub> & { dir: string; onboard: string };
};

const home = homedir();
const expand = (path: string) => resolve(path.replace(/^~(?=$|\/)/, home));

async function readFileConfig(): Promise<FileConfig> {
  const path = expand(process.env.DECK_CONFIG ?? "~/.config/deck/config.json");
  const file = Bun.file(path);

  if (!(await file.exists())) return {};

  return file.json();
}

function defaultRepos(hex: string): Repo[] {
  return [
    { id: "hex", name: "hex", path: hex, about: "Your files: rules, soul, schedules, memory", review: false },
    { id: "core", name: "hex core", path: join(hex, ".hex"), about: "hex itself, shared by every hex user", review: true },
  ];
}

export async function loadConfig(): Promise<Config> {
  const file = await readFileConfig();
  const hex = expand(file.hex ?? process.env.HEX_HOME ?? "~/hex");

  const repos = (file.repos ?? defaultRepos(hex)).map((repo) => ({
    id: repo.id ?? "",
    name: repo.name ?? repo.id ?? "",
    path: expand(repo.path ?? ""),
    about: repo.about ?? "",
    review: repo.review === true,
  }));

  if (file.tokenhub && !file.tokenhub.dir) {
    throw new Error(
      'deck config: "tokenhub" is now { "dir": <tokenhub folder>, "onboard": <its sign-in URL> }, and token-tracker\'s URL goes in "tracker".',
    );
  }

  return {
    host: process.env.HOST ?? file.host ?? "127.0.0.1",
    port: Number(process.env.PORT ?? file.port ?? 4810),
    hex,
    claude: expand(process.env.CLAUDE_CONFIG_DIR ?? file.claude ?? "~/.claude"),
    repos: repos.filter((repo) => repo.id && existsSync(join(repo.path, ".git"))),
    worktrees: expand(file.worktrees ?? "~/.local/share/deck/worktrees"),
    drafts: file.drafts ? { dir: expand(file.drafts.dir), targets: file.drafts.targets } : null,
    tracker: file.tracker ?? null,
    tokenhub: file.tokenhub?.dir
      ? {
          dir: expand(file.tokenhub.dir),
          state: expand(file.tokenhub.state ?? "~/.local/state/tokenhub"),
          config: expand(file.tokenhub.config ?? "~/.config/tokenhub"),
          onboard: file.tokenhub.onboard,
        }
      : null,
    timezone: file.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    web: expand(process.env.DECK_WEB ?? join(import.meta.dir, "../web")),
    executor: file.executor
      ? {
          apps: expand(file.executor.apps),
          token: expand(file.executor.token),
          api: file.executor.api,
        }
      : null,
    github: file.github?.users.length ? file.github : null,
  };
}
