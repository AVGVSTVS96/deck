import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { GitStatus } from "@pierre/trees";
import type { Config, Repo } from "./config";
import type { Change, Changes, FileBody, RepoSummary, Workspace } from "./types";

const MAX_BYTES = 2_000_000;
const PREFIX = "deck/";

export class GitError extends Error {}

export async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  if (code !== 0) throw new GitError(err.trim() || out.trim() || `git ${args[0]} failed`);

  return out;
}

const attempt = (cwd: string, args: string[]) => git(cwd, args).catch(() => null);
const split = (out: string) => out.split("\0").filter(Boolean);
const untrackedFiles = (out: string) => split(out).filter((path) => !path.endsWith("/"));

async function lineCount(path: string) {
  const file = Bun.file(path);

  if (file.size > MAX_BYTES) return 0;

  return file
    .text()
    .then((text) => text.split("\n").length)
    .catch(() => 0);
}

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

async function liveBranch(repo: Repo) {
  const out = await attempt(repo.path, ["symbolic-ref", "--short", "-q", "HEAD"]);

  return out?.trim() || null;
}

export class Git {
  constructor(private config: Config) {}

  repo(id: string) {
    const repo = this.config.repos.find((r) => r.id === id);

    if (!repo) throw new GitError(`No repo named ${id}`);

    return repo;
  }

  private home(repo: Repo) {
    return join(this.config.worktrees, repo.id);
  }

  async workspaces(repo: Repo): Promise<Workspace[]> {
    const live: Workspace = {
      id: repo.id,
      repo: repo.id,
      name: null,
      path: repo.path,
      branch: await liveBranch(repo),
      base: null,
    };

    const home = this.home(repo) + sep;
    const blocks = (await git(repo.path, ["worktree", "list", "--porcelain"])).split("\n\n");

    const owned = blocks
      .map((block) => Object.fromEntries(block.split("\n").map((line) => [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)])))
      .filter((entry) => entry.worktree?.startsWith(home) && entry.branch);

    const trees = await Promise.all(
      owned.map(async (entry) => {
        const branch = entry.branch.replace("refs/heads/", "");
        const base = (await attempt(repo.path, ["config", "--get", `branch.${branch}.deckbase`]))?.trim();

        return {
          id: `${repo.id}~${basename(entry.worktree)}`,
          repo: repo.id,
          name: basename(entry.worktree),
          path: entry.worktree,
          branch,
          base: base || live.branch,
        };
      }),
    );

