import { existsSync, watch as watchPath } from "node:fs";

export type Watch = { path: string; recursive?: boolean; only?: RegExp };

/** Calls `change` once, `ms` after the first matching file event in a burst. A steady stream of writes can't starve it. */
export function watch(paths: Watch[], change: () => void, ms = 250) {
  let timer: Timer | undefined;

  const watchers = paths.flatMap(({ path, recursive = false, only }) => {
    if (!existsSync(path)) return [];

    const watcher = watchPath(path, { recursive }, (_, file) => {
      if (only && !(file && only.test(file))) return;
      timer ??= setTimeout(() => {
        timer = undefined;
        change();
      }, ms);
    });

    watcher.on("error", () => watcher.close());

    return [watcher];
  });

  return () => {
    clearTimeout(timer);

    for (const watcher of watchers) watcher.close();
  };
}

export type Source<T> = {
  /** The last value a load returned. A failed load keeps it. */
  readonly value: T | undefined;
  readonly at: number;
  readonly error: string | null;
  /** Fires only when a load returns a value that differs from the last one. */
  on(change: (value: T) => void): void;
  /** One load in flight; a call during a load queues exactly one more. */
  refresh(): Promise<void>;
  /** The load in flight, or a new one: for a caller that only needs a value, not a newer one. */
  ready(): Promise<void>;
};

type Options<T> = {
  name: string;
  load: () => Promise<T>;
  watch?: Watch[];
  debounceMs?: number;
  everyMs?: number;
  active?: () => boolean;
};

export function source<T>({ name, load, watch: paths = [], debounceMs, everyMs, active = () => true }: Options<T>): Source<T> {
  const listeners = new Set<(value: T) => void>();
  let running: Promise<void> | null = null;
  let again = false;
  let text = "";

  const self: { value: T | undefined; at: number; error: string | null } & Pick<Source<T>, "on" | "refresh" | "ready"> = {
    value: undefined,
    at: 0,
    error: null,
    on: (change: (value: T) => void) => void listeners.add(change),
    refresh,
    ready: () => running ?? refresh(),
  };

  async function run() {
    do {
      again = false;

      try {
        const next = await load();
        const nextText = JSON.stringify(next);

        self.at = Date.now();
        self.error = null;

        if (nextText === text) continue;
        text = nextText;
        self.value = next;

        for (const change of listeners) change(next);
      } catch (error) {
        self.error = error instanceof Error ? error.message : String(error);
        console.error(`${name}: ${self.error}`);
      }
    } while (again);

    running = null;
  }

  function refresh() {
    if (running) {
      again = true;

      return running;
    }

    running = run();

    return running;
  }

  if (paths.length) watch(paths, () => void refresh(), debounceMs);

  if (everyMs) setInterval(() => active() && void refresh(), everyMs);

  return self;
}
