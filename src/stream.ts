import type { LiveValue, ServerEvent } from "./contract";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 20_000;

type Client = ReadableStreamDefaultController<Uint8Array>;

/** One SSE stream per tab: a snapshot on connect, then only the live keys whose JSON changed. */
export class Stream {
  private clients = new Set<Client>();
  private live = new Map<string, { value: LiveValue; text: string }>();

  constructor() {
    setInterval(() => this.send(encoder.encode(": \n\n")), HEARTBEAT_MS);
  }

  get size() {
    return this.clients.size;
  }

  respond() {
    let self: Client;
    const snapshot = Object.fromEntries([...this.live].map(([key, { value }]) => [key, value]));

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        self = controller;
        this.clients.add(controller);
        controller.enqueue(frame({ type: "snapshot", live: snapshot }));
      },
      cancel: () => void this.clients.delete(self),
    });

    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  publish(next: Record<string, LiveValue>) {
    const patch: Record<string, LiveValue | null> = {};

    for (const [key, value] of Object.entries(next)) {
      const text = JSON.stringify(value);

      if (this.live.get(key)?.text === text) continue;
      this.live.set(key, { value, text });
      patch[key] = value;
    }

    for (const key of this.live.keys()) {
      if (key in next) continue;
      this.live.delete(key);
      patch[key] = null;
    }

    if (Object.keys(patch).length) this.send(frame({ type: "patch", live: patch }));
  }

  stale(...tags: string[]) {
    if (tags.length) this.send(frame({ type: "stale", tags }));
  }

  private send(bytes: Uint8Array) {
    for (const client of this.clients) {
      try {
        client.enqueue(bytes);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

const frame = (event: ServerEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
