import { existsSync, watch as watchPath } from "node:fs";

export type Watch = { path: string; recursive?: boolean; only?: RegExp };

/** Calls `change` once, `ms` after the first call in a burst. A steady stream of calls can't starve it. */
function burst(change: () => void, ms: number) {
  let timer: Timer | undefined;

  const ring = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      change();
    }, ms);
  };

  return { ring, stop: () => clearTimeout(timer) };
}

/** Calls `change` once, `ms` after the first matching file event in a burst. */
export function watch(paths: Watch[], change: () => void, ms = 250) {
  const changed = burst(change, ms);

  const watchers = paths.flatMap(({ path, recursive = false, only }) => {
    if (!existsSync(path)) return [];

    const watcher = watchPath(path, { recursive }, (_, file) => {
      if (only && !(file && only.test(file))) return;
      changed.ring();
    });

    watcher.on("error", () => watcher.close());

    return [watcher];
  });

  return () => {
    changed.stop();

    for (const watcher of watchers) watcher.close();
  };
}

/** Calls `change` once, `ms` after the first output in a burst from a command that prints a line per change, like `hex watch`; one that ends starts again. */
export function follow(command: string[], change: () => void, ms = 250) {
  const changed = burst(change, ms);

  async function run() {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "inherit" });

    for await (const _ of child.stdout) changed.ring();
    console.error(`${command.join(" ")} exited ${await child.exited}; starting it again`);
    setTimeout(run, 2000);
  }

  void run();
}

export type Source<T> = {
  /** The last value a load returned. A failed load keeps it. */
  readonly value: T | undefined;
  readonly at: number;
  readonly error: string | null;
  /** Fires only when a load's news differs from the last one's. */
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
  /** A command that prints a line per change, read again after each. */
  follow?: string[];
  debounceMs?: number;
  everyMs?: number;
  active?: () => boolean;
  /** Text that changes only when the value has news for listeners; the whole value by default. */
  news?: (value: T) => string;
};

export function source<T>({
  name,
  load,
  watch: paths = [],
  follow: command,
  debounceMs,
  everyMs,
  active = () => true,
  news = (value) => JSON.stringify(value),
}: Options<T>): Source<T> {
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
        const nextText = news(next);

        self.value = next;
        self.at = Date.now();
        self.error = null;

        if (nextText === text) continue;
        text = nextText;

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

  if (command) follow(command, () => void refresh(), debounceMs);

  if (everyMs) setInterval(() => active() && void refresh(), everyMs);

  return self;
}
