# deck

A control room for [hex](https://github.com/AVGVSTVS96/hex) agents. See which agents use the most, what's running now and how much room each account has left, and browse, edit and ship hex's files, plugins and Executor apps.

```
 Edits ──ship──▶ Live files ──read by──▶ Sessions ◀──run on── Accounts
 (worktrees)     (your repos)            (hex threads)        (token pool)
```

- **Usage**: today, yesterday, or longer ranges, with current account capacity as one-click filters. Every hex thread, job and session ranked by tokens, API value, plan cost and share of each account's 5-hour and weekly limits, from [token-tracker](https://github.com/davis7dotsh/token-tracker)'s `GetSessionUsage` read. Group by agent, session, project, model, harness, device or account, filter by any of them, drill into a row's sessions, and export CSV. Selecting a row opens its detail above the ranking. Output and cached reads are shown separately; estimated quota and unmatched readings are labeled explicitly.
- **Live**: running sessions by app, with their state, account, host and folder, blocked jobs first, and the last day of account moves.
- **Accounts**: the tokenhub pool in rank order, with each account's limits against its cutoffs, a week of readings, held resets, sign-in expiry and top agents, plus the routing policy with preview and save, and sign-in for new accounts.
- **Files**: every configured repo as a file tree, rendered with [`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees) and [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs). The live checkout is read-only. Pressing Edit opens a git worktree on a `deck/<name>` branch, so running sessions keep reading the live files while you work. Edits save as you type. From the side panel you commit (always signed, refused otherwise), ship (rebase onto the live branch if it moved, then fast-forward), push, or remove the worktree. In a repo marked `review`, like hex core, Ship instead pushes the worktree's branch and opens a pull request into the live branch (or returns the one already open), and the live branch is never pushed directly.
- **Drafts**: a folder of proposed files, each shown as a diff against the live file it would replace, with one button to take it into a worktree.
- **Plugins**: hex channels, hex mods, and Claude Code plugins, with a switch that turns a Claude Code plugin on or off for new sessions.
- **Executor**: your [Executor](https://executor.sh) apps, their linked accounts and health, which framework version each one pins against what the host runs, and a diff of the deployed source against your local copy, editable, with deploy.

Everything updates live: the server keeps each source in memory, and one stream per tab sends only what changed.

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
    { "id": "core", "name": "hex core", "path": "~/hex/.hex", "about": "hex itself, shared by every hex user", "review": true }
  ],
  "worktrees": "~/.local/share/deck/worktrees",
  "drafts": { "dir": "~/drafts", "targets": { "AGENTS.md": "hex:AGENTS.md" } },
  "tracker": "http://127.0.0.1:8787",
  "tokenhub": { "dir": "~/tokenhub", "onboard": "http://127.0.0.1:4888" },
  "executor": { "apps": "~/executor-apps", "token": "~/.config/executor/token", "api": "https://app.executor.sh" }
}
```

| Field            | What it is                                                                      |
| ---------------- | ------------------------------------------------------------------------------- |
| `repos`          | Git repos to browse and edit. `id` appears in URLs.                             |
| `repos[].review` | Ship opens a pull request (via `gh`) instead of merging into the live checkout. |
| `worktrees`      | Where deck keeps its worktrees, one folder per repo.                            |
| `drafts.targets` | Maps a draft's file name to `repo:path` of the live file it replaces.           |
| `tracker`        | A token-tracker server, for Usage.                                              |
| `tokenhub.dir`   | A tokenhub checkout, for the account pool; `onboard` is its sign-in server.     |
| `timezone`       | The time zone Usage buckets days in. Defaults to the system's.                  |
| `executor.apps`  | A folder with one subfolder per Executor app slug holding its local source.     |
| `executor.token` | A file holding an Executor API token.                                           |

`HOST`, `PORT`, `HEX_HOME` and `CLAUDE_CONFIG_DIR` override the matching settings.

## Check

```sh
bun run check    # tsc, oxlint (with vendored anti-slop rules), oxfmt
```
