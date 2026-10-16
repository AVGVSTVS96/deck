import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import type { DeckEvent } from "../src/events";

export class ApiError extends Error {}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const body = await response.json();

  if (!response.ok) throw new ApiError(body.error ?? `Request failed (${response.status})`);

  return body;
}

export type Body = Record<string, string | boolean>;

export const send = <T>(path: string, method: string, body?: Body) =>
  api<T>(path, body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method });

export const putText = (path: string, text: string) => api<{ ok: true }>(path, { method: "PUT", body: text });

type Heard = DeckEvent | { type: "resync" };

const listeners = new Set<(event: Heard) => void>();
let source: EventSource | null = null;

const tell = (event: Heard) => {
  for (const listener of listeners) listener(event);
};

function connect() {
  let opened = false;

  source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    if (opened) tell({ type: "resync" });

    opened = true;
  });
  source.addEventListener("message", (message) => tell(JSON.parse(message.data)));
}

export function useDeckEvent(listener: (event: Heard) => void) {
  const onEvent = useEffectEvent(listener);

  useEffect(() => {
    if (!source) connect();

    const handle = (event: Heard) => onEvent(event);

    listeners.add(handle);

    return () => {
      listeners.delete(handle);
    };
  }, []);
}

export type Load<T> = { data: T | null; error: string | null; reload: () => Promise<void> };

type Loaded<T> = { path: string | null; data: T | null; error: string | null };

async function fetchLoaded<T>(path: string): Promise<Loaded<T>> {
  try {
    return { path, data: await api<T>(path), error: null };
  } catch (error) {
    return { path, data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function useLoad<T>(path: string | null, refreshOn?: (event: DeckEvent) => boolean): Load<T> {
  const [state, setState] = useState<Loaded<T>>({ path, data: null, error: null });
  const latest = useRef(path);

  const reload = useCallback(async () => {
    if (path === null) return;

    const next = await fetchLoaded<T>(path);

    if (latest.current === path) setState(next);
  }, [path]);

  useEffect(() => {
    latest.current = path;
    void reload();
  }, [path, reload]);

  useDeckEvent((event) => {
    if (event.type === "resync" || refreshOn?.(event)) void reload();
  });

  useEffect(() => {
    const onFocus = () => void reload();

    window.addEventListener("focus", onFocus);

    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const current = state.path === path;

  return { data: current ? state.data : null, error: current ? state.error : null, reload };
}

const routeListeners = new Set<() => void>();

window.addEventListener("popstate", () => {
  for (const listener of routeListeners) listener();
});

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;

  history[replace ? "replaceState" : "pushState"](null, "", to);

  for (const listener of routeListeners) listener();
}

export function usePath() {
  return useSyncExternalStore(
    (listener) => {
      routeListeners.add(listener);

      return () => routeListeners.delete(listener);
    },
    () => location.pathname,
  );
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
