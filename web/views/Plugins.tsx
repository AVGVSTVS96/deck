import { useState } from "react";
import type { Plugin } from "../../src/types";
import { send, useLoad } from "../api";
import { Empty, Link, fail, toast } from "../ui";

const GROUPS: { kind: Plugin["kind"]; title: string; about: string }[] = [
  {
    kind: "channel",
    title: "Channels",
    about: "How you reach hex. The hub starts each session with its channel, so these stay off in Claude Code's own list.",
  },
  { kind: "mod", title: "Mods", about: "Changes to hex's own behavior, shipped in hex core." },
  { kind: "claude", title: "Claude Code plugins", about: "Installed for your user. The switch turns one on or off for every new session." },
];

const sourceUrl = (p: Plugin) => (p.source ? `/files/${p.source.repo}/${p.source.path}` : null);

export function Plugins() {
  const list = useLoad<Plugin[]>("/plugins", (e) => e.type === "plugins");

  if (list.error) return <Empty>{list.error}</Empty>;

  if (!list.data) return <Empty>Reading plugins…</Empty>;

  return (
    <div className="page plugins">
      <header className="page-head">
        <h1>Plugins</h1>
        <p className="lede">
          {list.data.filter((p) => p.kind === "channel" && p.state === "connected").length} channels connected,{" "}
          {list.data.filter((p) => p.kind === "claude" && p.enabled).length} Claude Code plugins on.
        </p>
      </header>
      {GROUPS.map((group) => {
        const items = list.data!.filter((p) => p.kind === group.kind);

        if (!items.length) return null;

        return (
          <section key={group.kind}>
            <div className="section-head">
              <h2>{group.title}</h2>
            </div>
            <p className="muted small">{group.about}</p>
            <div className="plugin-grid">
              {items.map((p) => (
                <PluginCard key={p.id} plugin={p} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PluginCard({ plugin }: { plugin: Plugin }) {
  const [enabled, setEnabled] = useState(plugin.enabled);
  const [busy, setBusy] = useState(false);
  const source = sourceUrl(plugin);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    setBusy(true);

    try {
      await send(`/plugins/${encodeURIComponent(plugin.id)}`, "POST", { enabled: next });
      toast(`${plugin.name} ${next ? "on" : "off"} for new sessions`);
    } catch (error) {
      setEnabled(!next);
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="plugin-card">
      <div className="plugin-title">
        <span className="pname">{plugin.name}</span>
        {plugin.version && <span className="ver">{plugin.version}</span>}
        <span className="spacer" />
        {plugin.state && plugin.kind === "channel" && (
          <span className={`chip ${plugin.state === "connected" ? "live" : ""}`}>{plugin.state}</span>
        )}
        {plugin.kind === "claude" && (
          <button
            role="switch"
            aria-checked={!!enabled}
            className="switch"
            disabled={busy}
            onClick={toggle}
            aria-label={plugin.name}
            title={enabled ? "On for new sessions" : "Off"}
          >
            <span />
          </button>
        )}
      </div>
      {plugin.description && <p className="pdesc">{plugin.description}</p>}
      <div className="plugin-foot">
        {plugin.kind === "claude" && <span className="muted">{plugin.state}</span>}
        {source && <Link to={source}>Open source →</Link>}
      </div>
    </article>
  );
}
