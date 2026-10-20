import { EditProvider, File, MultiFileDiff, Virtualizer } from "@pierre/diffs/react";
import { createEditor, diffOptions, fileOptions } from "../code";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { Changes, Draft, FileBody, RepoSummary, Workspace } from "../../src/types";
import { navigate, putText, send, useApi } from "../api";
import { Busy, Empty, Link, fail, toast, useAction } from "../ui";

const DRAFTS = "drafts";
const LIST_CAP = 200;

const fileUrl = (ws: string, path?: string) => `/files/${ws}${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}`;
const fileApi = (ws: string, path: string) => `/ws/${encodeURIComponent(ws)}/file?path=${encodeURIComponent(path)}`;
const nameFor = (path: string) => path.split("/").pop()!.replace(/\./g, "-");

function parse(path: string) {
  const [, , ws = "", ...rest] = path.split("/");

  return { ws: decodeURIComponent(ws), file: rest.map(decodeURIComponent).join("/") };
}

export default function Files({ path }: { path: string }) {
  const route = parse(path);
  const repos = useApi<RepoSummary[]>("/repos", "repo:", "ws:");
  const drafts = useApi<Draft[]>("/drafts", "drafts");
  const [treeOpen, setTreeOpen] = useState(false);

  useEffect(() => {
    if (!route.ws && repos.data?.[0]) navigate(fileUrl(repos.data[0].id), true);
  }, [route.ws, repos.data]);

  const workspace = repos.data?.flatMap((r) => r.workspaces).find((w) => w.id === route.ws) ?? null;
  const repo = repos.data?.find((r) => r.id === (workspace?.repo ?? route.ws.split("~")[0])) ?? null;
  const isDrafts = route.ws === DRAFTS;

  if (repos.error) return <Empty>{repos.error}</Empty>;

  if (!repos.data) return <Empty>Loading repos…</Empty>;

  if (!isDrafts && route.ws && !workspace) return <Empty>No workspace {route.ws}. It may have been shipped and removed.</Empty>;

  return (
    <div className="files">
      <header className="sources">
        <nav className="repo-tabs" aria-label="Repos">
          {repos.data.map((r) => (
            <Link key={r.id} to={fileUrl(r.id)} current={repo?.id === r.id && !isDrafts}>
              {r.name}
              {r.workspaces.length > 1 && <span className="count">{r.workspaces.length - 1}</span>}
            </Link>
          ))}
          {(drafts.data?.length ?? 0) > 0 && (
            <Link to={fileUrl(DRAFTS)} current={isDrafts}>
              drafts<span className="count">{drafts.data!.length}</span>
            </Link>
          )}
        </nav>
        {repo && !isDrafts && <WorkspaceBar repo={repo} current={route.ws} file={route.file} />}
      </header>
      <div className={["panes", treeOpen && "tree-open", isDrafts && "no-side"].filter(Boolean).join(" ")}>
        <aside className="tree-pane">
          {isDrafts ? (
            <DraftTree
              drafts={drafts.data ?? []}
              selected={route.file}
              onPick={(p) => (setTreeOpen(false), navigate(fileUrl(DRAFTS, p)))}
            />
          ) : (
            workspace && (
              <WorkspaceTree
                key={workspace.id}
                ws={workspace}
                selected={route.file}
                onPick={(p) => (setTreeOpen(false), navigate(fileUrl(workspace.id, p)))}
              />
            )
          )}
        </aside>
        <section className="viewer-pane">
          <button className="tree-toggle" onClick={() => setTreeOpen((v) => !v)}>
            {treeOpen ? "Close files" : "Browse files"}
          </button>
          {isDrafts ? (
            route.file ? (
              <DraftViewer key={route.file} draft={drafts.data?.find((d) => d.name === route.file) ?? null} repos={repos.data} />
            ) : (
              <Empty>Pick a draft to see it against the live file.</Empty>
            )
          ) : workspace && route.file ? (
            <Viewer key={`${workspace.id}:${route.file}`} ws={workspace} path={route.file} />
          ) : (
            <Empty>
              Pick a file. The live checkout is read-only here; Edit starts a worktree so running sessions keep reading the live files.
            </Empty>
          )}
        </section>
        {workspace && repo && !isDrafts && <ChangesPanel ws={workspace} repo={repo} file={route.file} />}
      </div>
    </div>
  );
}

