// `npm run dev`: serve the simulator and the hello-grain example on this computer, with the grain's
// server side (12-grains §5): its manifest at /.well-known/saltix-grain (signed for the origin a
// request came to: localhost for the simulator, 10.0.2.2 for a debug Saltix in the emulator),
// sign-in checks, an invoice, and the payment found through a node; and its chat (22-grain-chats,
// 24-app-studio): a development relay at /relay (scripts/dev-relay.mjs), a development registry that
// names the example's server key and says who may use it, the chat server of
// examples/hello-grain/chat.mjs on both, run from its developer key as a real app's server is, and its
// spec and the numbers it reports at /.well-known/saltix-grain-chat.
//
//   PORT       where to listen (8090)
//   NODE_RPC   a node's wallet interface (http://127.0.0.1:30734), for the genesis and payments
//   CHAT_NODE  a devnet node's wallet interface: the chat uses its relays and genesis instead of the
//              development relay, under a certificate (that devnet's registry does not name its key), so
//              a debug Saltix on that devnet can talk to it
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  signManifest, iconHash, newChallenge, verifyLogin, signInvoice, accountId, encodeAddress, findPayment, rpc, toHex, fromHex,
  chatSpecFromJson, signChatSpec, issueInvoiceKeyCert, fileChatStore, AppKey, ROLES,
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

/**
 * The development registry: what a node's wallet interface would say of the example grain (`node_status`,
 * `grain_get`, `account_get`, `relay_list`), the server key named in it, public until the simulator makes it private.
 * Every change is a new beacon block, which the chat server reads within seconds.
 */
const registry = {
  height: 1,
  grain: null,
  status() {
    return { network: "devnet", genesis: chain.genesis, slot: this.height, beacon: { height: this.height, hash: this.height.toString(16).padStart(64, "0") }, shards: [] };
  },
  record() {
    this.grain ??= {
      slug: SLUG, owner: toHex(ownerId), version: 1, id: "00".repeat(32), registered: 1, updated: 1, retired: null, deposit: "30000000000",
      manifest: manifestFor(`http://localhost:${PORT}`), servers: [toHex(ed25519.getPublicKey(serverSecret))], category: 9, public: true,
      members: [], handles: [], ratings: { count: 0, sum: 0, citizens_count: 0, citizens_sum: 0 },
    };
    return this.grain;
  },
  wallet: {
    async call(method, params = {}) {
      switch (method) {
        case "node_status": return registry.status();
        case "grain_get": return { grain: params.slug === SLUG ? structuredClone(registry.record()) : null, deposit: "30000000000" };
        case "account_get": return { account: params.address, shard: "", controller: null };
        case "relay_list": return { relays: [] };
        default: throw new Error(`the development registry does not answer ${method}`);
      }
    },
  },
  /** Make the grain public or private, with `members` (accounts in hex) who use and develop it: on its team, so their
   *  proofs reach the chat server and its reports reach them (24-app-studio §4). At a new block. */
  setAccess(open, members) {
    const g = this.record();
    g.public = open;
    g.members = members.filter((m) => /^[0-9a-f]{64}$/.test(m) && m !== g.owner).slice(0, 64).map((account) => ({ account, roles: ROLES.user | ROLES.developer }));
    this.height++;
  },
};
const server = createServer(async (req, res) => {
  try {
    if (relay.handle(req, res) || chat?.serveDocument(req, res)) return;
    if (req.url === "/api/dev") {
      const g = process.env.CHAT_NODE ? null : registry.record();
      return send(res, 200, {
        chain, chat: chat?.address ?? null, relay: process.env.CHAT_NODE ? null : "/relay",
        servers: g?.servers ?? [], access: g ? { owner: g.owner, public: g.public, members: g.members } : null,
      });
    }
    if (req.url === "/api/dev/access" && req.method === "POST" && !process.env.CHAT_NODE) {
      const { public: open, members } = await body(req);
      registry.setAccess(open !== false, Array.isArray(members) ? members : []);
      return send(res, 200, { access: { public: registry.grain.public, members: registry.grain.members } });
    }
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

/** The chat. On the development relay: from the example's developer key, which the development registry names, with
 *  the spec signed by that key, as your app's server runs (examples/hello-grain/server.mjs). On a devnet node's relays
 *  (CHAT_NODE): under a certificate the owner key signs now, with the spec the owner key signs (a real grain does both
 *  offline, with grain chat-spec and grain cert). */
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
  const json = chatSpecFromJson(JSON.parse(readFileSync(join(root, "examples/hello-grain/chat.json"), "utf8")));
  const store = fileChatStore(join(root, "examples/hello-grain/chat.store.json"));
  const log = (level, event, meta) => level !== "info" && console.log(`chat ${level} ${event} ${JSON.stringify(meta ?? {})}`);
  if (!node) {
    const appKey = AppKey.of("devnet", genesis, SLUG, serverSecret);
    return startChat({ appKey, spec: json, wallet: registry.wallet, endpoints: [{ url: `ws://127.0.0.1:${PORT}/relay`, cert_sha256: null }], store, log });
  }
  const serverKey = toHex(ed25519.getPublicKey(serverSecret));
  const cert = issueInvoiceKeyCert(ownerSecret, SLUG, serverKey, Date.now() + 30 * 86_400_000);
  return startChat({
    slug: SLUG, spec: signChatSpec(json, ownerSecret), secret: serverSecret, cert, chain, ownerKey: { ed25519: ownerKey }, node, store, log,
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
