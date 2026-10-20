import type { GitStatus } from "@pierre/trees";

export type Workspace = {
  id: string;
  repo: string;
  name: string | null;
  path: string;
  branch: string | null;
  base: string | null;
};

export type RepoSummary = {
  id: string;
  name: string;
  about: string;
  path: string;
  review: boolean;
  branch: string | null;
  unpushed: number | null;
  workspaces: Workspace[];
};

export type Change = { path: string; status: GitStatus; added: number; removed: number };

export type Changes = {
  files: Change[];
  dirty: boolean;
  ahead: number;
  behind: number;
};

export type FileBody = {
  path: string;
  contents: string | null;
  original: string | null;
  binary: boolean;
  tooLarge: boolean;
};

export type Draft = { name: string; target: { repo: string; path: string } | null };

export type Thread = {
  id: string;
  name: string;
  session: string | null;
  cwd: string | null;
  running: boolean;
  working: boolean | null;
  account: string | null;
  link: string | null;
};

export type AppThreads = { app: string; connected: boolean; threads: Thread[] };

export type Window = { used: number; resetsAt: number; threshold: number | null };

export type PoolAccount = {
  id: string;
  label: string;
  tier: string;
  needsReauth: boolean;
  eligible: boolean;
  selected: boolean;
  rank: number | null;
  standing: "open" | "tight" | "blocked";
  held: number;
  idle: number;
  room: { left: number; sessions: number; each: number | null; minimum: number } | null;
  pace: number;
  seats: Seat[];
  session: Window | null;
  week: Window | null;
  sampledAt: number | null;
  stale: boolean;
  reasons: string[];
};

export type Seat = { session: string; name: string | null; host: string; working: boolean };

export type MoveCause = "limit" | "over" | "early" | "restart";

export type Move = { at: string; session: string; name: string | null; from: string; to: string; cause: MoveCause };

export type Start = { at: string; account: string };

export type Host = { host: string; seenAt: number | null; seats: number };

export type Policy = { sessionCutoff: number; weeklyCutoff: number; agentsPerAccount: number };

export type PolicyCheck = {
  next: string | null;
  order: { label: string; standing: PoolAccount["standing"] }[];
  revision: string;
  saved: boolean;
};

export type Pool = {
  at: string;
  accounts: PoolAccount[];
  policy: Policy;
  revision: string;
  notes: string[];
  moves: Move[];
  starts: Start[];
  hosts: Host[];
};

export type Agents = {
  apps: AppThreads[];
  pool: Pool | null;
  tokenhub: string | null;
};

export type Surface = { name: string; tokens: number; api: number; plan: number; sessions: number };

export type Workflow = {
  repo: string;
  url: string;
  name: string;
  kind: string;
  telemetry: string;
  run: { result: string; url: string } | null;
  missing: string | null;
  runs: number;
  tokens: number | null;
  api: number | null;
  models: string[];
};

export type AgentUsage = {
  at: string;
  surfaces: Surface[];
  blocked: { id: string; name: string; surface: string; since: string }[];
  github: Workflow[];
  coverage: { name: string; status: string; detail: string }[];
};

export type Plugin = {
  id: string;
  name: string;
  kind: "channel" | "mod" | "claude";
  version: string | null;
  description: string;
  enabled: boolean | null;
  scope: string | null;
  source: { repo: string; path: string } | null;
  state: string | null;
};

export type ExecutorApp = {
  id: string;
  slug: string;
  name: string;
  activeVersion: string | null;
  deployedAt: string | null;
  versions: number;
  local: boolean;
  pinned: string | null;
  requirements: string[];
  accounts: { requirement: string; label: string; health: string | null }[];
};

export type ExecutorOverview = {
  framework: string | null;
  apps: ExecutorApp[];
  console: string;
};

export type ExecutorSource = {
  files: { path: string; deployed: string | null; local: string | null }[];
};
