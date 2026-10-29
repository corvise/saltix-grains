// A whole site that signs its visitors in with Saltix in the server-held mode (Saltix 19-connect §15), on Node's own
// http module and `@saltix/connect/server`, for any site or DApp to copy: the server makes the offer's keys and takes
// the login, the page is its courier, a session cookie of the server's own opens after every check. Nothing here
// trusts a login server of anyone else's: the check runs on this machine, against a node this site chooses.
//
//   npm run example:connect              then open http://localhost:8091/
//
//   SALTIX_NETWORK   devnet (Saltix's test network), testnet or mainnet
//   SALTIX_GENESIS   the network's genesis hash, hex: what `node_status` of your node answers as `genesis`
//   SALTIX_NODE      a node's wallet interface this server reads key event logs from (http://127.0.0.1:30334 by default,
//                    a node of your own on this machine; or a relay's gateway through a pinned proxy, docs/connect.md §3)
//   SALTIX_RELAYS    where the page opens its slot, comma-separated: paths of this site that a proxy passes to one relay
//                    each, pinned (docs/connect.md §3), or wss:// URLs (/saltix/r/1/ by default)
//   SITE_ORIGIN      this site's origin as a browser serializes it (http://localhost:8091 by default; https in production)
//   SITE_NAME        what the offer calls this site (Example site)
//   SITE_ALLOW       optional: the addresses allowed in, comma-separated; everyone when unset (19-connect §15.2 step 6)
//   PORT             8091
//
// The journal is one JSON line per event, names and numbers only: never an address, an account or a login's bytes.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServerConnect } from "../dist/server.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A session lives this long: the site's own rule (§15.4), 30 days here, as the page's own mode keeps a connection. */
export const SESSION_MS = 30 * 24 * 60 * 60_000;
/** Offers a client may ask for in a minute, as a site limits a key's redemption. */
export const OFFERS_PER_MINUTE = 10;
/** A forwarded payload is at most 8 KiB (09-relay §10.3): twice that, base64url and JSON around it, is plenty. */
export const MAX_BODY_BYTES = 16 * 1024;
export const COOKIE = "site_session";

const STATIC = {
  "/": ["page/index.html", "text/html; charset=utf-8"],
  "/app.js": ["page/app.js", "text/javascript; charset=utf-8"],
  "/site.css": ["page/site.css", "text/css; charset=utf-8"],
  "/saltix-connect.js": ["../dist/saltix-connect.js", "text/javascript; charset=utf-8"],
  "/connect.css": ["../dist/connect.css", "text/css; charset=utf-8"],
};

