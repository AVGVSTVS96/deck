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
  held: number;
  session: Window | null;
  week: Window | null;
  reasons: string[];
};

export type Agents = {
  apps: AppThreads[];
  pool: { accounts: PoolAccount[]; at: string } | null;
  tokenhub: string | null;
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
