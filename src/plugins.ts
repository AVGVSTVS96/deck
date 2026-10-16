import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Config } from "./config";
import type { Plugin } from "./types";

type Installed = { plugins: Record<string, { scope: string; version: string; installPath: string }[]> };

type Manifest = { name?: string; version?: string; description?: string };

type Settings = { enabledPlugins?: Record<string, boolean> };

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  const file = Bun.file(path);

  return (await file.exists()) ? file.json() : fallback;
};

function sourceOf(config: Config, path: string) {
  const repo = config.repos.toSorted((a, b) => b.path.length - a.path.length).find((r) => path.startsWith(r.path + "/"));

  return repo ? { repo: repo.id, path: relative(repo.path, path) } : null;
}

export async function plugins(config: Config): Promise<Plugin[]> {
  const core = join(config.hex, ".hex");

  const [installed, settings] = await Promise.all([
    readJson<Installed>(join(config.claude, "plugins", "installed_plugins.json"), { plugins: {} }),
    readJson<Settings>(join(config.claude, "settings.json"), {}),
  ]);

  const enabled = settings.enabledPlugins ?? {};
  const entries = Object.entries(installed.plugins);

  const channels = await Promise.all(
    entries
      .filter(([id]) => id.endsWith("@hex"))
      .map(async ([id, [install]]): Promise<Plugin> => {
        const name = id.split("@")[0];
        const dir = join(core, "channels", "external_plugins", name);
        const manifest = await readJson<Manifest>(join(dir, ".claude-plugin", "plugin.json"), {});
        const state = join(config.hex, "state", name);

        return {
          id,
          name,
          kind: "channel",
          version: manifest.version ?? install?.version ?? null,
          description: manifest.description ?? "",
          enabled: null,
          scope: null,
          source: existsSync(dir) ? sourceOf(config, dir) : null,
          state: existsSync(join(state, "hub.sock")) ? "connected" : existsSync(state) ? "set up" : "installed",
        };
      }),
  );

  const modsDir = join(core, "mods");

  const mods = (await readdir(modsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry): Plugin => ({
      id: `mod:${entry.name}`,
      name: entry.name,
      kind: "mod",
      version: null,
      description: "",
      enabled: null,
      scope: null,
      source: sourceOf(config, join(modsDir, entry.name)),
      state: null,
    }));

  const claude = await Promise.all(
    entries
      .filter(([id]) => !id.endsWith("@hex"))
      .map(async ([id, [install]]): Promise<Plugin> => {
        const manifest = await readJson<Manifest>(join(install?.installPath ?? "", ".claude-plugin", "plugin.json"), {});

        return {
          id,
          name: id.split("@")[0],
          kind: "claude",
          version: install?.version ?? null,
          description: manifest.description ?? "",
          enabled: enabled[id] === true,
          scope: install?.scope ?? null,
          source: null,
          state: id.split("@")[1] ?? null,
        };
      }),
  );

  return [...channels, ...mods, ...claude];
}

export async function setPlugin(config: Config, id: string, on: boolean) {
  const proc = Bun.spawn(["claude", "plugin", on ? "enable" : "disable", id, "--scope", "user", "--json"], {
    env: config.claude === join(homedir(), ".claude") ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: config.claude },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  if (code !== 0) throw new Error(err.trim() || out.trim() || `claude plugin ${on ? "enable" : "disable"} failed`);

  return { id, enabled: on };
}
