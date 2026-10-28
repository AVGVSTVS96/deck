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
import { agentOf, appOf, labelOf, projectOf, rowOf, whoOf, type Names } from "./identity";
import type { Tracked, TrackedSession } from "./tracker";

const RANGES: Range[] = ["today", "yesterday", "7d", "30d", "6m"];
const GROUPS: GroupBy[] = ["agent", "session", "project", "model", "harness", "device", "account"];
const MEASURES: Measure[] = ["tokens", "api", "plan", "fiveHour", "week"];
const DIMENSIONS: Dimension[] = ["app", "harness", "model", "project", "device", "account"];
const COLORS = 7;

/** token-tracker's account for requests bound to no account, such as Codex or unpooled sessions. */
const NO_ACCOUNT = "none";

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

/** Field by field, the part of `whole` that is both `a` and `b`, assuming they overlap in proportion. Sums back to `a` over a full set of `b`, and the reverse. */
function overlap(a: Amount, b: Amount, whole: Amount) {
  const out = zero();

  for (const field of FIELDS) out[field] = whole[field] ? (a[field] * b[field]) / whole[field] : 0;

  return out;
}

/**
 * A session split into model × account parts. token-tracker gives the amount per model and per account exactly;
 * a part is their overlap. Limit points belong to their account and split across models by API $.
 */
function partsOf(session: TrackedSession, names: Names): Part[] {
  const who = whoOf(names, session);
  const agent = rowOf(who, session.key);
  const { amount } = session;
  const models = Object.keys(session.models).length ? Object.entries(session.models) : [["unknown", amount] as const];
  const amounts = new Map(Object.keys(session.accounts).length ? Object.entries(session.accounts) : [[NO_ACCOUNT, amount] as const]);
  const kinds = { fiveHour: 0, week: 0 };
  const points = new Map<string, { fiveHour: number; week: number }>();

  for (const { account, kind, points: charged } of session.limits) {
    const entry = points.get(account) ?? { fiveHour: 0, week: 0 };

    entry[kind] += charged;
    kinds[kind] += charged;
    points.set(account, entry);
  }

  const accounts = [...new Set([...amounts.keys(), ...points.keys()])];

  return models.flatMap(([model, modelAmount]) => {
    const api = amount.apiUsd ? ratio(modelAmount.apiUsd, amount.apiUsd) : ratio(modelAmount.tokens, amount.tokens);

    return accounts.map((account) => {
      const accountAmount = amounts.get(account) ?? zero();
      const charged = points.get(account) ?? { fiveHour: 0, week: 0 };

      return {
        session,
        who,
        agent,
        model,
        account,
        amount: overlap(modelAmount, accountAmount, amount),
        fiveHour: charged.fiveHour * api,
        week: charged.week * api,
        scale: [
          ratio(modelAmount.tokens, amount.tokens) * ratio(accountAmount.tokens, amount.tokens),
          ratio(modelAmount.apiUsd, amount.apiUsd) * ratio(accountAmount.apiUsd, amount.apiUsd),
          ratio(modelAmount.planUsd, amount.planUsd) * ratio(accountAmount.planUsd, amount.planUsd),
          ratio(charged.fiveHour, kinds.fiveHour) * api,
          ratio(charged.week, kinds.week) * api,
        ],
      };
    });
  });
}

const DIMENSION: Record<Dimension, (part: Part) => string> = {
  app: (part) => appOf(part.who),
  harness: (part) => part.session.harness,
  model: (part) => part.model,
  project: (part) => projectOf(part.session),
  device: (part) => part.session.deviceId,
  account: (part) => part.account,
};

/** What people call a dimension's value: account and device labels, "No account" for unbound requests. */
function nameOf(dimension: Dimension, id: string, labels: Labels) {
  if (dimension === "account") return id === NO_ACCOUNT ? "No account" : (labels.accounts[id] ?? id);

  return dimension === "device" ? (labels.devices[id] ?? id) : id;
}

type Description = { label: string; detail: string; who: Who | null };

const named =
  (dimension: Dimension) =>
  (part: Part, labels: Labels): Description => ({ label: nameOf(dimension, DIMENSION[dimension](part), labels), detail: "", who: null });

