# deck

A control room for [hex](https://github.com/AVGVSTVS96/hex) agents. Browse and edit hex's files, commit and ship them, and see the sessions, plugins, Executor apps and account pool they run on.

```
 Edits ──ship──▶ Live files ──read by──▶ Sessions ◀──run on── Accounts
 (worktrees)     (your repos)            (hex threads)        (token pool)
```

- **Files**: every configured repo as a file tree, rendered with [`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees) and [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs). The live checkout is read-only. Pressing Edit opens a git worktree on a `deck/<name>` branch, so running sessions keep reading the live files while you work. Edits save as you type. From the side panel you commit (always signed, refused otherwise), ship (rebase onto the live branch if it moved, then fast-forward), push, or remove the worktree.
- **Drafts**: a folder of proposed files, each shown as a diff against the live file it would replace, with one button to take it into a worktree.
- **Agents**: every hex thread across Telegram, Discord, Buzz and T3 Code, which ones are running right now, and the pooled account each one is bound to, with 5-hour and weekly usage against the pool's switch-over thresholds.
- **Plugins**: hex channels, hex mods, and Claude Code plugins, with a switch that turns a Claude Code plugin on or off for new sessions.
- **Executor**: your [Executor](https://executor.sh) apps, their linked accounts and health, which framework version each one pins against what the host runs, and a diff of the deployed source against your local copy, editable, with deploy.

Everything updates live from file watchers on the repos, worktrees, hex's thread lists and Claude Code's session registry.

## Run

```sh
bun install
bun run dev      # with hot reload
bun run start    # production
```

deck serves on `127.0.0.1:4810` by default. It has no login of its own: it can edit files, commit and deploy, so bind it only to an interface you trust, like a Tailscale address.

## Configure

deck reads `~/.config/deck/config.json` (or the path in `DECK_CONFIG`). Every field is optional; with no file it shows `~/hex` and `~/hex/.hex`.

```json
{
  "host": "127.0.0.1",
  "port": 4810,
  "hex": "~/hex",
  "repos": [
    { "id": "hex", "name": "hex", "path": "~/hex", "about": "Your files: rules, soul, schedules, memory" },
    { "id": "core", "name": "hex core", "path": "~/hex/.hex", "about": "hex itself, shared by every hex user" }
  ],
  "worktrees": "~/.local/share/deck/worktrees",
  "drafts": { "dir": "~/drafts", "targets": { "AGENTS.md": "hex:AGENTS.md" } },
  "tokenhub": "http://127.0.0.1:8787",
  "executor": { "apps": "~/executor-apps", "token": "~/.config/executor/token", "api": "https://app.executor.sh" }
}
```

| Field            | What it is                                                                  |
| ---------------- | --------------------------------------------------------------------------- |
| `repos`          | Git repos to browse and edit. `id` appears in URLs.                         |
| `worktrees`      | Where deck keeps its worktrees, one folder per repo.                        |
| `drafts.targets` | Maps a draft's file name to `repo:path` of the live file it replaces.       |
| `tokenhub`       | A tokenhub server, for the account pool.                                    |
| `executor.apps`  | A folder with one subfolder per Executor app slug holding its local source. |
| `executor.token` | A file holding an Executor API token.                                       |

`HOST`, `PORT`, `HEX_HOME` and `CLAUDE_CONFIG_DIR` override the matching settings.

## Check

```sh
bun run check    # tsc, oxlint (with vendored anti-slop rules), oxfmt
```
