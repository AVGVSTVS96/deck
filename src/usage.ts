import { basename } from "node:path";
import type {
  AccountPoints,
  Amount,
  Dimension,
  GroupBy,
  LiveSession,
  LiveState,
  Measure,
  Range,
  Totals,
  UsageQuery,
  UsageRow,
  UsageView,
  Who,
} from "./contract";
import { appOf, labelOf, projectOf, rowOf, whoOf, type Names } from "./identity";
import type { Tracked, TrackedSession } from "./tracker";

const RANGES: Range[] = ["today", "7d", "30d", "6m"];
const GROUPS: GroupBy[] = ["agent", "session", "project", "model", "harness", "device", "account"];
const MEASURES: Measure[] = ["tokens", "api", "plan", "fiveHour", "week"];
const DIMENSIONS: Dimension[] = ["app", "harness", "model", "project", "device", "account"];
const COLORS = 7;

/** One session's share of one model on one account. Parts of a session sum back to the session exactly. */
type Part = {
  session: TrackedSession;
  who: Who;
  agent: string;
  model: string;
  account: string;
  amount: Amount;
  fiveHour: number;
  week: number;
  /** Multipliers from the session's series columns [tokens, api, plan, fiveHour, week] to this part's. */
  scale: [number, number, number, number, number];
};

export type Labels = { accounts: Record<string, string>; devices: Record<string, string> };

const zero = (): Amount => ({
  tokens: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  requests: 0,
  apiUsd: 0,
  planUsd: 0,
  unpricedTokens: 0,
});

const FIELDS = [
  "tokens",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "requests",
  "apiUsd",
  "planUsd",
  "unpricedTokens",
] satisfies (keyof Amount)[];

function add(into: Amount, amount: Amount, by = 1) {
  for (const field of FIELDS) into[field] += amount[field] * by;

  return into;
}

const ratio = (part: number, whole: number) => (whole ? part / whole : 0);

function partsOf(session: TrackedSession, names: Names): Part[] {
  const who = whoOf(names, session);
  const agent = rowOf(who, session.key);
  const models = Object.keys(session.models).length ? Object.entries(session.models) : [["unknown", session.amount] as const];

  const kinds = { fiveHour: 0, week: 0 };
  const accounts = new Map<string, { fiveHour: number; week: number }>();

  for (const { account, kind, points } of session.limits) {
    const entry = accounts.get(account) ?? { fiveHour: 0, week: 0 };

    entry[kind] += points;
    kinds[kind] += points;
    accounts.set(account, entry);
  }

  const total = kinds.fiveHour + kinds.week;
  const split = accounts.size ? [...accounts] : [["", { fiveHour: 0, week: 0 }] as const];

  return models.flatMap(([model, modelAmount]) => {
    const api = session.amount.apiUsd ? ratio(modelAmount.apiUsd, session.amount.apiUsd) : ratio(modelAmount.tokens, session.amount.tokens);

    return split.map(([account, points]) => {
      const weight = accounts.size ? ratio(points.fiveHour + points.week, total) : 1;

      return {
        session,
        who,
        agent,
        model,
        account,
        amount: add(zero(), modelAmount, weight),
        fiveHour: points.fiveHour * api,
        week: points.week * api,
        scale: [
          ratio(modelAmount.tokens, session.amount.tokens) * weight,
          ratio(modelAmount.apiUsd, session.amount.apiUsd) * weight,
          ratio(modelAmount.planUsd, session.amount.planUsd) * weight,
          ratio(points.fiveHour, kinds.fiveHour) * api,
          ratio(points.week, kinds.week) * api,
        ],
      };
    });
  });
}

const dimensionOf = (part: Part, dimension: Dimension): string => {
  switch (dimension) {
    case "app":
      return appOf(part.who);
    case "harness":
      return part.session.harness;
    case "model":
      return part.model;
    case "project":
      return projectOf(part.session);
    case "device":
      return part.session.deviceId;
    case "account":
      return part.account;
  }
};

function keyOf(part: Part, by: GroupBy) {
  switch (by) {
    case "agent":
      return part.agent;
    case "session":
      return `s:${part.session.key}`;
    case "project":
      return `p:${projectOf(part.session)}`;
    case "model":
      return `m:${part.model}`;
    case "harness":
      return `h:${part.session.harness}`;
    case "device":
      return `d:${part.session.deviceId}`;
    case "account":
      return `a:${part.account}`;
  }
}

type Description = { label: string; detail: string; who: Who | null };

function describe(part: Part, by: GroupBy, labels: Labels): Description {
  const { session } = part;

  switch (by) {
    case "agent":
      return { ...labelOf(part.who), who: part.who };
    case "session":
      return {
        label: session.title ?? labelOf(part.who).label,
        detail: [basename(projectOf(session)), session.harness, session.sessionId.slice(0, 8)].join(" · "),
        who: part.who,
      };
    case "project":
      return { label: basename(projectOf(session)) || projectOf(session), detail: projectOf(session), who: null };
    case "model":
      return { label: part.model, detail: "", who: null };
    case "harness":
      return { label: session.harness, detail: "", who: null };
    case "device":
      return { label: labels.devices[session.deviceId] ?? session.deviceId, detail: "", who: null };
    case "account":
      return { label: part.account ? (labels.accounts[part.account] ?? part.account) : "No account", detail: "", who: null };
  }
}

