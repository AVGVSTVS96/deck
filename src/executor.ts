import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Config } from "./config";
import type { ExecutorApp, ExecutorOverview, ExecutorSource } from "./types";

type AccountRequirement = { scope: string; provider: string; cardinality: "one" | "many"; definition: { name: string } };

type InventoryApp = {
  id: string;
  slug: string;
  name: string;
  activeVersion?: string;
  requirements: { accounts?: Record<string, AccountRequirement> };
};

type Version = { id: string; createdAt: string };

type SourceFile = { path: string; content?: string };

type Linked = {
  requirement: string;
  account: { label: string };
  health?: { info?: { email?: string }; apps?: { check?: { status?: string } }[] };
};

export class Executor {
  private org: Promise<string> | null = null;

  constructor(private settings: NonNullable<Config["executor"]>) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = (await Bun.file(this.settings.token).text()).trim();

    const response = await fetch(`${this.settings.api}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "deck" },
      signal: AbortSignal.timeout(60_000),
    });

    const body = await response.json();

    if (!response.ok) throw new Error(body.message ?? `Executor answered ${response.status}`);

    return body;
  }

  private organization() {
    this.org ??= this.call<{ organization: string }>("/api/context").then((context) => context.organization);

    return this.org;
  }

  private async scoped<T>(path: string, init?: RequestInit) {
    return this.call<T>(`/api/organizations/${await this.organization()}${path}`, init);
  }

  private localDir(slug: string) {
    const dir = resolve(this.settings.apps, slug);

    if (!dir.startsWith(this.settings.apps + sep)) throw new Error(`Bad app name ${slug}`);

    return dir;
  }

  private async app(slug: string) {
    const { apps } = await this.scoped<{ apps: InventoryApp[] }>("/inventory");
    const app = apps.find((a) => a.slug === slug);

    if (!app) throw new Error(`No Executor app ${slug}`);

    return app;
  }

  async overview(): Promise<ExecutorOverview> {
    const [{ apps }, release] = await Promise.all([
      this.scoped<{ apps: InventoryApp[] }>("/inventory"),
      this.scoped<{ version: string }>("/framework/release").catch(() => null),
    ]);

    const rows: ExecutorApp[] = await Promise.all(
      apps.map(async (app) => {
        const [versions, linked] = await Promise.all([
          this.scoped<Version[]>(`/apps/${app.id}/versions`).catch(() => []),
          this.scoped<Linked[]>(`/apps/${app.id}/accounts/user`).catch(() => []),
        ]);

        const local = existsSync(join(this.localDir(app.slug), "index.ts"));

        const manifest = local
          ? await Bun.file(join(this.localDir(app.slug), "package.json"))
              .json()
              .catch(() => null)
          : null;

        return {
          id: app.id,
          slug: app.slug,
          name: app.name,
          activeVersion: app.activeVersion ?? null,
          deployedAt: versions.find((v) => v.id === app.activeVersion)?.createdAt ?? null,
          versions: versions.length,
          local,
          pinned: manifest?.dependencies?.apps ?? null,
          requirements: Object.keys(app.requirements.accounts ?? {}),
          accounts: linked.map((link) => ({
            requirement: link.requirement,
            label: link.health?.info?.email ?? link.account.label,
            health: link.health?.apps?.[0]?.check?.status ?? null,
          })),
        };
      }),
    );

    return { framework: release?.version ?? null, apps: rows, console: this.settings.api };
  }

  async source(slug: string): Promise<ExecutorSource> {
    const app = await this.app(slug);
    const deployed = await this.scoped<{ files: SourceFile[] }>(`/apps/${app.id}/source`);
    const dir = this.localDir(slug);
    const paths = [...new Set([...deployed.files.map((f) => f.path), "index.ts", "package.json"])].toSorted();

    return {
      files: await Promise.all(
        paths.map(async (path) => {
          const file = Bun.file(join(dir, path));

          return {
            path,
            deployed: deployed.files.find((f) => f.path === path)?.content ?? null,
            local: (await file.exists()) ? await file.text() : null,
          };
        }),
      ),
    };
  }

  async save(slug: string, path: string, content: string) {
    const dir = this.localDir(slug);
    const full = resolve(dir, path);

    if (!full.startsWith(dir + sep)) throw new Error(`Path outside the app: ${path}`);
    await mkdir(dirname(full), { recursive: true });
    await Bun.write(full, content);
  }

  async deploy(slug: string) {
    const app = await this.app(slug);
    const { files } = await this.source(slug);
    const upload = files.flatMap((f) => (f.local === null ? [] : [{ path: f.path, content: f.local }]));

    const result = await this.scoped<{ version?: { id: string } }>(`/apps/${app.id}/deploy`, {
      method: "POST",
      body: JSON.stringify({ files: upload }),
    });

    return { version: result.version?.id ?? null, files: upload.length };
  }

  async connect(slug: string, requirement: string) {
    const app = await this.app(slug);

    return this.scoped<{ url: string }>(`/apps/${app.id}/accounts/user/${encodeURIComponent(requirement)}/connections`, {
      method: "POST",
      body: "{}",
    });
  }
}