    return [live, ...trees];
  }

  async summary(repo: Repo): Promise<RepoSummary> {
    const unpushed = await attempt(repo.path, ["rev-list", "--count", "@{upstream}..HEAD"]);
    const workspaces = await this.workspaces(repo);

    return {
      id: repo.id,
      name: repo.name,
      about: repo.about,
      path: repo.path,
      branch: workspaces[0].branch,
      unpushed: unpushed === null ? null : Number(unpushed),
      workspaces,
    };
  }

  async workspace(id: string) {
    const [repoId] = id.split("~");
    const repo = this.repo(repoId);
    const found = (await this.workspaces(repo)).find((ws) => ws.id === id);

    if (!found) throw new GitError(`No workspace ${id}`);

    return { repo, ws: found };
  }

  async create(repo: Repo, name: string) {
    const taken = new Set((await git(repo.path, ["branch", "--list", "--format=%(refname:short)", `${PREFIX}*`])).split("\n"));
    const stem = slug(name) || "edit";
    let clean = stem;

    for (let n = 2; taken.has(PREFIX + clean) || existsSync(join(this.home(repo), clean)); n++) clean = `${stem}-${n}`;
    const path = join(this.home(repo), clean);
    const branch = PREFIX + clean;
    const base = await liveBranch(repo);
    const start = base ?? (await git(repo.path, ["rev-parse", "HEAD"])).trim();
    await mkdir(this.home(repo), { recursive: true });
    await git(repo.path, ["worktree", "add", "-b", branch, path, start]);
    await git(repo.path, ["config", `branch.${branch}.deckbase`, start]);

    return `${repo.id}~${clean}`;
  }

  async discard(id: string) {
    const { repo, ws } = await this.writable(id);
    await git(repo.path, ["worktree", "remove", "--force", ws.path]);
    const merged = ws.base !== null && (await attempt(repo.path, ["merge-base", "--is-ancestor", ws.branch ?? "", ws.base])) !== null;

    if (merged) await git(repo.path, ["branch", "-D", ws.branch ?? ""]);

    return { branchKept: merged ? null : ws.branch };
  }

  private async writable(id: string) {
    const found = await this.workspace(id);

    if (!found.ws.name) throw new GitError("The live checkout is read-only here. Start a worktree to edit.");

    return found;
  }

  private async fork(ws: Workspace) {
    if (!ws.name || !ws.base) return "HEAD";

    return (await git(ws.path, ["merge-base", "HEAD", ws.base])).trim();
  }

  async files(id: string) {
    const { ws } = await this.workspace(id);

    const [tracked, untracked] = await Promise.all([
      git(ws.path, ["ls-files", "-z", "--stage"]),
      git(ws.path, ["ls-files", "-z", "-o", "--exclude-standard"]),
    ]);

    const paths = split(tracked)
      .filter((entry) => !entry.startsWith("160000"))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1));

    return [...new Set([...paths, ...untrackedFiles(untracked)])].toSorted();
  }

  async changes(id: string): Promise<Changes> {
    const { ws } = await this.workspace(id);
    const fork = await this.fork(ws);

    const [numstat, untracked, porcelain] = await Promise.all([
      git(ws.path, ["diff", "-z", "--numstat", "--no-renames", "--ignore-submodules", fork]),
      git(ws.path, ["ls-files", "-z", "-o", "--exclude-standard"]),
      git(ws.path, ["status", "--porcelain", "--ignore-submodules"]),
    ]);

    const nameStatus = split(await git(ws.path, ["diff", "-z", "--name-status", "--no-renames", "--ignore-submodules", fork]));
    const statuses = new Map<string, string>();

    for (let i = 0; i < nameStatus.length; i += 2) statuses.set(nameStatus[i + 1], nameStatus[i]);

    const kinds = new Map<string, GitStatus>([
      ["A", "added"],
      ["D", "deleted"],
      ["M", "modified"],
    ]);

    const tracked: Change[] = split(numstat).map((line) => {
      const [added, removed, path] = line.split("\t");

      return { path, status: kinds.get(statuses.get(path) ?? "M") ?? "modified", added: Number(added) || 0, removed: Number(removed) || 0 };
    });

    const fresh = await Promise.all(
      untrackedFiles(untracked).map(async (path) => ({
        path,
        status: "untracked" as const,
        added: await lineCount(join(ws.path, path)),
        removed: 0,
      })),
    );

    const count = async (range: string) => (ws.name ? Number(await git(ws.path, ["rev-list", "--count", range])) : 0);

    return {
      files: [...tracked, ...fresh].toSorted((a, b) => a.path.localeCompare(b.path)),
      dirty: porcelain.trim().length > 0,
      ahead: await count(`${ws.base}..HEAD`),
      behind: await count(`HEAD..${ws.base}`),
    };
  }

  private inside(ws: Workspace, path: string) {
    const full = resolve(ws.path, path);

    if (!full.startsWith(ws.path + sep) || full.split(sep).includes(".git")) throw new GitError(`Path outside the workspace: ${path}`);

    return full;
  }

  async read(id: string, path: string): Promise<FileBody> {
    const { ws } = await this.workspace(id);
    const file = Bun.file(this.inside(ws, path));
    const exists = await file.exists();
    const tooLarge = exists && file.size > MAX_BYTES;
    const bytes = exists && !tooLarge ? new Uint8Array(await file.arrayBuffer()) : null;
    const binary = bytes?.includes(0) ?? false;
    const original = binary || tooLarge ? null : await attempt(ws.path, ["show", `${await this.fork(ws)}:${path}`]);

    return {
      path,
      contents: bytes && !binary ? new TextDecoder().decode(bytes) : null,
      original,
      binary,
      tooLarge,
    };
  }

  async write(id: string, path: string, contents: string) {
    const { ws } = await this.writable(id);
    const full = this.inside(ws, path);
    await mkdir(dirname(full), { recursive: true });
    await Bun.write(full, contents);
  }

  async commit(id: string, message: string) {
    const { ws } = await this.writable(id);

    if (!message.trim()) throw new GitError("Write a commit message first.");
    await git(ws.path, ["add", "-A"]);

    if ((await attempt(ws.path, ["diff", "--cached", "--quiet"])) !== null) throw new GitError("Nothing to commit.");
    await git(ws.path, ["commit", "-S", "-m", message.trim()]);
    const sha = (await git(ws.path, ["rev-parse", "HEAD"])).trim();

    return { sha, signed: await this.signed(ws.path, sha) };
  }

  private async signed(cwd: string, sha: string) {
    return (await git(cwd, ["cat-file", "commit", sha])).includes("-----BEGIN SSH SIGNATURE-----");
  }

  async ship(id: string) {
    const { repo, ws } = await this.writable(id);
    const changes = await this.changes(id);

    if (changes.dirty) throw new GitError("Commit your edits before shipping.");

    if (changes.ahead === 0) throw new GitError("Nothing to ship yet.");
    const live = await liveBranch(repo);

    if (!live || live !== ws.base)
      throw new GitError(`The live checkout is on ${live ?? "a detached HEAD"}, not ${ws.base}. Ship it by hand.`);

    if (changes.behind > 0) {
      await git(ws.path, ["rebase", live]).catch(async (error: Error) => {
        await attempt(ws.path, ["rebase", "--abort"]);
        throw new GitError(`${live} moved and the rebase hit a conflict, so nothing shipped. ${error.message}`);
      });
    }

    const commits = split((await git(ws.path, ["rev-list", "-z", `${live}..HEAD`])).replaceAll("\n", "\0"));
    const unsigned = (await Promise.all(commits.map(async (sha) => ((await this.signed(ws.path, sha)) ? null : sha)))).filter(Boolean);

    if (unsigned.length) throw new GitError(`Unsigned commits, not shipped: ${unsigned.join(", ")}`);
    await git(repo.path, ["merge", "--ff-only", ws.branch ?? ""]);

    return { branch: live, commits: commits.length, head: (await git(repo.path, ["rev-parse", "--short", "HEAD"])).trim() };
  }

  async push(repoId: string) {
    const repo = this.repo(repoId);
    await git(repo.path, ["push"]);

    return { pushed: true };
  }
}
