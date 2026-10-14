// `npm run dev`: serve the simulator and the hello-grain example on this computer, with the grain's
// server side (12-grains §5): its manifest at /.well-known/saltix-grain (signed for the origin a
// request came to: localhost for the simulator, 10.0.2.2 for a debug Saltix in the emulator),
// sign-in checks, an invoice, and the payment found through a node; and its chat (22-grain-chats):
// a development relay at /relay (scripts/dev-relay.mjs), the chat server of examples/hello-grain/chat.mjs
// on it, and its spec and certificate at /.well-known/saltix-grain-chat.
//
//   PORT       where to listen (8090)
//   NODE_RPC   a node's wallet interface (http://127.0.0.1:30734), for the genesis and payments
//   CHAT_NODE  a devnet node's wallet interface: the chat uses its relays and genesis instead of the
//              development relay, so a debug Saltix on that devnet can talk to it
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  signManifest, iconHash, newChallenge, verifyLogin, signInvoice, accountId, encodeAddress, findPayment, rpc, toHex, fromHex,
  chatSpecFromJson, signChatSpec, issueInvoiceKeyCert, fileChatStore,
} from "../packages/server/dist/index.js";
import { createDevRelay } from "./dev-relay.mjs";
import { startChat } from "../examples/hello-grain/chat.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8090);
const NODE_RPC = process.env.NODE_RPC ?? "http://127.0.0.1:30734";
const SLUG = "hello-grain";
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

// The developer's keys: made once, kept owner-only next to the example (never committed). The owner key signs the
// manifest and the chat spec and certifies the server key; the server key signs the chat's cards.
function keyFile(name) {
  const path = join(root, "examples/hello-grain", name);
  if (!existsSync(path)) writeFileSync(path, toHex(randomBytes(32)) + "\n", { mode: 0o600 });
  return fromHex(readFileSync(path, "utf8").trim(), 32);
}
const ownerSecret = keyFile("owner.key");
const serverSecret = keyFile("server.key");
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

let chat = null;
let chain = null;
const server = createServer(async (req, res) => {
  try {
    if (relay.handle(req, res) || chat?.serveDocument(req, res)) return;
    if (req.url === "/api/dev") return send(res, 200, { chain, chat: chat?.address ?? null, relay: process.env.CHAT_NODE ? null : "/relay" });
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
    // The simulator at its own path, so the page finds its script next to it (./dist/simulator.js).
    if (url.pathname === "/") return res.writeHead(302, { location: "/simulator/index.html" }).end();
    // Static files of the repository: the simulator, the SDK's build, the examples.
    const path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root) || path.includes("node_modules") || path.endsWith(".key") || path.endsWith(".store.json") || !existsSync(path) || !statSync(path).isFile()) {
      return send(res, 404, { error: "not found" });
    }
    return send(res, 200, readFileSync(path), TYPES[extname(path)] ?? "application/octet-stream");
  } catch (e) {
    return send(res, 500, { error: String(e.message ?? e) });
  }
});
const relay = createDevRelay({ server, path: "/relay" });

/** The chat: its spec and the server key's certificate signed now by the owner key (a real grain does both offline,
 *  with grain chat-spec and grain cert), on the development relay or a devnet node's relays. */
async function chatOn() {
  const node = process.env.CHAT_NODE;
  let genesis = "00".repeat(32);
  try {
    const status = await rpc(node ?? NODE_RPC, "node_status");
    if (status.network === "devnet") genesis = status.genesis;
  } catch {
    if (node) throw new Error(`CHAT_NODE ${node} does not answer`);
  }
  chain = { genesis, network: "devnet" };
  const spec = signChatSpec(chatSpecFromJson(JSON.parse(readFileSync(join(root, "examples/hello-grain/chat.json"), "utf8"))), ownerSecret);
  const serverKey = toHex(ed25519.getPublicKey(serverSecret));
  const cert = issueInvoiceKeyCert(ownerSecret, SLUG, serverKey, Date.now() + 30 * 86_400_000);
  const relays = node ? { node } : { endpoints: [{ url: `ws://127.0.0.1:${PORT}/relay`, cert_sha256: null }] };
  return startChat({
    slug: SLUG, spec, secret: serverSecret, cert, chain, ownerKey: { ed25519: ownerKey }, ...relays,
    store: fileChatStore(join(root, "examples/hello-grain/chat.store.json")),
    log: (level, event, meta) => level !== "info" && console.log(`chat ${level} ${event} ${JSON.stringify(meta ?? {})}`),
  }, toHex(ownerId));
}

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`grain dev: http://localhost:${PORT}/ (simulator), the emulator's Saltix opens`);
  console.log(`  salt:grain?manifest=${encodeURIComponent(`http://10.0.2.2:${PORT}/.well-known/saltix-grain`)}`);
  console.log(`  owner key ${ownerKey}; node ${NODE_RPC}`);
  try {
    chat = await chatOn();
    console.log(`  chat: ${chat.address} on ${process.env.CHAT_NODE ? `the relays of ${process.env.CHAT_NODE}` : `the development relay ws://127.0.0.1:${PORT}/relay`}`);
  } catch (e) {
    console.log(`  chat: not started (${e.message})`);
  }
});
