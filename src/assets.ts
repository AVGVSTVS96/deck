import { gzipSync } from "bun";
import { join } from "node:path";
import { watch } from "./sources";

type Asset = { type: string; body: Uint8Array<ArrayBuffer>; gzip: Uint8Array<ArrayBuffer>; immutable: boolean };

async function build(dir: string) {
  const result = await Bun.build({
    entrypoints: [join(dir, "index.html")],
    splitting: true,
    minify: true,
    publicPath: "/",
    target: "browser",
  });

  if (!result.success) throw new AggregateError(result.logs, "deck's web build failed");
  const assets = new Map<string, Asset>();

  for (const output of result.outputs) {
    const body = new Uint8Array(await output.arrayBuffer());
    const path = output.path.replace(/^\.\//, "/");

    assets.set(path, { type: output.type, body, gzip: gzipSync(body), immutable: path !== "/index.html" });
  }

  return assets;
}

/** The browser bundle, split per view and gzipped once at startup. Outside production, a change in the web folder rebuilds it. */
export async function webAssets(dir: string, production: boolean) {
  let assets = await build(dir);
  let latest = 0;

  if (!production) {
    watch([{ path: dir, recursive: true }], () => {
      const run = ++latest;

      build(dir).then(
        (next) => run === latest && (assets = next),
        (error) => console.error(error),
      );
    });
  }

  return (req: Request) => {
    const path = new URL(req.url).pathname;
    const page = !/\.\w+$/.test(path) || req.headers.get("accept")?.includes("text/html");
    const asset = assets.get(path) ?? (page ? assets.get("/index.html") : undefined);

    if (!asset) return new Response("not found", { status: 404 });

    return compressed(req, asset.body, asset.gzip, {
      "content-type": asset.type,
      "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
  };
}

export function compressed(
  req: Request,
  body: Uint8Array<ArrayBuffer>,
  gzip: Uint8Array<ArrayBuffer> | null,
  headers: Record<string, string>,
) {
  const vary = { ...headers, vary: "accept-encoding" };

  return gzip && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")
    ? new Response(gzip, { headers: { ...vary, "content-encoding": "gzip" } })
    : new Response(body, { headers: vary });
}
