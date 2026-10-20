export type Range = "today" | "7d" | "30d" | "6m";

export type GroupBy = "agent" | "session" | "project" | "model" | "harness" | "device" | "account";

export type Measure = "tokens" | "api" | "plan" | "fiveHour" | "week";

export type Dimension = "app" | "harness" | "model" | "project" | "device" | "account";

export type UsageQuery = {
  range: Range;
  by: GroupBy;
  measure: Measure;
  where: Partial<Record<Dimension, string[]>>;
  search: string;
  limit: number;
  /** Only rows under this agent row key, so a row drills into its sessions. */
  within: string | null;
};

export type Amount = {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  apiUsd: number;
  planUsd: number;
  unpricedTokens: number;
};

/** Percentage points of account limits, summed over accounts and windows. Null: nothing to estimate from. */
export type Points = { fiveHour: number | null; week: number | null };

export type AccountPoints = { account: string } & Points;

/** Who a usage row belongs to. Threads are keyed by app and thread id; a name alone never joins. */
export type Who =
  | { kind: "thread"; app: string; thread: string; name: string; href: string | null }
  | { kind: "job"; owner: string | null; unit: string }
  | { kind: "session"; title: string; project: string; href: string | null }
  | { kind: "project"; project: string };

export type LiveState = "working" | "idle" | "blocked";

export type UsageRow = {
  key: string;
  label: string;
  detail: string;
  who: Who | null;
  /** Categorical slot 0 to 6 for the top rows by API value in the unfiltered range, 7 for the rest. */
  color: number;
  amount: Amount;
  points: Points;
  byAccount: AccountPoints[];
  sessions: number;
  lastActiveAt: number;
  /** The chosen measure per bucket of `UsageView.buckets`. */
  series: number[];
  live: LiveState | null;
};

export type Totals = Amount & { sessions: number; cacheHitRate: number; points: Points };

export type Bucket = { at: number; size: "1h" | "4h" | "1d" | "1w" };

export type UsageView = {
  query: UsageQuery;
  period: { from: number; to: number; timezone: string };
  totals: Totals;
  previous: Totals | null;
  buckets: Bucket[];
  /** Top seven groups plus the rest, in the chosen measure, one value per bucket. */
  series: { key: string; label: string; color: number; values: number[] }[];
  rows: UsageRow[];
  rowCount: number;
  coverage: {
    namedApiUsd: number;
    totalApiUsd: number;
    limitsSince: number | null;
    unassigned: { account: string; kind: "fiveHour" | "week"; points: number }[];
  };
  facets: Record<Dimension, { id: string; label: string; count: number }[]>;
  sources: { trackerAt: number | null; trackerError: string | null; devices: { id: string; label: string; syncedAt: number | null }[] };
};

export type LimitWindow = {
  used: number | null;
  cutoff: number;
  resetsAt: number | null;
  sampledAt: number | null;
  /** Share of the window already passed, 0 to 1, so pace reads at a glance. */
  elapsed: number | null;
};

export type Account = {
  id: string;
  label: string;
  plan: string;
  since: number | null;
  signInUntil: number | null;
  rank: number | null;
  standing: "next" | "open" | "tight" | "limited" | "signed-out";
  reasons: string[];
  fiveHour: LimitWindow;
  week: LimitWindow;
  working: number;
  idle: number;
  heldResets: { kind: string; left: number; expiresAt: number | null }[];
  atLimit: { available: boolean; nextAt: number | null } | null;
};

export type Policy = { sessionCutoff: number; weeklyCutoff: number; agentsPerAccount: number };

export type Pool = {
  next: string | null;
  decision: string;
  order: string[];
  policy: Policy;
  revision: string;
  notes: string[];
};

export type PolicyResult = { pool: Pool; saved: boolean; conflict: boolean };

export type Connection = {
  id: string;
  email: string;
  status: "starting" | "authorize" | "finishing" | "connected" | "failed";
  url: string | null;
};

export type MoveCause = "limit" | "over" | "early" | "restart" | "start";

export type Move = { at: number; session: string; label: string | null; from: string | null; to: string; cause: MoveCause };

export type AccountsView = {
  history: { account: string; kind: "fiveHour" | "week"; points: [at: number, used: number][] }[];
  moves: Move[];
  hosts: { host: string; seenAt: number | null; seats: number }[];
};

export type LiveSession = {
  id: string;
  label: string;
  /** The `UsageRow.key` this session ranks under with `by: "agent"`. */
  row: string;
  app: string | null;
  state: LiveState;
  account: string | null;
  host: string;
  cwd: string;
  since: number;
};

export type LiveKey = `s:${string}` | `a:${string}` | "pool" | `app:${string}`;

export type LiveValue = LiveSession | Account | Pool | { connected: boolean };

/**
 * One stream per tab. `snapshot` opens every connection; `patch` carries only keys whose value changed
 * (null removes one); `stale` names fetched resources to refetch, such as "usage" or "repo:hex".
 */
export type ServerEvent =
  | { type: "snapshot"; live: Record<string, LiveValue> }
  | { type: "patch"; live: Record<string, LiveValue | null> }
  | { type: "stale"; tags: string[] };
