import { EditProvider, File, MultiFileDiff, Virtualizer } from "@pierre/diffs/react";
import { useRef, useState } from "react";
import { createEditor, diffOptions, fileOptions } from "../code";
import type { ExecutorApp, ExecutorOverview, ExecutorSource } from "../../src/types";
import { putText, relativeTime, send, useApi } from "../api";
import { Busy, Empty, Link, toast, useAction } from "../ui";

export default function Executor({ path }: { path: string }) {
  const slug = path.split("/")[2] ?? "";
  const overview = useApi<ExecutorOverview>("/executor", "executor");

  if (overview.error) return <Empty>{overview.error}</Empty>;

  if (!overview.data) return <Empty>Asking Executor…</Empty>;
  const { apps, framework } = overview.data;
  const selected = apps.find((a) => a.slug === slug) ?? null;
  const behind = apps.filter((a) => a.pinned && framework && a.pinned !== framework).length;

  return (
    <div className="page executor">
      <header className="head">
        <div>
          <h1>Executor</h1>
          <p className="lede">
            The apps on your Executor. The host runs <code>apps@{framework ?? "?"}</code>.
          </p>
        </div>
        <dl className="stats">
          <div>
            <dt>Apps</dt>
            <dd>{apps.length}</dd>
          </div>
          <div>
            <dt>Local source</dt>
            <dd>{apps.filter((a) => a.local).length}</dd>
          </div>
          <div>
            <dt>Pinned behind host</dt>
            <dd className={behind ? "warn" : ""}>{behind}</dd>
          </div>
        </dl>
      </header>
      <section className="section">
        <div className="cells">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} framework={framework} selected={app.slug === slug} reload={overview.reload} />
          ))}
        </div>
      </section>
      {selected?.local && <AppSource key={selected.slug} app={selected} reload={overview.reload} />}
      {selected && !selected.local && <Empty>{selected.name} has no local source here, so it's managed in Executor itself.</Empty>}
    </div>
  );
}

function AppCard({
  app,
  framework,
  selected,
  reload,
}: {
  app: ExecutorApp;
  framework: string | null;
  selected: boolean;
  reload: () => Promise<void>;
}) {
  const { busy, run } = useAction();
  const behind = app.pinned && framework && app.pinned !== framework;

  const connect = (requirement: string) =>
    run(requirement, async () => {
      const { url } = await send<{ url: string }>(`/executor/${app.slug}/connect`, "POST", { requirement });
      window.open(url, "_blank", "noopener");
      toast(`Opened Executor's sign-in for ${requirement}`);
      await reload();
    });

  return (
    <article className={selected ? "cell on" : "cell"}>
      <div className="cell-title">
        <span className="name">{app.name}</span>
        <span className="ver">{app.slug}</span>
        <span className="spacer" />
        {app.local ? <span className="chip">local source</span> : <span className="chip">hosted</span>}
      </div>
      <dl className="facts">
        <dt>Running</dt>
        <dd>{app.deployedAt ? `deployed ${relativeTime(app.deployedAt)}` : "not deployed"}</dd>
        <dt>Versions</dt>
        <dd>{app.versions}</dd>
        {app.pinned && (
          <>
            <dt>Pins</dt>
            <dd className={behind ? "warn" : ""} title={behind ? `The host runs ${framework}` : undefined}>
              apps@{app.pinned}
              {behind && " · host is newer"}
            </dd>
          </>
        )}
      </dl>
      <ul className="reqs">
        {app.requirements.map((req) => {
          const linked = app.accounts.filter((a) => a.requirement === req);

          return (
            <li key={req}>
              <span className={linked.some((a) => a.health === "healthy") ? "dot live" : linked.length ? "dot warn" : "dot idle"} />
              <span className="req">{req}</span>
              <span className="muted" title={linked.map((a) => `${a.label}: ${a.health}`).join("\n")}>
                {linked.map((a) => a.label).join(", ") || "no account"}
              </span>
              <Busy on={busy === req} className="quiet small" onClick={() => connect(req)}>
                {linked.length ? "Add account" : "Connect"}
              </Busy>
            </li>
          );
        })}
      </ul>
      {app.local && (
        <div className="cell-foot">
          <Link to={selected ? "/executor" : `/executor/${app.slug}`}>{selected ? "Close source" : "Compare and edit source →"}</Link>
        </div>
      )}
    </article>
  );
}

