// `npm run dev`: serve the simulator and the hello-grain example on this computer, with the grain's
// server side (12-grains §5): its manifest at /.well-known/saltix-grain (signed for the origin a
// request came to: localhost for the simulator, 10.0.2.2 for a debug Saltix in the emulator),
// sign-in checks, an invoice, and the payment found through a node.
//
//   PORT       where to listen (8090)
//   NODE_RPC   a node's wallet interface (http://127.0.0.1:30734), for the genesis and payments
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  signManifest, iconHash, newChallenge, verifyLogin, signInvoice, accountId, encodeAddress, findPayment, rpc, toHex, fromHex,
} from "../packages/server/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8090);
const NODE_RPC = process.env.NODE_RPC ?? "http://127.0.0.1:30734";
const SLUG = "hello-grain";
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

// The developer's key: made once, kept owner-only next to the example (never committed).
const keyFile = join(root, "examples/hello-grain/owner.key");
if (!existsSync(keyFile)) writeFileSync(keyFile, toHex(randomBytes(32)) + "\n", { mode: 0o600 });
const ownerSecret = fromHex(readFileSync(keyFile, "utf8").trim(), 32);
const ownerKey = toHex(ed25519.getPublicKey(ownerSecret));
const ownerId = accountId(fromHex(ownerKey, 32));

function manifestFor(origin) {
  return signManifest({
    slug: SLUG,
    version: 1,
    owner: toHex(ownerId),
    owner_key: { ed25519: ownerKey },
    name: { en: "Hello, grain", ru: "Привет, крупинка" },
    description: { en: "The SDK's example: sign-in, storage, an invoice", ru: "Пример SDK: вход, хранилище, счёт" },
    icon: iconHash(new TextEncoder().encode("hello-grain icon")),
    entry: { hosted: { url: `${origin}/examples/hello-grain/index.html`, origins: [origin] } },
    permissions: 1 | 64,
    sponsor: null,
    min_host: 1,
  }, ownerSecret, true);
}

const challenges = new Map();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".map": "application/json" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body));
}

async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_384) throw new Error("too large");
  }
  return JSON.parse(text || "{}");
}

createServer(async (req, res) => {
  try {
    const host = (req.headers.host ?? "").split(":")[0];
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    if (url.pathname === "/.well-known/saltix-grain") {
      if (!DEV_HOSTS.has(host)) return send(res, 404, { error: "a developer's grain runs on localhost, 127.0.0.1 or 10.0.2.2" });
      return send(res, 200, manifestFor(origin));
    }
    if (url.pathname === "/api/challenge") {
      const challenge = newChallenge();
      challenges.set(challenge, Date.now() + 5 * 60_000);
      return send(res, 200, { challenge });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { answer, challenge } = await body(req);
      const fresh = (challenges.get(challenge) ?? 0) > Date.now();
      challenges.delete(challenge);
      const ok = fresh && verifyLogin(answer, { slug: SLUG, origin: req.headers.origin ?? answer.origin, challenge });
      return send(res, ok ? 200 : 401, ok ? { ok, user: answer.key } : { ok, error: "not signed in" });
    }
    if (url.pathname === "/api/invoice") {
      const status = await rpc(NODE_RPC, "node_status");
      const reference = toHex(randomBytes(16));
      const invoice = signInvoice({
        slug: SLUG, to: toHex(ownerId), asset: "SALT", amount: 1_000_000n, memo: "Hello, grain",
        reference, expires_at: Date.now() + 10 * 60_000,
      }, ownerSecret, status.genesis);
      return send(res, 200, { invoice, reference, to: encodeAddress(status.network, ownerId) });
    }
    if (url.pathname === "/api/paid") {
      const status = await rpc(NODE_RPC, "node_status");
      const payment = await findPayment(NODE_RPC, encodeAddress(status.network, ownerId), url.searchParams.get("reference") ?? "");
      return send(res, 200, { payment });
    }
    // Static files of the repository: the simulator, the SDK's build, the examples.
    const path = normalize(join(root, decodeURIComponent(url.pathname === "/" ? "/simulator/index.html" : url.pathname)));
    if (!path.startsWith(root) || path.includes("node_modules") || path.endsWith(".key") || !existsSync(path) || !statSync(path).isFile()) {
      return send(res, 404, { error: "not found" });
    }
    return send(res, 200, readFileSync(path), TYPES[extname(path)] ?? "application/octet-stream");
  } catch (e) {
    return send(res, 500, { error: String(e.message ?? e) });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`grain dev: http://localhost:${PORT}/ (simulator), the emulator's Saltix opens`);
  console.log(`  salt:grain?manifest=${encodeURIComponent(`http://10.0.2.2:${PORT}/.well-known/saltix-grain`)}`);
  console.log(`  owner key ${ownerKey}; node ${NODE_RPC}`);
});