function WorkspaceBar({ repo, current, file }: { repo: RepoSummary; current: string; file: string }) {
  const { busy, run } = useAction();
  const [naming, setNaming] = useState<string | null>(null);

  const create = (name: string) =>
    run("new", async () => {
      const { id } = await send<{ id: string }>(`/repos/${repo.id}/workspaces`, "POST", { name });
      setNaming(null);
      navigate(fileUrl(id, file));
      toast(`Started worktree ${id.split("~")[1]} from ${repo.branch ?? "HEAD"}`);
    });

  return (
    <nav className="ws-bar" aria-label="Checkouts">
      {repo.workspaces.map((ws) => (
        <Link key={ws.id} to={fileUrl(ws.id, file)} current={ws.id === current}>
          <span className={ws.name ? "dot wt" : "dot live"} />
          {ws.name ?? `live · ${ws.branch ?? "detached"}`}
        </Link>
      ))}
      {naming === null ? (
        <button className="ws-add" onClick={() => setNaming(file ? nameFor(file) : "edit")}>
          + worktree
        </button>
      ) : (
        <form
          className="ws-new"
          onSubmit={(e) => {
            e.preventDefault();

            if (naming.trim()) create(naming.trim());
          }}
        >
          <span className="dot wt" />
          <input
            autoFocus
            aria-label="Worktree name"
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
            onBlur={() => busy !== "new" && !naming.trim() && setNaming(null)}
          />
          <Busy on={busy === "new"} className="small primary" type="submit">
            Start
          </Busy>
          <button type="button" className="small quiet" onClick={() => setNaming(null)}>
            Cancel
          </button>
        </form>
      )}
    </nav>
  );
}

function WorkspaceTree({ ws, selected, onPick }: { ws: Workspace; selected: string; onPick: (path: string) => void }) {
  const files = useApi<string[]>(`/ws/${encodeURIComponent(ws.id)}/files`, `ws:${ws.id}`, `repo:${ws.repo}`);

  const changes = useApi<Changes>(`/ws/${encodeURIComponent(ws.id)}/changes`, `ws:${ws.id}`, `repo:${ws.repo}`);

  const status = useMemo<GitStatusEntry[]>(
    () => changes.data?.files.map((c) => ({ path: c.path, status: c.status })) ?? [],
    [changes.data],
  );

  return <PathTree paths={files.data} status={status} selected={selected} onPick={onPick} />;
}

function DraftTree({ drafts, selected, onPick }: { drafts: Draft[]; selected: string; onPick: (path: string) => void }) {
  const paths = useMemo(() => drafts.map((d) => d.name), [drafts]);
  const status = useMemo<GitStatusEntry[]>(() => drafts.map((d) => ({ path: d.name, status: "modified" })), [drafts]);

  return <PathTree paths={paths} status={status} selected={selected} onPick={onPick} />;
}

const ancestors = (path: string) => {
  const parts = path.split("/").slice(0, -1);

  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};