const SERIES_COLUMN: Record<Measure, number> = { tokens: 1, api: 2, plan: 3, fiveHour: 4, week: 5 };

type Group = {
  key: string;
  label: string;
  detail: string;
  who: Who | null;
  amount: Amount;
  fiveHour: number;
  week: number;
  byAccount: Map<string, { fiveHour: number; week: number }>;
  sessions: Set<string>;
  sessionIds: Set<string>;
  lastActiveAt: number;
  series: number[];
};

function group(parts: Part[], by: GroupBy, measure: Measure, buckets: number, labels: Labels) {
  const groups = new Map<string, Group>();
  const column = SERIES_COLUMN[measure];

  for (const part of parts) {
    const key = keyOf(part, by);
    let g = groups.get(key);

    if (!g) {
      g = {
        key,
        ...describe(part, by, labels),
        amount: zero(),
        fiveHour: 0,
        week: 0,
        byAccount: new Map(),
        sessions: new Set(),
        sessionIds: new Set(),
        lastActiveAt: 0,
        series: Array.from({ length: buckets }, () => 0),
      };
      groups.set(key, g);
    }

    add(g.amount, part.amount);
    g.fiveHour += part.fiveHour;
    g.week += part.week;
    g.sessions.add(part.session.key);
    g.sessionIds.add(part.session.sessionId);
    g.lastActiveAt = Math.max(g.lastActiveAt, part.session.lastAt);

    if (part.fiveHour || part.week) {
      const account = g.byAccount.get(part.account) ?? { fiveHour: 0, week: 0 };

      account.fiveHour += part.fiveHour;
      account.week += part.week;
      g.byAccount.set(part.account, account);
    }

    if (buckets) for (const row of part.session.series) g.series[row[0]] += row[column] * part.scale[column - 1];
  }

  return [...groups.values()];
}

const valueOf = (g: Pick<Group, "amount" | "fiveHour" | "week">, measure: Measure) =>
  measure === "tokens"
    ? g.amount.tokens
    : measure === "api"
      ? g.amount.apiUsd
      : measure === "plan"
        ? g.amount.planUsd
        : measure === "fiveHour"
          ? g.fiveHour
          : g.week;

const STRENGTH: Record<LiveState, number> = { working: 3, blocked: 2, idle: 1 };

function liveOf(key: string, sessionIds: Set<string>, live: LiveSession[]): LiveState | null {
  let best: LiveState | null = null;

  for (const session of live) {
    if (!sessionIds.has(session.id) && session.row !== key) continue;

    if (!best || STRENGTH[session.state] > STRENGTH[best]) best = session.state;
  }

  return best;
}

export function parseQuery(params: URLSearchParams): UsageQuery {
  const pick = <T extends string>(name: string, options: T[], fallback: T) => {
    const value = params.get(name);

    return options.find((option) => option === value) ?? fallback;
  };

  const where: UsageQuery["where"] = {};

  for (const dimension of DIMENSIONS) {
    const values = params.get(`w.${dimension}`)?.split(",").filter(Boolean);

    if (values?.length) where[dimension] = values.toSorted();
  }

  const limit = Number(params.get("limit"));

  return {
    range: pick("range", RANGES, "7d"),
    by: pick("by", GROUPS, "agent"),
    measure: pick("measure", MEASURES, "api"),
    where,
    search: (params.get("q") ?? "").trim(),
    limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
    within: params.get("within") || null,
  };
}

type Input = { tracked: Tracked; names: Names; labels: Labels; trackerAt: number | null; trackerError: string | null };

const partCache = new WeakMap<Tracked, { names: Names; parts: Part[] }>();

function allParts(tracked: Tracked, names: Names) {
  const cached = partCache.get(tracked);

  if (cached?.names === names) return cached.parts;
  const parts = tracked.sessions.flatMap((session) => partsOf(session, names));

  partCache.set(tracked, { names, parts });

  return parts;
}

function keysOf(part: Part) {
  return GROUPS.map((by) => keyOf(part, by));
}