/** Where the page may connect to: this origin (its relay paths and this server), and any `wss://` relay it names. */
const connectSources = (relays) => ["'self'", ...new Set(relays.filter((r) => /^wss?:\/\//.test(r)).map((r) => new URL(r).origin))].join(" ");

/**
 * The site: `connect` is `createServerConnect(…)` for this origin; `relays` what the page opens its slot through;
 * `allow`, when given, the addresses let in (a Set, or a function of the connection answering a reason or null).
 */
export function exampleSite({ connect, origin, network, relays, allow = null, now = () => Date.now(), log = () => {}, root = here }) {
  const sessions = new Map();
  const asked = new Map();
  const secure = origin.startsWith("https:");
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connectSources(relays)}; base-uri 'none'; frame-ancestors 'none'`;

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const cookieOf = (req) => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE) return rest.join("=");
    }
    return null;
  };
  const setCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const sessionOf = (req) => {
    const token = cookieOf(req);
    const session = token ? sessions.get(token) : undefined;
    if (session && session.expires <= now()) {
      sessions.delete(token);
      return null;
    }
    return session ?? null;
  };
  /** The site's own rule on a login the protocol took (§15.2 step 6): the allow-list, when there is one. */
  const admit = allow === null ? undefined : typeof allow === "function" ? allow : (c) => (allow.has(c.address) ? null : "not_listed");
  /** A client's offers in the last minute. */
  const tooMany = (ip) => {
    const recent = (asked.get(ip) ?? []).filter((t) => now() - t < 60_000);
    if (recent.length >= OFFERS_PER_MINUTE) {
      asked.set(ip, recent);
      return true;
    }
    recent.push(now());
    asked.set(ip, recent);
    if (asked.size > 10_000) asked.delete(asked.keys().next().value);
    return false;
  };
  // A body past the limit is refused with 413 and the rest of it drained, so the answer reaches the client (a
  // destroyed socket would tell it nothing).
  const body = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (over) return;
        if (size > MAX_BODY_BYTES) {
          over = true;
          chunks.length = 0;
          reject(Object.assign(new Error("too large"), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
  const parsed = async (req) => {
    const text = await body(req);
    try {
      const value = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
      return value;
    } catch {
      throw Object.assign(new Error("not JSON"), { status: 400 });
    }
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", origin);
    const route = `${req.method} ${url.pathname}`;
    const started = now();

    if (req.method === "GET" && url.pathname in STATIC) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache", ...(type.startsWith("text/html") ? { "content-security-policy": csp } : {}) });
      res.end(readFileSync(join(root, file)));
      return;
    }
    if (route === "GET /config.json") return json(res, 200, { network, relays, server: { offer: "/connect/offer", login: "/connect/login" } });
    if (route === "GET /me") {
      const session = sessionOf(req);
      if (!session) return json(res, 401, { error: "signed_out" });
      return json(res, 200, { address: session.connection.address, since: session.since, until: session.expires });
    }
    if (req.method === "POST") {
      // A POST is this page's own: the browser names the page's origin on every cross-site one, and on same-origin
      // ones too; a request without it, or from elsewhere, is nobody's (the session cookie is SameSite besides).
      if (req.headers.origin !== origin) return json(res, 403, { error: "origin" });
      if (route === "POST /connect/offer") {
        if (tooMany(req.socket.remoteAddress ?? "")) {
          log("offer_limited", { ms: now() - started });
          return json(res, 429, { error: "too_many_offers" });
        }
        const offer = await connect.offer();
        log("offer", { ms: now() - started });
        return json(res, 200, offer);
      }
      if (route === "POST /connect/login") {
        const forwarded = await parsed(req);
        const taken = await connect.take({ sid: String(forwarded.sid ?? ""), payload: String(forwarded.payload ?? "") }, admit);
        log("login", { outcome: taken.outcome, ...(taken.outcome === "refused" ? { reason: taken.reason } : {}), ...(taken.outcome === "unchecked" ? { kind: taken.kind } : {}), ms: now() - started });
        if (taken.outcome !== "connected") return json(res, 200, taken);
        // The session: a token minted here, after every check, derived from nothing the page sent (§15.1 step 5).
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, { connection: taken.connection, since: now(), expires: now() + SESSION_MS });
        return json(res, 200, { ...taken, next: "/" }, { "set-cookie": setCookie(token, Math.floor(SESSION_MS / 1000)) });
      }
      if (route === "POST /signout") {
        const token = cookieOf(req);
        if (token) sessions.delete(token);
        log("signout", { ms: now() - started });
        return json(res, 200, { ok: true }, { "set-cookie": setCookie("", 0) });
      }
    }
    json(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = typeof e?.status === "number" ? e.status : 500;
      log("request_failed", { route: `${req.method} ${req.url}`, status, message: status === 500 ? String(e?.message ?? e) : e.message });
      if (!res.headersSent) json(res, status, { error: status === 500 ? "server" : e.message }, status === 413 ? { connection: "close" } : {});
      else res.end();
    });
  });
  return { server, sessions, handle };
}

/** The site from the environment, listening. */
export function main() {
  const network = process.env.SALTIX_NETWORK ?? "devnet";
  const genesis = process.env.SALTIX_GENESIS;
  if (!genesis) {
    console.error("SALTIX_GENESIS names the network's genesis hash (node_status's genesis of your node)");
    process.exit(2);
  }
  const origin = process.env.SITE_ORIGIN ?? "http://localhost:8091";
  const relays = (process.env.SALTIX_RELAYS ?? "/saltix/r/1/").split(",").map((r) => r.trim()).filter(Boolean);
  const log = (event, meta) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...meta }));
  const connect = createServerConnect({
    node: process.env.SALTIX_NODE ?? "http://127.0.0.1:30334",
    network,
    genesis,
    origin,
    name: process.env.SITE_NAME ?? "Example site",
    telemetry: log,
  });
  const allow = process.env.SITE_ALLOW ? new Set(process.env.SITE_ALLOW.split(",").map((a) => a.trim()).filter(Boolean)) : null;
  const { server } = exampleSite({ connect, origin, network, relays, allow, log });
  const port = Number(process.env.PORT ?? 8091);
  server.listen(port, () => log("listening", { port, network, relays: relays.length, allow: allow ? allow.size : -1 }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