function PathTree({
  paths,
  status,
  selected,
  onPick,
}: {
  paths: string[] | null;
  status: GitStatusEntry[];
  selected: string;
  onPick: (path: string) => void;
}) {
  const known = useRef<Set<string> | null>(null);
  const pick = useEffectEvent((path: string) => onPick(path));
  const openAround = useEffectEvent(() => ancestors(selected));

  const { model } = useFileTree({
    paths: [],
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    search: true,
    density: "compact",
    onSelectionChange: (picked) => {
      const path = picked[0];

      if (path && known.current?.has(path)) pick(path);
    },
  });

  useEffect(() => {
    if (!paths) return;

    const previous = known.current;
    const next = new Set(paths);

    known.current = next;

    if (!previous) return model.resetPaths(paths, { initialExpandedPaths: openAround() });

    const added = paths.flatMap((path) => (previous.has(path) ? [] : [{ type: "add" as const, path }]));
    const removed = [...previous].flatMap((path) => (next.has(path) ? [] : [{ type: "remove" as const, path }]));

    if (added.length || removed.length) model.batch([...removed, ...added]);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [model, status]);

  useEffect(() => {
    if (!paths || !selected || !known.current?.has(selected)) return;

    for (const dir of ancestors(selected)) {
      const item = model.getItem(dir);

      if (item && "expand" in item && !item.isExpanded()) item.expand();
    }

    const item = model.getItem(selected);

    if (item && !item.isSelected()) {
      item.select();
      model.scrollToPath(selected, { focus: false, offset: "nearest" });
    }
  }, [model, paths, selected]);

  if (!paths) return <Empty>Loading files…</Empty>;

  return <FileTree model={model} className="tree" />;
}

function Viewer({ ws, path }: { ws: Workspace; path: string }) {
  const [editing, setEditing] = useState(() => sessionStorage.getItem("deck:edit") === `${ws.id}:${path}`);

  const live = useApi<FileBody>(fileApi(ws.id, path), `ws:${ws.id}`, `repo:${ws.repo}`);
  const [held, setHeld] = useState<FileBody | null>(null);

  if (editing && !held && live.data) setHeld(live.data);
  const body = { ...live, data: editing ? (held ?? live.data) : live.data };

  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<"file" | "diff" | null>(null);
  const saver = useSaver(ws.id, path);
  const { busy, run } = useAction();

  useEffect(() => {
    sessionStorage.removeItem("deck:edit");
  }, []);

  if (body.error) return <Empty>{body.error}</Empty>;

  if (!body.data) return <Empty>Opening {path}…</Empty>;

  if (body.data.binary) return <Empty>Binary file. Nothing to show here.</Empty>;

  if (body.data.tooLarge) return <Empty>This file is over 2 MB, so deck leaves it alone.</Empty>;

  const contents = draft ?? body.data.contents ?? "";

  const changed = body.data.original !== null && body.data.original !== contents;
  const shown = mode ?? (changed ? "diff" : "file");

  const startEdit = () =>
    run("edit", async () => {
      if (ws.name) return setEditing(true);

      const { id } = await send<{ id: string }>(`/repos/${ws.repo}/workspaces`, "POST", { name: nameFor(path) });
      sessionStorage.setItem("deck:edit", `${id}:${path}`);
      toast(`Started worktree ${id.split("~")[1]} from ${ws.branch ?? "HEAD"}. Edits land there, not in the live files.`);
      navigate(fileUrl(id, path));
    });

  const file = { name: path, contents, cacheKey: `${ws.id}:${path}:${body.data.original?.length}:${contents.length}` };
  const onChange = (text: string) => saver.save(text);

  const onComplete = (text: string | undefined) => {
    if (text !== undefined) setDraft(text);

    return "accept" as const;
  };

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="crumbs">
          <span className={ws.name ? "dot wt" : "dot live"} />
          <span className="path">{path}</span>
        </div>
        <div className="actions">
          <div className="seg" role="group">
            <button aria-pressed={shown === "file"} onClick={() => setMode("file")}>
              File
            </button>
            <button
              aria-pressed={shown === "diff"}
              disabled={!changed}
              onClick={() => setMode("diff")}
              title={changed ? `Against ${ws.name ? "where this worktree started" : "the last commit"}` : "No changes"}
            >
              Changes
            </button>
          </div>
          <span className="muted small">{editing ? saver.label : ""}</span>
          {editing ? (
            <button
              className="primary"
              onClick={() => {
                setEditing(false);
                setDraft(null);
                setHeld(null);
                void live.reload();
              }}
            >
              Done
            </button>
          ) : (
            <Busy on={busy === "edit"} className="primary" onClick={startEdit}>
              {ws.name ? "Edit" : "Edit in a worktree"}
            </Busy>
          )}
        </div>
      </div>
      <EditProvider createEditor={createEditor}>
        <Virtualizer className="code">
          {shown === "diff" && body.data.original !== null ? (
            <MultiFileDiff
              oldFile={{ name: path, contents: body.data.original }}
              newFile={file}
              options={diffOptions}
              edit={editing}
              editStateKey={`${ws.id}:${path}`}
              onEditChange={(e) => onChange(e.file.contents)}
              onEditComplete={(e) => onComplete(e.newFile?.contents)}
            />
          ) : (
            <File
              file={file}
              options={fileOptions}
              edit={editing}
              editStateKey={`${ws.id}:${path}`}
              onEditChange={(e) => onChange(e.file.contents)}
              onEditComplete={(e) => onComplete(e.file?.contents)}
            />
          )}
        </Virtualizer>
      </EditProvider>
    </div>
  );
}