function AppSource({ app, reload }: { app: ExecutorApp; reload: () => Promise<void> }) {
  const source = useApi<ExecutorSource>(`/executor/${app.slug}`, "executor");
  const [editing, setEditing] = useState<string | null>(null);
  const { busy, run } = useAction();
  const files = source.data?.files ?? [];
  const differs = files.some((f) => f.local !== f.deployed);

  const deploy = () =>
    run("deploy", async () => {
      if (!confirm(`Deploy your local ${app.name} source to Executor? It becomes the running version.`)) return;
      const result = await send<{ version: string | null; files: number }>(`/executor/${app.slug}/deploy`, "POST");
      toast(`Deployed ${result.files} files${result.version ? ` as ${result.version.slice(0, 12)}` : ""}`);
      await Promise.all([source.reload(), reload()]);
    });

  if (source.error) return <Empty>{source.error}</Empty>;

  if (!source.data) return <Empty>Fetching deployed source…</Empty>;

  return (
    <section className="section">
      <div className="section-head">
        <h2>{app.name}: running vs local</h2>
        <span className="sub">
          {files.filter((f) => f.local !== f.deployed).length} of {files.length} files differ
        </span>
        <span className="spacer" />
        <Busy
          on={busy === "deploy"}
          className="primary"
          disabled={!differs || editing !== null}
          onClick={deploy}
          title={differs ? undefined : "Local matches what's running"}
        >
          {differs ? "Deploy local source" : "Up to date"}
        </Busy>
      </div>
      <EditProvider createEditor={createEditor}>
        {files.map((f) => (
          <SourceFile
            key={f.path}
            slug={app.slug}
            file={f}
            editing={editing === f.path}
            setEditing={(on) => setEditing(on ? f.path : null)}
            onSaved={source.reload}
          />
        ))}
      </EditProvider>
    </section>
  );
}

function SourceFile({
  slug,
  file,
  editing,
  setEditing,
  onSaved,
}: {
  slug: string;
  file: ExecutorSource["files"][number];
  editing: boolean;
  setEditing: (on: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const latest = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);

  const finish = async () => {
    if (latest.current !== null) {
      setSaving(true);
      await putText(`/executor/${slug}/file?path=${encodeURIComponent(file.path)}`, latest.current);
      setSaving(false);
      toast(`Saved ${file.path} locally`);
      await onSaved();
    }

    setEditing(false);
  };

  const local = file.local ?? "";

  return (
    <div className="viewer">
      <div className="viewer-head">
        <div className="crumbs">
          <span className={file.local === file.deployed ? "dot live" : "dot wt"} />
          <span className="path">{file.path}</span>
          <span className="muted">
            {file.local === file.deployed ? " same as running" : file.deployed === null ? " not deployed yet" : " differs from running"}
          </span>
        </div>
        <div className="actions">
          {editing ? (
            <Busy on={saving} className="primary" onClick={finish}>
              Save locally
            </Busy>
          ) : (
            <button
              onClick={() => {
                latest.current = null;
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
      </div>
      <Virtualizer className="code">
        {file.deployed !== null && file.deployed !== local ? (
          <MultiFileDiff
            oldFile={{ name: file.path, contents: file.deployed }}
            newFile={{ name: file.path, contents: local }}
            options={diffOptions}
            edit={editing}
            onEditChange={(e) => (latest.current = e.file.contents)}
            onEditComplete={() => "accept"}
          />
        ) : (
          <File
            file={{ name: file.path, contents: local }}
            options={fileOptions}
            edit={editing}
            onEditChange={(e) => (latest.current = e.file.contents)}
            onEditComplete={() => "accept"}
          />
        )}
      </Virtualizer>
    </div>
  );
}
