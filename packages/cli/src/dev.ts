// `grain dev`: serve a grain's `public/` on this computer with its manifest signed for the origin each request came
// to — localhost for a browser, 10.0.2.2 for a debug Saltix in the Android emulator (developer origins, 12-grains §10).
// A sealed grain's bundle is made from `public/` for every manifest asked for and served at `/_bundle.zip`.
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import type { Manifest } from "@saltix/grain-server";
import { forOrigin, sign, originOf } from "./project.js";
import { makeBundle, sealed } from "./bundle.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".wasm": "application/wasm",
};

export const WELL_KNOWN = "/.well-known/saltix-grain";
export const DEV_BUNDLE = "/_bundle.zip";

/** The server; `manifest` is read again for every request, so edits show without a restart. */
export function serve(root: string, manifest: () => Manifest, secret: Uint8Array, port: number, host = "0.0.0.0"): Promise<Server> {
  const publicDir = join(root, "public");
  // The bundle the last manifest named: what `/_bundle.zip` serves, so the two always agree.
  let bundle: Uint8Array | null = null;
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (path === DEV_BUNDLE) {
      if (bundle === null) res.writeHead(404).end("ask for the manifest first");
      else res.writeHead(200, { "content-type": "application/zip", "cache-control": "no-store" }).end(bundle);
      return;
    }
    if (path === WELL_KNOWN) {
      const origin = originOf(`http://${req.headers.host ?? ""}`, true);
      if (origin === null) {
        res.writeHead(400).end("grain dev answers localhost, 127.0.0.1 and 10.0.2.2 only");
        return;
      }
      try {
        const m = manifest();
        let local: Manifest;
        if ("sealed" in m.entry) {
          const made = makeBundle(publicDir);
          bundle = made.zip;
          local = sealed(m, made, { sources: [origin + DEV_BUNDLE] });
        } else {
          local = forOrigin(m, origin);
        }
        const signed = sign(local, secretOf(), true);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(signed));
      } catch (e) {
        res.writeHead(500).end((e as Error).message);
      }
      return;
    }
    const file = normalize(join(publicDir, path.endsWith("/") ? path + "index.html" : path));
    if (!file.startsWith(publicDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  const secretOf = () => secret;
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is taken (by npm run dev, or another grain dev?): pass --port`) : e);
    });
    server.listen(port, host, () => resolve(server));
  });
}

/** The link that opens the grain served at `origin`. */
export const linkFor = (origin: string) => "salt:grain?manifest=" + encodeURIComponent(origin + WELL_KNOWN);