function useSaver(ws: string, path: string) {
  const queue = useRef<{ pending: string | null; chain: Promise<void> }>({ pending: null, chain: Promise.resolve() });
  const [label, setLabel] = useState("Editing the worktree copy");

  const flush = async () => {
    const text = queue.current.pending;

    if (text === null) return;

    queue.current.pending = null;
    setLabel("Saving…");

    try {
      await putText(fileApi(ws, path), text);
      setLabel(queue.current.pending === null ? "Saved to worktree" : "Saving…");
    } catch (error) {
      setLabel("Not saved");
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    label,
    save(text: string) {
      queue.current.pending = text;
      queue.current.chain = queue.current.chain.then(flush);
    },
  };
}

function ChangesPanel({ ws, repo, file }: { ws: Workspace; repo: RepoSummary; file: string }) {
  const changes = useApi<Changes>(`/ws/${encodeURIComponent(ws.id)}/changes`, `ws:${ws.id}`, `repo:${ws.repo}`);

  const [message, setMessage] = useState("");
  const { busy, run } = useAction();
  const c = changes.data;

  const commit = () =>
    run("commit", async () => {
      const result = await send<{ sha: string; signed: boolean }>(`/ws/${encodeURIComponent(ws.id)}/commit`, "POST", { message });
      setMessage("");
      toast(`Committed ${result.sha.slice(0, 7)}${result.signed ? ", signed" : ", NOT signed"}`, result.signed ? "ok" : "bad");
      await changes.reload();
    });

  const ship = () =>
    run("ship", async () => {
      const result = await send<{ branch: string; commits: number; head?: string; pr?: string }>(
        `/ws/${encodeURIComponent(ws.id)}/ship`,
        "POST",
      );

      const commits = `${result.commits} commit${result.commits === 1 ? "" : "s"}`;
      toast(result.pr ? `Pull request for ${commits}: ${result.pr}` : `Shipped ${commits} to ${result.branch} (${result.head})`);
      await changes.reload();
    });

  const discard = () =>
    run("discard", async () => {
      const unshipped = (c?.ahead ?? 0) > 0 || c?.dirty;

      if (
        !confirm(
          unshipped
            ? `Remove worktree ${ws.name}? Its unshipped work stays on branch ${ws.branch}, uncommitted edits are lost.`
            : `Remove worktree ${ws.name}?`,
        )
      )
        return;
      const result = await send<{ branchKept: string | null }>(`/ws/${encodeURIComponent(ws.id)}`, "DELETE");
      toast(result.branchKept ? `Removed. Branch ${result.branchKept} kept.` : `Removed worktree ${ws.name}`);
      navigate(fileUrl(repo.id, file), true);
    });

  const push = () =>
    run("push", async () => {
      await send(`/repos/${repo.id}/push`, "POST");
      toast(`Pushed ${repo.branch}`);
    });

  return (
    <aside className="changes-pane">
      {ws.name ? (
        <div className="flow">
          <span className="chip">
            <span className="dot wt" />
            {ws.branch}
          </span>
          <span className="muted">→</span>
          <span className="chip">
            <span className="dot live" />
            {ws.base}
          </span>
        </div>
      ) : (
        <p className="note">
          Live checkout on <b>{ws.branch ?? "a detached HEAD"}</b>. Running sessions read these files, so edits go to a worktree.
        </p>
      )}
      {c && ws.name && (
        <div className="counts">
          <span title="Commits on this worktree that the live branch doesn't have">
            <b>{c.ahead}</b>to ship
          </span>
          <span title={`Commits on ${ws.base} since this worktree started; shipping rebases onto them`}>
            <b>{c.behind}</b>new on {ws.base}
          </span>
        </div>
      )}
      <h3>
        {ws.name ? "Changed here" : "Uncommitted in live"}
        {c && <span className="num">{c.files.length}</span>}
      </h3>
      {c?.files.length ? (
        <ul className="change-list">
          {c.files.slice(0, LIST_CAP).map((f) => (
            <li key={f.path}>
              <Link to={fileUrl(ws.id, f.path)}>
                <span className={`st ${f.status}`}>{f.status[0].toUpperCase()}</span>
                <span className="cp">{f.path}</span>
                <span className="delta">
                  <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
                </span>
              </Link>
            </li>
          ))}
          {c.files.length > LIST_CAP && <li className="muted small">and {c.files.length - LIST_CAP} more</li>}
        </ul>
      ) : (
        <p className="muted">{changes.error ?? (changes.data ? "Nothing changed." : "…")}</p>
      )}
      {ws.name && (
        <div className="commit">
          <textarea
            placeholder="Commit message"
            value={message}
            rows={3}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && commit()}
          />
          <Busy on={busy === "commit"} className="primary" disabled={!c?.dirty || !message.trim()} onClick={commit}>
            Commit, signed
          </Busy>
          <Busy on={busy === "ship"} disabled={!c || c.dirty || c.ahead === 0} onClick={ship} title={c?.dirty ? "Commit first" : undefined}>
            {repo.review ? `Open PR into ${ws.base}` : `Ship ${c?.ahead || ""} to ${ws.base}`}
          </Busy>
          <Busy on={busy === "discard"} className="quiet" onClick={discard}>
            Remove worktree
          </Busy>
        </div>
      )}
      {!repo.review && (repo.unpushed ?? 0) > 0 && (
        <div className="push">
          <p className="muted">
            {repo.branch} is {repo.unpushed} commit{repo.unpushed === 1 ? "" : "s"} ahead of its remote.
          </p>
          <Busy on={busy === "push"} onClick={push}>
            Push {repo.branch}
          </Busy>
        </div>
      )}
    </aside>
  );
}