/** Each grouping's row key and how its row reads. */
const GROUPING: Record<GroupBy, { key: (part: Part) => string; describe: (part: Part, labels: Labels) => Description }> = {
  agent: { key: (part) => part.agent, describe: (part) => ({ ...labelOf(part.who), who: agentOf(part.who) }) },
  session: {
    key: (part) => `s:${part.session.key}`,
    describe: ({ session, who }) => ({
      label: session.title ?? labelOf(who).label,
      detail:
        who.kind === "action"
          ? `${who.repo} · ${labelOf(who).detail}`
          : [basename(projectOf(session)), session.harness, session.sessionId.slice(0, 8)].join(" · "),
      who,
    }),
  },
  project: {
    key: (part) => `p:${projectOf(part.session)}`,
    describe: ({ session }) => ({ label: basename(projectOf(session)) || projectOf(session), detail: projectOf(session), who: null }),
  },
  model: { key: (part) => `m:${part.model}`, describe: named("model") },
  harness: { key: (part) => `h:${part.session.harness}`, describe: named("harness") },
  device: { key: (part) => `d:${part.session.deviceId}`, describe: named("device") },
  account: { key: (part) => `a:${part.account}`, describe: named("account") },
};

const SERIES_COLUMN: Record<Measure, number> = { tokens: 1, api: 2, plan: 3, fiveHour: 4, week: 5 };

type Group = {
  key: string;
  label: string;
  detail: string;
  who: Who | null;
  amount: Amount;
  fiveHour: number;
  week: number;
  byAccount: Map<string, { apiUsd: number; fiveHour: number; week: number }>;
  sessions: Set<string>;
  sessionIds: Set<string>;
  lastActiveAt: number;
  series: number[];
};

function group(parts: Part[], by: GroupBy, measure: Measure, buckets: number, labels: Labels) {
  const groups = new Map<string, Group>();
  const column = SERIES_COLUMN[measure];

  for (const part of parts) {
    const key = GROUPING[by].key(part);
    let g = groups.get(key);

    if (!g) {
      g = {
        key,
        ...GROUPING[by].describe(part, labels),
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

    if (part.amount.tokens || part.fiveHour || part.week) {
      const account = g.byAccount.get(part.account) ?? { apiUsd: 0, fiveHour: 0, week: 0 };

      account.apiUsd += part.amount.apiUsd;
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

/** The browser's order too: a row with a blocked session reads blocked even while another works. */
const STRENGTH: Record<LiveState, number> = { blocked: 3, working: 2, idle: 1 };

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

type Input = { tracked: Tracked; names: Names; labels: Labels };

const partCache = new WeakMap<Tracked, { names: Names; parts: Part[] }>();

function allParts(tracked: Tracked, names: Names) {
  const cached = partCache.get(tracked);

  if (cached?.names === names) return cached.parts;
  const parts = tracked.sessions.flatMap((session) => partsOf(session, names));

  partCache.set(tracked, { names, parts });

  return parts;
}

/** The Usage view: totals, the ranked rows, the top-seven series and coverage for one query. Pure apart from its cache. */
export function usageView(
  { tracked, names, labels }: Input,
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
      filters.every(({ dimension, values }) => values.includes(DIMENSION[dimension](part))) &&
      (!query.within || part.agent === query.within),
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
  const shown = needle ? groups.filter((g) => `${g.label}\n${g.detail}`.toLowerCase().includes(needle)) : groups;
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
  const taken = new Set(top.flatMap((g) => (colors.has(g.key) ? [colors.get(g.key)] : [])));
  const free = Array.from({ length: COLORS }, (_, slot) => slot).filter((slot) => !taken.has(slot));

  for (const g of top) if (!colors.has(g.key)) colors.set(g.key, free.shift() ?? COLORS);
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
      const value = DIMENSION[dimension](part);
      const set = sessions.get(value) ?? new Set();

      set.add(part.session.key);
      sessions.set(value, set);
    }

    return [...sessions]
      .map(([id, set]) => ({ id, label: nameOf(dimension, id, labels), count: set.size }))
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
        .toSorted(([, a], [, b]) => b.apiUsd - a.apiUsd)
        .map(([account, p]): AccountPoints => ({ account, ...points(p) })),
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
    sources: { trackerAt: null, trackerError: null, devices: tracked.devices },
  };
}

/** Lights each row from the live sessions; cheap, so it runs on every request over a cached view. */
export function withLive(
  view: ReturnType<typeof usageView>,
  live: LiveSession[],
  tracker: { at: number | null; error: string | null },
): UsageView {
  return {
    ...view,
    rows: view.rows.map(({ sessionIds, ...row }) => ({ ...row, live: liveOf(row.key, sessionIds, live) })),
    sources: { ...view.sources, trackerAt: tracker.at, trackerError: tracker.error },
  };
}
