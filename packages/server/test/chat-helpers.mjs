// What the chat server's tests share: a spec, keys, a server on the development relay, a wallet that talks to it as
// Saltix does (its grain key's address, sealed SGC1 frames, kept, every card checked), and a chain to read the grain's
// registry record and its members' keys from, whose blocks the tests make.
import { ed25519 } from "@noble/curves/ed25519";
import {
  fromHex, toHex, accountId, encodeAddress, issueInvoiceKeyCert, signChatSpec, signChatRequest, encodeChatFrame, decodeChatFrame,
  chatMessageProblem, newChatId, RelayClient, ChatServer, derive, signManifest, AppKey,
} from "../dist/index.js";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";

export const DAY = 86_400_000;
export const OWNER = fromHex("31".repeat(32), 32);
export const SERVER = fromHex("32".repeat(32), 32);
export const ownerKey = { ed25519: toHex(ed25519.getPublicKey(OWNER)) };
export const chain = { genesis: "6c".repeat(32), network: "devnet" };
export const quiet = () => {};
const en = (text) => ({ en: text });

export function spec(version = 1, over = {}) {
  return {
    slug: "access", version, intro: en("One-time access keys for the closed sites."),
    commands: [
      {
        name: "key", title: en("New key"), help: en("A key that opens a site once"), confirm: false, price: 0n,
        params: [
          { name: "duration", title: en("Access for"), kind: { duration: { options: [600, 86_400] } }, required: true },
          { name: "note", title: en("Note"), kind: { text: { max: 40 } }, required: false },
          { name: "site", title: en("Site"), kind: { choice: { options: [{ value: "saltix-io", title: en("saltix.io") }, { value: "web", title: en("Web") }] } }, required: true },
        ],
      },
      { name: "revoke", title: en("Revoke a key"), help: {}, confirm: true, price: 0n, params: [{ name: "id", title: en("Key"), kind: { text: { max: 16 } }, required: true }] },
      {
        name: "report", title: en("Daily report"), help: {}, confirm: false, price: 0n,
        params: [
          { name: "day", title: en("Day"), kind: { date: {} }, required: false },
          { name: "top", title: en("Top"), kind: { number: { min: 1n, max: 100n, decimals: 0 } }, required: false },
        ],
      },
      { name: "idle", title: en("Not served"), help: {}, confirm: false, price: 0n, params: [] },
    ],
    revoked: [], keeps: 30, ai: false, ...over,
  };
}

export const signedSpec = (version = 1, over = {}) => signChatSpec(spec(version, over), OWNER);
export const serverKey = toHex(ed25519.getPublicKey(SERVER));
/** The developer key of the access grain on the tests' network, for the server key. */
export const appKey = () => AppKey.of("devnet", chain.genesis, "access", SERVER);
export const cert = (expiresAt = Date.now() + 30 * DAY, key = toHex(ed25519.getPublicKey(SERVER))) => issueInvoiceKeyCert(OWNER, "access", key, expiresAt);

export const options = (relay, over = {}) => ({
  slug: "access", spec: signedSpec(), secret: SERVER, cert: cert(), chain, ownerKey, endpoints: [relay.endpoint()], log: quiet, ...over,
});

/** A development relay of its own and a server on it. */
export async function serverOn(over = {}) {
  const relay = await createDevRelay();
  const server = await ChatServer.start(options(relay, over));
  return { relay, server, close: async () => { server.close(); await relay.close(); } };
}

/** The owner's chat-only manifest of the access grain, signed. */
export const manifest = () => signManifest({
  slug: "access", version: 1, owner: toHex(accountId(fromHex(ownerKey.ed25519, 32))), owner_key: ownerKey, name: { en: "Access" }, description: {},
  icon: "11".repeat(32), entry: { chat: {} }, permissions: 4, sponsor: null, min_host: 1,
}, OWNER);

/**
 * A chain as a node's wallet interface shows it (`node_status`, `grain_get`, `account_get`, `relay_list`), for a server
 * that reads it: the access grain's record (`grain`, changed in place by the tests), accounts' controllers, and blocks
 * that `block()` (the beacon chain) and `shardBlock()` make. `calls` counts what was asked.
 */
