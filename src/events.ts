import { existsSync, watch, type FSWatcher } from "node:fs";
import type { Agents } from "./types";

export type DeckEvent =
  | { type: "repo"; repo: string }
  | { type: "ws"; id: string }
  | { type: "agents"; data?: Agents }
  | { type: "plugins" };

const encoder = new TextEncoder();
const BURST_MS = 80;

export class Events {
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private queued = new Set<string>();
  private watchers = new Map<string, FSWatcher>();
  private agents: (() => Promise<Agents>) | null = null;
  generation = 0;

  pushAgents(build: () => Promise<Agents>) {
    this.agents = build;
  }

  emit(event: DeckEvent) {
    const key = JSON.stringify(event);

    if (this.queued.has(key)) return;
    this.queued.add(key);
    setTimeout(async () => {
      this.queued.delete(key);
      this.generation++;
      const data = event.type === "agents" && this.agents && this.clients.size ? await this.agents().catch(() => undefined) : undefined;
      const message = encoder.encode(`data: ${data ? JSON.stringify({ ...event, data }) : key}\n\n`);

      for (const client of this.clients) client.enqueue(message);
    }, BURST_MS);
  }

  watch(path: string, event: DeckEvent, options: { recursive?: boolean; only?: RegExp } = {}) {
    if (this.watchers.has(path) || !existsSync(path)) return;

    const watcher = watch(path, { recursive: options.recursive ?? false }, (_, file) => {
      if (!options.only || (file && options.only.test(file))) this.emit(event);
    });

    watcher.on("error", () => this.unwatch(path));
    this.watchers.set(path, watcher);
  }

  unwatch(path: string) {
    this.watchers.get(path)?.close();
    this.watchers.delete(path);
  }

  stream() {
    let self: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        self = controller;
        this.clients.add(controller);
        controller.enqueue(encoder.encode(": open\n\n"));
      },
      cancel: () => {
        this.clients.delete(self);
      },
    });

    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }
}
