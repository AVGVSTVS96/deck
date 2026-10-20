import { useState } from "react";
import type { Plugin } from "../../src/types";
import { send, useApi } from "../api";
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

export default function Plugins() {
  const list = useApi<Plugin[]>("/plugins", "plugins");

  if (list.error) return <Empty>{list.error}</Empty>;

  if (!list.data) return <Empty>Reading plugins…</Empty>;

  const count = (kind: Plugin["kind"], on: (p: Plugin) => boolean) => {
    const of = list.data!.filter((p) => p.kind === kind);

    return `${of.filter(on).length}/${of.length}`;
  };

  return (
    <div className="page plugins">
      <header className="head">
        <div>
          <h1>Plugins</h1>
          <p className="lede">What reaches hex, and what every new session loads.</p>
        </div>
        <dl className="stats">
          <div>
            <dt>Channels connected</dt>
            <dd>{count("channel", (p) => p.state === "connected")}</dd>
          </div>
          <div>
            <dt>Claude Code plugins on</dt>
            <dd>{count("claude", (p) => !!p.enabled)}</dd>
          </div>
        </dl>
      </header>
      {GROUPS.map((group) => {
        const items = list.data!.filter((p) => p.kind === group.kind);

        if (!items.length) return null;

        return (
          <section key={group.kind} className="section">
            <div className="section-head">
              <h2>{group.title}</h2>
              <span className="sub">{group.about}</span>
            </div>
            <div className="cells">
              {items.map((p) => (
                <PluginCard key={`${p.id}:${p.enabled}`} plugin={p} />
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
    <article className="cell">
      <div className="cell-title">
        <span className="name">{plugin.name}</span>
        {plugin.version && <span className="ver">{plugin.version}</span>}
        <span className="spacer" />
        {plugin.state && plugin.kind === "channel" && (
          <span className="chip">
            <span className={plugin.state === "connected" ? "dot live" : "dot idle"} />
            {plugin.state}
          </span>
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
      {plugin.description && <p className="desc">{plugin.description}</p>}
      <div className="cell-foot">
        {plugin.kind === "claude" && <span className="muted">{plugin.state}</span>}
        {source && <Link to={source}>Open source →</Link>}
      </div>
    </article>
  );
}