export function fakeChain(over = {}) {
  const state = {
    status: { network: "devnet", genesis: chain.genesis, slot: 1, beacon: { height: 1, hash: "b0".repeat(32) }, shards: [{ shard: "", hash: "50".repeat(32) }] },
    grain: {
      slug: "access", owner: toHex(accountId(fromHex(ownerKey.ed25519, 32))), version: 1, id: "11".repeat(32), registered: 1, updated: 1,
      retired: null, deposit: "30000000000", manifest: manifest(), servers: [serverKey], category: 1, public: true, members: [], handles: [],
      ratings: { count: 0, sum: 0, citizens_count: 0, citizens_sum: 0 },
    },
    controllers: new Map(),
    down: false,
    ...over,
  };
  const calls = { node_status: 0, grain_get: 0, account_get: 0, relay_list: 0 };
  let n = 1;
  const wallet = {
    async call(method, params = {}) {
      calls[method] = (calls[method] ?? 0) + 1;
      if (state.down) throw new Error(`${method}: no relay answered`);
      switch (method) {
        case "node_status": return structuredClone(state.status);
        case "grain_get": return { grain: params.slug === "access" ? structuredClone(state.grain) : null, deposit: "30000000000" };
        case "account_get": return { account: params.address, shard: "", controller: state.controllers.get(params.address) ?? null };
        case "relay_list": return { relays: [] };
        default: throw new Error(`the fake chain does not answer ${method}`);
      }
    },
  };
  return {
    state, calls, wallet,
    /** A beacon block: the registry may have changed. */
    block() {
      n++;
      state.status.beacon = { height: n, hash: n.toString(16).padStart(64, "0") };
    },
    /** A shard block: accounts may have changed. */
    shardBlock() {
      n++;
      state.status.shards = [{ shard: "", hash: n.toString(16).padStart(2, "0").repeat(32) }];
    },
  };
}

/** A wallet: the user's grain key at the relay, sending requests and keeping every frame it gets, opened. */
export async function wallet(relay, seed, serverAddress, servers = []) {
  const secret = new Uint8Array(32).fill(seed);
  const messagingSecret = derive("Saltix grain messaging key v1", secret, new TextEncoder().encode("access"));
  const client = await RelayClient.connect({ endpoints: [relay.endpoint()], secret, messagingSecret, network: "devnet", log: quiet });
  const frames = [];
  const waiting = [];
  const others = [];
  client.on("frame", ({ from, payload }) => {
    try {
      frames.push({ from, ...decodeChatFrame(payload) });
    } catch {
      others.push(payload); // not a chat frame: a notification, say
    }
    for (const w of waiting.splice(0)) w();
  });
  const w = {
    client, secret, frames, others,
    key: toHex(ed25519.getPublicKey(secret)),
    address: encodeAddress("devnet", accountId(ed25519.getPublicKey(secret))),
    /** A request, signed by this wallet's grain key: `over` changes it before it is signed. */
    request(command, args = [], over = {}) {
      const now = Date.now();
      return signChatRequest({ slug: "access", id: newChatId(), at: now, expires_at: now + DAY, via: null, command, args, text: "", member: null, lang: "en", ...over }, secret, chain.genesis);
    },
    send: (signed) => client.send(serverAddress, encodeChatFrame({ request: signed }), { keep: true }),
    /** The messages so far that answer `id`. */
    answers: (id) => frames.filter((f) => f.message?.message.answers === id).map((f) => f.message),
    /** Waits until `test(frames)` holds, at most `ms`. */
    async until(test, ms = 5_000) {
      const end = Date.now() + ms;
      while (!test(frames)) {
        if (Date.now() > end) throw new Error("timed out waiting for frames");
        await new Promise((r) => { waiting.push(r); setTimeout(r, 100); });
      }
    },
    /** Why this wallet would not show `signed`, or null (22-grain-chats §4). */
    problem: (signed, s = spec(), keys = servers) => chatMessageProblem(signed, { chain, ownerKey, servers: keys, spec: s, from: serverAddress, now: Date.now() }),
  };
  return w;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
