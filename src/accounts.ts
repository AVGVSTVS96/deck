type RoutingWindow = { usedPercentage: number; resetsAt: number | null; sampledAt: number; effectiveThreshold: number };

type RoutingAccount = {
  id: string;
  label: string;
  tier: string;
  needsReauth: boolean;
  eligible: boolean;
  reasons: string[];
  heldSessions: number;
  waitingSessions: number;
  session: RoutingWindow | null;
  week: RoutingWindow | null;
  usageAgeMs: number | null;
  usageStale: boolean;
};

type Routing = {
  at: string;
  revision: string;
  config: Settings;
  selectedAccountId: string | null;
  accounts: RoutingAccount[];
};

type StatusAccount = {
  id: string;
  signInExpiresAt?: number;
  plan?: { since?: number };
  resets?: {
    held: { kind: HeldReset["kind"]; left: number; expiresAt: number | null; paused: boolean }[];
    atLimit: { available: boolean; nextAt: number | null } | null;
  };
};

export type Settings = { sessionCutoff: number; weeklyCutoff: number; agentsPerAccount: number };

export type Quota = { used: number; resetsAt: number | null; cutoff: number };

export type HeldReset = { kind: "session" | "weekly" | "fable" | "full"; left: number; useBy: number | null; paused: boolean };

export type Account = {
  id: string;
  email: string;
  tier: string;
  since: number | null;
  needsReauth: boolean;
  eligible: boolean;
  next: boolean;
  reasons: string[];
  working: number;
  idle: number;
  fiveHour: Quota | null;
  week: Quota | null;
  readAt: number | null;
  stale: boolean;
  signInUntil: number | null;
  held: HeldReset[];
  limitReset: { available: boolean; nextAt: number | null } | null;
};

export type Accounts = { at: string; revision: string; settings: Settings; accounts: Account[] };

export type Connection = {
  id: string;
  email: string;
  status: "starting" | "authorize" | "finishing" | "connected" | "failed";
  url: string | null;
};

type Sent =
  | { operation: "preview" | "save"; model: "opus"; config: Settings; expectedRevision: string }
  | { email: string }
  | { code: string };

type Failure = { error?: string | { message: string } };

const quota = (window: RoutingWindow | null): Quota | null =>
  window && { used: window.usedPercentage, resetsAt: window.resetsAt, cutoff: window.effectiveThreshold };

export class Tokenhub {
  readonly origin: string;

  constructor(url: string) {
    this.origin = new URL(url).origin;
  }

  async accounts(): Promise<Accounts> {
    const [routing, status] = await Promise.all([
      this.call<Routing>("/api/pool/routing?model=opus"),
      this.call<{ accounts: StatusAccount[] }>("/api/pool/status"),
    ]);

    return this.merge(routing, status.accounts);
  }

  async settings(operation: "preview" | "save", config: Settings, expectedRevision: string): Promise<Accounts> {
    const [routing, status] = await Promise.all([
      this.call<Routing>("/api/pool/routing", { operation, model: "opus", config, expectedRevision }),
      this.call<{ accounts: StatusAccount[] }>("/api/pool/status"),
    ]);

    return this.merge(routing, status.accounts);
  }

  connect(email: string) {
    return this.call<Connection>("/api/pool/connect/start", { email });
  }

  connection(id: string, code?: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unknown sign-in.");

    return code === undefined
      ? this.call<Connection>(`/api/pool/connect/status/${id}`)
      : this.call<Connection>(`/api/pool/connect/code/${id}`, { code });
  }

  private merge(routing: Routing, status: StatusAccount[]): Accounts {
    const now = Date.now();
    const extra = new Map(status.map((a) => [a.id, a]));

    return {
      at: routing.at,
      revision: routing.revision,
      settings: routing.config,
      accounts: routing.accounts.map((a) => {
        const more = extra.get(a.id);

        return {
          id: a.id,
          email: a.label,
          tier: a.tier,
          since: more?.plan?.since ?? null,
          needsReauth: a.needsReauth,
          eligible: a.eligible,
          next: a.id === routing.selectedAccountId,
          reasons: a.reasons,
          working: a.heldSessions,
          idle: a.waitingSessions,
          fiveHour: quota(a.session),
          week: quota(a.week),
          readAt: a.usageAgeMs === null ? null : Date.parse(routing.at) - a.usageAgeMs,
          stale: a.usageStale,
          signInUntil: more?.signInExpiresAt ?? null,
          held: (more?.resets?.held ?? [])
            .filter((r) => r.left > 0 && (r.expiresAt ?? Infinity) > now)
            .map((r) => ({ kind: r.kind, left: r.left, useBy: r.expiresAt, paused: r.paused })),
          limitReset: more?.resets?.atLimit ?? null,
        };
      }),
    };
  }

  private async call<T>(path: string, body?: Sent): Promise<T> {
    const init: RequestInit = { signal: AbortSignal.timeout(20_000) };

    if (body) {
      init.method = "POST";
      init.headers = { "content-type": "application/json", origin: this.origin };
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.origin}${path}`, init).catch(() => null);

    if (!response) throw new Error("tokenhub didn't answer.");
    const result = await response.json().catch(() => null);

    if (!response.ok) {
      const error: Failure["error"] = result?.error;
      const message = error instanceof Object ? error.message : error;

      throw new Error(message ?? `tokenhub answered ${response.status}.`);
    }

    return result;
  }
}
