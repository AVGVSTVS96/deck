import { QueryClient, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { Account, LiveSession, LiveValue, Pool, ServerEvent } from "../src/contract";

export class ApiError extends Error {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const body = await response.json();

  if (!response.ok) throw new ApiError(body.error ?? `Request failed (${response.status})`);

  return body;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Body = Record<string, Json>;

export const send = <T>(path: string, method: string, body?: Body) =>
  api<T>(path, body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method });

export const putText = (path: string, text: string) => api<{ ok: true }>(path, { method: "PUT", body: text });

export const queries = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 } },
});

/**
 * A cached GET keyed by its path. It stays fresh until the server names one of its tags in a `stale` event;
 * a tag ending in ":" matches every tag with that prefix, so "repo:" follows all repos.
 */
export function useApi<T>(path: string | null, ...tags: string[]) {
  const query = useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path!),
    enabled: path !== null,
    meta: { tags },
  });

  return {
    data: query.data ?? null,
    error: query.error ? query.error.message : null,
    fetching: query.isFetching,
    reload: async () => void (await query.refetch()),
  };
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { tags: string[] };
  }
}

const tagged = (tags: string[], tag: string) => tags.some((t) => t === tag || (t.endsWith(":") && tag.startsWith(t)));

type LiveOf<K extends string> = K extends `s:${string}`
  ? LiveSession
  : K extends `a:${string}`
    ? Account
    : K extends "pool"
      ? Pool
      : { connected: boolean };

let live: Extract<ServerEvent, { type: "snapshot" }>["live"] = {};
let connected = false;
const liveListeners = new Set<() => void>();
const lists = new Map<string, { from: Record<string, LiveValue>; list: [string, LiveValue][] }>();

const subscribe = (listener: () => void) => {
  if (!source) connect();
  liveListeners.add(listener);

  return () => liveListeners.delete(listener);
};

const publish = () => {
  for (const listener of liveListeners) listener();
};

function apply(event: ServerEvent) {
  if (event.type === "stale") {
    for (const tag of event.tags) void queries.invalidateQueries({ predicate: (q) => tagged(q.meta?.tags ?? [], tag) });

    return;
  }

  if (event.type === "snapshot") live = event.live;
  else {
    live = { ...live };

    for (const [key, value] of Object.entries(event.live)) {
      if (value === null) delete live[key];
      else live[key] = value;
    }
  }

  publish();
}

let source: EventSource | null = null;

function connect() {
  let opened = false;

  source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    if (opened) void queries.invalidateQueries();

    opened = true;
    connected = true;
    publish();
  });
  source.addEventListener("error", () => {
    connected = false;
    publish();
  });
  source.addEventListener("message", (message) => apply(JSON.parse(message.data)));
}

export function useLive<K extends string>(key: K): LiveOf<K> | undefined {
  // SAFETY: the key prefix decides the value's shape on the server (contract.ts LiveKey), so it holds here.
  return useSyncExternalStore(subscribe, () => live[key]) as LiveOf<K> | undefined;
}

/** Every live value whose key starts with the prefix, as [key without the prefix, value], in the server's order. */
export function useLiveList<P extends "s:" | "a:" | "app:">(prefix: P): [string, LiveOf<`${P}x`>][] {
  const list = useSyncExternalStore(subscribe, () => {
    const cached = lists.get(prefix);

    if (cached?.from === live) return cached.list;

    const next = Object.keys(live)
      .filter((k) => k.startsWith(prefix))
      .map((k): [string, LiveValue] => [k.slice(prefix.length), live[k]]);

    lists.set(prefix, { from: live, list: next });

    return next;
  });

  // SAFETY: as in useLive, the prefix decides the shape.
  return list as [string, LiveOf<`${P}x`>][];
}

export const useConnected = () => useSyncExternalStore(subscribe, () => connected);

const routeListeners = new Set<() => void>();

window.addEventListener("popstate", () => {
  for (const listener of routeListeners) listener();
});

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;

  history[replace ? "replaceState" : "pushState"](null, "", to);

  for (const listener of routeListeners) listener();
}

const onRoute = (listener: () => void) => {
  routeListeners.add(listener);

  return () => routeListeners.delete(listener);
};

export const usePath = () => useSyncExternalStore(onRoute, () => location.pathname);

export const useSearch = () => useSyncExternalStore(onRoute, () => location.search);

/** Sets URL query params; null or "" removes one. Typing in a field replaces the entry, a click pushes one. */
export function setParams(patch: Record<string, string | null>, replace = false) {
  const params = new URLSearchParams(location.search);

  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }

  const search = params.toString();

  navigate(location.pathname + (search ? `?${search}` : ""), replace);
}

const UNITS: [limit: number, size: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [Infinity, 86_400, "day"],
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const relativeTime = (when: string | number) => {
  const seconds = (Date.now() - new Date(when).getTime()) / 1000;
  const [, size, unit] = UNITS.find(([limit]) => Math.abs(seconds) < limit) ?? UNITS[3];

  return relative.format(-Math.round(seconds / size), unit);
};