function DraftViewer({ draft, repos }: { draft: Draft | null; repos: RepoSummary[] }) {
  const text = useApi<{ contents: string }>(draft ? `/drafts/${encodeURIComponent(draft.name)}` : null, "drafts");
  const live = useApi<FileBody>(draft?.target ? fileApi(draft.target.repo, draft.target.path) : null, `repo:${draft?.target?.repo}`);
  const { busy, run } = useAction();

  if (!draft) return <Empty>No such draft.</Empty>;

  if (!text.data) return <Empty>Opening {draft.name}…</Empty>;
  const target = draft.target;
  const repo = repos.find((r) => r.id === target?.repo);

  const take = () =>
    run("take", async () => {
      if (!target || !repo) return;
      const { id } = await send<{ id: string }>(`/repos/${repo.id}/workspaces`, "POST", { name: `draft-${nameFor(target.path)}` });
      await putText(fileApi(id, target.path), text.data!.contents);
      toast(`Draft written into worktree ${id.split("~")[1]}. Review, edit, then commit.`);
      navigate(fileUrl(id, target.path));
    });

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="crumbs">
          <span className="dot draft" />
          <span className="path">{draft.name}</span>
          {target && repo && (
            <span className="muted">
              {" "}
              against live {repo.name}/{target.path}
            </span>
          )}
        </div>
        <div className="actions">
          {target && repo ? (
            <Busy on={busy === "take"} className="primary" onClick={take}>
              Take into a worktree
            </Busy>
          ) : (
            <span className="muted">No live file mapped</span>
          )}
        </div>
      </div>
      <Virtualizer className="code">
        {live.data?.contents != null ? (
          <MultiFileDiff
            oldFile={{ name: target!.path, contents: live.data.contents }}
            newFile={{ name: target!.path, contents: text.data.contents }}
            options={diffOptions}
          />
        ) : (
          <File file={{ name: draft.name, contents: text.data.contents }} options={fileOptions} />
        )}
      </Virtualizer>
    </div>
  );
}