/** The Usage view: totals, the ranked rows, the top-seven series and coverage for one query. Pure apart from its cache. */
export function usageView(
  { tracked, names, labels, trackerAt, trackerError }: Input,
  query: UsageQuery,
): Omit<UsageView, "rows"> & {
  rows: (UsageRow & { sessionIds: Set<string> })[];
} {
  const all = allParts(tracked, names);
  const buckets = tracked.buckets.length;

  const filters = DIMENSIONS.flatMap((dimension) => {
    const values = query.where[dimension];

    return values?.length ? [{ dimension, values }] : [];
  });

  const parts = all.filter(
    (part) =>
      filters.every(({ dimension, values }) => values.includes(dimensionOf(part, dimension))) &&
      (!query.within || keysOf(part).includes(query.within)),
  );

  const colors = new Map(
    group(all, query.by, "api", 0, labels)
      .toSorted((a, b) => b.amount.apiUsd - a.amount.apiUsd)
      .slice(0, COLORS)
      .map((g, i) => [g.key, i]),
  );

  const groups = group(parts, query.by, query.measure, buckets, labels).toSorted(
    (a, b) => valueOf(b, query.measure) - valueOf(a, query.measure) || b.amount.apiUsd - a.amount.apiUsd,
  );

  const needle = query.search.toLowerCase();
  const shown = needle ? groups.filter((g) => `${g.label}\n${g.detail}\n${g.key}`.toLowerCase().includes(needle)) : groups;
  const limits = tracked.windows.length > 0;

  const points = (g: { fiveHour: number; week: number }) =>
    limits ? { fiveHour: g.fiveHour, week: g.week } : { fiveHour: null, week: null };

  const totalAmount = parts.reduce((sum, part) => add(sum, part.amount), zero());

  const totals: Totals = {
    ...totalAmount,
    sessions: new Set(parts.map((part) => part.session.key)).size,
    cacheHitRate: ratio(totalAmount.cacheRead, totalAmount.input + totalAmount.cacheRead + totalAmount.cacheWrite),
    points: points({
      fiveHour: parts.reduce((sum, part) => sum + part.fiveHour, 0),
      week: parts.reduce((sum, part) => sum + part.week, 0),
    }),
  };

  const { sessions: previousSessions, ...previousAmount } = tracked.previous;

  const previous: Totals | null =
    filters.length || query.within
      ? null
      : {
          ...previousAmount,
          sessions: previousSessions,
          cacheHitRate: ratio(previousAmount.cacheRead, previousAmount.input + previousAmount.cacheRead + previousAmount.cacheWrite),
          points: { fiveHour: null, week: null },
        };

  const top = groups.slice(0, COLORS);
  const rest = groups.slice(COLORS);

  const series = [
    ...top.map((g) => ({ key: g.key, label: g.label, color: colors.get(g.key) ?? COLORS, values: g.series })),
    ...(rest.length
      ? [
          {
            key: "rest",
            label: "Everything else",
            color: COLORS,
            values: rest.reduce((sum, g) => sum.map((v, i) => v + g.series[i]), Array(buckets).fill(0)),
          },
        ]
      : []),
  ];

  const unassigned = new Map<string, { account: string; kind: "fiveHour" | "week"; points: number }>();

  for (const w of tracked.windows) {
    const key = `${w.account}\n${w.kind}`;
    const entry = unassigned.get(key) ?? { account: w.account, kind: w.kind, points: 0 };

    entry.points += w.unassigned;
    unassigned.set(key, entry);
  }

  const facet = (dimension: Dimension) => {
    const sessions = new Map<string, Set<string>>();

    for (const part of all) {
      const value = dimensionOf(part, dimension);
      const set = sessions.get(value) ?? new Set();

      set.add(part.session.key);
      sessions.set(value, set);
    }

    const label = (id: string) =>
      dimension === "account"
        ? id
          ? (labels.accounts[id] ?? id)
          : "No account"
        : dimension === "device"
          ? (labels.devices[id] ?? id)
          : id;

    return [...sessions]
      .map(([id, set]) => ({ id, label: label(id), count: set.size }))
      .toSorted((a, b) => b.count - a.count)
      .slice(0, 100);
  };

  const facets: UsageView["facets"] = {
    app: facet("app"),
    harness: facet("harness"),
    model: facet("model"),
    project: facet("project"),
    device: facet("device"),
    account: facet("account"),
  };

  const sinces = tracked.windows.map((w) => w.since);

  return {
    query,
    period: tracked.period,
    totals,
    previous,
    buckets: tracked.buckets.map((at) => ({ at, size: tracked.bucket })),
    series,
    rows: shown.slice(0, query.limit).map((g) => ({
      key: g.key,
      label: g.label,
      detail: g.detail,
      who: g.who,
      color: colors.get(g.key) ?? COLORS,
      amount: g.amount,
      points: points(g),
      byAccount: [...g.byAccount]
        .map(([account, p]): AccountPoints => ({ account, ...p }))
        .toSorted((a, b) => (b.week ?? 0) - (a.week ?? 0)),
      sessions: g.sessions.size,
      lastActiveAt: g.lastActiveAt,
      series: g.series,
      live: null,
      sessionIds: g.sessionIds,
    })),
    rowCount: shown.length,
    coverage: {
      namedApiUsd: parts.reduce((sum, part) => sum + (part.who.kind === "project" ? 0 : part.amount.apiUsd), 0),
      totalApiUsd: totalAmount.apiUsd,
      limitsSince: sinces.length ? Math.min(...sinces) : null,
      unassigned: [...unassigned.values()].filter((u) => u.points > 0),
    },
    facets,
    sources: { trackerAt, trackerError, devices: tracked.devices },
  };
}

/** Lights each row from the live sessions; cheap, so it runs on every request over a cached view. */
export function withLive(view: ReturnType<typeof usageView>, live: LiveSession[]): UsageView {
  return { ...view, rows: view.rows.map(({ sessionIds, ...row }) => ({ ...row, live: liveOf(row.key, sessionIds, live) })) };
}
