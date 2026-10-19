// `grain dev`: serve a grain's `public/` on this computer with its manifest signed for the origin each request came
// to — localhost for a browser, 10.0.2.2 for a debug Saltix in the Android emulator (developer origins, 12-grains §10).
// A sealed grain's bundle is made from `public/` for every manifest asked for and served at `/_bundle.zip`. The
// simulator (saltix-grains' `simulator/`, built into this package) is at `/_simulator/`: the page framed as Saltix
// frames it, with the wallet's controls, on a phone, the Galaxy Z Fold's sizes and an iPhone-like screen, and the bridge
// answered. A development registry stands in for the network's (`/api/dev`, for the simulator: the team, a private app's
// members, so that sign-ins carry member proofs; `/api/dev/rpc`, a node's wallet interface for the app's own server), and
// a sealed grain's pages carry the Content-Security-Policy Saltix serves them with.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppKey, type Manifest, ROLES, iconHash } from "@saltix/grain-server";
import { createDevRegistry } from "@saltix/grain-server/dev";
import { sealedCsp } from "@saltix/grain/rules";
import { forOrigin, sign, originOf } from "./project.js";
import { makeBundle, sealed } from "./bundle.js";
import { ICON_FILES } from "./icon.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".wasm": "application/wasm",
};

export const WELL_KNOWN = "/.well-known/saltix-grain";
export const DEV_BUNDLE = "/_bundle.zip";
/** Where the project's Connect profile (`connect.json`) is served, for the simulator's preview of the Connect sheet. */
export const DEV_CONNECT = "/_connect.json";
/** Where the project's icon is served (the file whose hash `grain.json`'s `icon` is), for the simulator's Connect sheet and
 *  splash: Saltix draws the icon the manifest names, and the app's monogram without one. */
export const DEV_ICON = "/_icon.png";
/** Where the simulator is served; it loads the manifest and opens the page. */
export const SIMULATOR = "/_simulator/";
/** The simulator's files, built next to this module. */
const SIMULATOR_DIR = fileURLToPath(new URL("./simulator/", import.meta.url));

/** The file of `dir` that `path` (below it, already decoded) names, or null when it would leave `dir` or is none. */
function fileIn(dir: string, path: string): string | null {
  const root = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  const file = normalize(join(root, path.endsWith("/") ? path + "index.html" : path));
  return file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile() ? file : null;
}

/** The simulator's view of the development registry. */
export const DEV_API = "/api/dev";

/** A request's JSON body, at most 16 KiB. */
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_384) throw new Error("too large");
  }
  const value = JSON.parse(text || "{}") as unknown;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface ServeOptions {
  /** A developer key: the development registry is then of its network and genesis and names its key, so the app's
   *  server started from it runs against the registry (`node: <origin>/api/dev/rpc`). */
  appKey?: AppKey;
}

/** The server; `manifest` is read again for every request, so edits show without a restart. */
export function serve(root: string, manifest: () => Manifest, secret: Uint8Array, port: number, host = "0.0.0.0", o: ServeOptions = {}): Promise<Server> {
  const publicDir = join(root, "public");
  // The bundle the last manifest named: what `/_bundle.zip` serves, so the two always agree.
  let bundle: Uint8Array | null = null;
  // The development registry: the grain public until the simulator makes it private, its owner the owner key's account.
  const registry = createDevRegistry({
    slug: manifest().slug, ownerSecret: secret, servers: o.appKey ? [o.appKey.publicKey] : [],
    // A developer key names its network's genesis by a prefix: the registry's starts with it.
    network: o.appKey?.network ?? "devnet", genesis: o.appKey ? o.appKey.genesis.padEnd(64, "0") : undefined,
  });
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  };
  const dev = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const g = registry.grain;
    if (path === DEV_API) {
      return json(res, 200, {
        chain: { genesis: registry.genesis, network: registry.network }, chat: null, relay: null, servers: g.servers ?? [],
        access: { owner: g.owner, public: g.public, members: g.members ?? [] },
      });
    }
    if (req.method !== "POST") return json(res, 405, { error: "POST" });
    const body = await jsonBody(req);
    if (path === `${DEV_API}/access`) {
      // Who uses and develops the app besides its owner: on its team, so their sign-ins carry member proofs.
      const members = (Array.isArray(body.members) ? body.members : [])
        .filter((m): m is string => typeof m === "string" && /^[0-9a-f]{64}$/.test(m) && m !== g.owner)
        .slice(0, 64).map((account) => ({ account, roles: ROLES.user | ROLES.developer }));
      registry.setAccess(body.public !== false, members);
      return json(res, 200, { access: { public: g.public, members: g.members ?? [] } });
    }
    // `${DEV_API}/rpc`: JSON-RPC 2.0, as a node's wallet interface answers it.
    try {
      const result = await registry.call(String(body.method ?? ""), (body.params ?? {}) as object);
      return json(res, 200, { jsonrpc: "2.0", id: body.id ?? null, result });
    } catch (e) {
      return json(res, 200, { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: (e as Error).message } });
    }
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (path === DEV_API || path === `${DEV_API}/access` || path === `${DEV_API}/rpc`) {
      dev(req, res, path).catch((e: Error) => json(res, 400, { error: e.message }));
      return;
    }
    if (path === SIMULATOR.slice(0, -1)) {
      res.writeHead(302, { location: SIMULATOR }).end();
      return;
    }
    if (path.startsWith(SIMULATOR)) {
      const file = fileIn(SIMULATOR_DIR, path.slice(SIMULATOR.length - 1));
      if (file === null) res.writeHead(404).end("not found");
      else res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
      return;
    }
    if (path === DEV_CONNECT) {
      const file = join(root, "connect.json");
      if (!existsSync(file)) res.writeHead(404).end("no connect.json: every app ships a Connect profile (grain lint)");
      else res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(readFileSync(file));
      return;
    }
    if (path === DEV_ICON) {
      let file: string | undefined;
      try {
        const named = manifest().icon;
        file = ICON_FILES.map((f) => join(root, f)).find((f) => existsSync(f) && iconHash(new Uint8Array(readFileSync(f))) === named);
      } catch {
        file = undefined;
      }
      if (file === undefined) res.writeHead(404).end("no icon file here is the one grain.json names: grain icon makes one");
      else res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(readFileSync(file));
      return;
    }
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
    const file = fileIn(publicDir, path);
    if (file === null) {
      res.writeHead(404).end("not found");
      return;
    }
    // A sealed grain's files carry the policy Saltix serves them with: what it refuses, the browser refuses here first.
    let entry: Manifest["entry"] | null = null;
    try {
      entry = manifest().entry;
    } catch {
      /* a manifest being edited: served as it is */
    }
    const policy = entry && "sealed" in entry ? { "content-security-policy": sealedCsp(entry.sealed.connect), "x-content-type-options": "nosniff" } : {};
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", ...policy });
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

/** The simulator's page for the grain served at `origin`. */
export const simulatorFor = (origin: string) => `${origin}${SIMULATOR}?manifest=${encodeURIComponent(WELL_KNOWN)}`;
