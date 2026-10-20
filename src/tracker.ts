import type { Amount, Range } from "./contract";
import { source, type Source } from "./sources";

type Kind = "fiveHour" | "week";

export type TrackedSession = {
  key: string;
  deviceId: string;
  harness: string;
  sessionId: string;
  project: string;
  repository: string | null;
  cwd: string;
  title: string | null;
  firstAt: number;
  lastAt: number;
  amount: Amount;
  models: Record<string, Amount>;
  /** Sparse: [bucket index, tokens, API $, plan $, five-hour points, week points]. */
  series: [number, number, number, number, number, number][];
  limits: { account: string; kind: Kind; points: number }[];
  /** The amount per account each request was bound to at its own time; "none" for unbound requests. */
  accounts: Record<string, Amount>;
};

/** token-tracker's GetSessionUsage answer for one range. */
export type Tracked = {
  generatedAt: number;
  period: { from: number; to: number; timezone: string };
  bucket: "1h" | "4h" | "1d" | "1w";
  buckets: number[];
  sessions: TrackedSession[];
  windows: { account: string; kind: Kind; resetsAt: number; since: number; sampled: number; assigned: number; unassigned: number }[];
  previous: Amount & { sessions: number };
  devices: { id: string; label: string; syncedAt: number | null }[];
};

const RANGES: Range[] = ["today", "7d", "30d", "6m"];
const EVERY_MS = 5 * 60_000;
const VIEWED_MS = 10 * 60_000;

async function read(url: string, range: Range, timezone: string): Promise<Tracked> {
  const request = { _tag: "Request", id: "0", tag: "GetSessionUsage", payload: { range, timezone }, headers: [] };

  const response = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: `${JSON.stringify(request)}\n`,
    signal: AbortSignal.timeout(120_000),
  });

  const exit = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((frame) => frame._tag === "Exit")?.exit;

  if (exit?._tag !== "Success") throw new Error(`token-tracker: ${exit?.cause ? JSON.stringify(exit.cause).slice(0, 300) : "no answer"}`);

  return exit.value;
}

/**
 * The only token-tracker client. Each range loads in the background: 7d every 5 minutes while a tab is open,
 * the others once asked for and again while asked for in the last 10 minutes. A request never waits on a warm range.
 */
export function tracker(url: string, timezone: string, watching: () => boolean) {
  const viewed = new Map<Range, number>([["7d", 0]]);

  const ranges = new Map<Range, Source<Tracked>>(
    RANGES.map((range) => [
      range,
      source({
        name: `token-tracker ${range}`,
        load: () => read(url, range, timezone),
        everyMs: EVERY_MS,
        active: () => (range === "7d" && watching()) || Date.now() - (viewed.get(range) ?? 0) < VIEWED_MS,
      }),
    ]),
  );

  return {
    async get(range: Range) {
      const data = ranges.get(range)!;

      viewed.set(range, Date.now());

      if (data.value === undefined) await data.ready();

      return { value: data.value, at: data.at || null, error: data.error };
    },
    on(change: () => void) {
      for (const data of ranges.values()) data.on(change);
    },
    /** The freshest loaded range, for naming live sessions. */
    latest: () => ranges.get("7d")!.value ?? ranges.get("today")!.value,
  };
}

export type Tracker = ReturnType<typeof tracker>;
