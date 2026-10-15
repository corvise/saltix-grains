// A relay for development and tests: the part of a Saltix relay (09-relay §3, §10.5) a grain's server and a wallet
// use, in one process with no node. It checks address records as relays do (this relay, this connection's challenge,
// the time, the signatures), forwards frames with `from`, keeps kept frames in the addressee's mailbox until a signed
// ack (and delivers them again on the next registration), and keeps files: `file_new`, then `PUT /_file/<id>` with
// `X-Offset`, `GET …/status`, `POST …/done`, `GET /_file/<id>`; an app's numbers (`grain_stats`), the newest of each
// grain, as they come (a real relay's node checks them against the registry and gossips them; this relay has no node).
// Plain `ws://` and `http://`: loopback only.
//
//   const relay = await createDevRelay();                  // its own server on 127.0.0.1, a free port
//   const relay = createDevRelay({ server, path: "/relay" }) // or beside your routes: call relay.handle(req, res)
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { ed25519 } from "@noble/curves/ed25519";
import {
  accountId, encodeAddress, decodeAddressRecord, recordProblem, fromBase64Url, toBase64Url, toHex, derive, Reader,
  decodeSignedGrainStats, encodeSignedGrainStats,
} from "../packages/server/dist/index.js";

const MAX_FILE = 50 * 1024 * 1024 + 16;
const MAX_PIECE = 1024 * 1024;
const SKEW_MS = 10 * 60_000;

export function createDevRelay(options = {}) {
  const network = options.network ?? "devnet";
  const path = options.path ?? "/relay";
  const relayKey = new Uint8Array(32).fill(9);
  const records = new Map();
  const sessions = new Map();
  const mailboxes = new Map();
  const files = new Map();
  const stats = new Map();
  const sent = [];
  const awaited = [];
  const own = !options.server;
  const server = options.server ?? createServer((req, res) => {
    if (!handle(req, res)) res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path });

  const send = (ws, frame) => ws.readyState === 1 && ws.send(JSON.stringify(frame));
  const live = (address) => [...(sessions.get(address) ?? [])];
  const mailbox = (address) => {
    if (!mailboxes.has(address)) mailboxes.set(address, new Map());
    return mailboxes.get(address);
  };

  wss.on("connection", (ws) => {
    const nonce = randomBytes(16);
    const sts = Date.now();
    send(ws, { type: "hello", nonce: toBase64Url(nonce), sts, relay: toBase64Url(relayKey), network, prices: { frame: "0", file_mib: "0", turn_kib: "0" } });
    ws.on("close", () => sessions.get(ws.address)?.delete(ws));
    ws.on("message", (data) => {
      let f;
      try {
        f = JSON.parse(data.toString());
      } catch {
        return send(ws, { type: "error", message: "bad_frame" });
      }
      sent.push(f);
      for (const w of awaited.filter((w) => w.type === f.type)) {
        awaited.splice(awaited.indexOf(w), 1);
        w.resolve(f);
      }
      if (f.type === "register") return register(ws, f, nonce, sts);
      if (!ws.address) return send(ws, { type: "error", message: "not_registered", detail: f.type });
      switch (f.type) {
        case "get_key":
          return send(ws, { type: "key_response", pubkey: f.pubkey, record: records.get(f.pubkey) ?? null, encryptKey: null, managed: null, log: null });
        case "message":
          return message(ws, f);
        case "message_ack":
          return ack(ws, f);
        case "file_new":
          return fileNew(ws, f);
        case "grain_stats":
          return grainStats(ws, f);
        default:
          return send(ws, { type: "error", message: "unsupported", detail: f.type });
      }
    });
  });

  // An app's numbers (09-relay §3): the newest of each grain; the same ones again are taken again, older ones are stale.
  function grainStats(ws, f) {
    let signed;
    try {
      signed = decodeSignedGrainStats(fromBase64Url(String(f.stats)));
    } catch {
      return send(ws, { type: "grain_stats_refused", reason: "malformed" });
    }
    const kept = stats.get(signed.stats.slug);
    const same = kept && toHex(encodeSignedGrainStats(kept)) === toHex(encodeSignedGrainStats(signed));
    if (kept && !same && signed.stats.at <= kept.stats.at) return send(ws, { type: "grain_stats_refused", reason: "stale" });
    stats.set(signed.stats.slug, signed);
    send(ws, { type: "grain_stats_taken", slug: signed.stats.slug, at: signed.stats.at });
  }

  function register(ws, f, nonce, sts) {
    let r;
    try {
      r = decodeAddressRecord(fromBase64Url(f.record));
    } catch {
      return send(ws, { type: "error", message: "auth_failed", detail: "malformed" });
    }
    const ok = recordProblem(r, Date.now()) === null && toHex(r.relay) === toHex(relayKey) && toHex(r.nonce) === toHex(nonce) &&
      Math.abs(r.issuedAt - sts) <= SKEW_MS;
    if (!ok) return send(ws, { type: "error", message: "auth_failed", detail: "invalid" });
    const address = encodeAddress(network, accountId(r.key.accountKey));
    records.set(address, f.record);
    ws.address = address;
    if (!sessions.has(address)) sessions.set(address, new Set());
    sessions.get(address).add(ws);
    send(ws, { type: "registered", pubkey: address, keyEpoch: r.key.keyEpoch, turn: null });
    // The mailbox: every kept frame not yet acknowledged.
    for (const frame of mailbox(address).values()) send(ws, frame);
  }

  function message(ws, f) {
    if (typeof f.to !== "string" || typeof f.payload !== "string" || typeof f.msgId !== "string") return send(ws, { type: "error", message: "bad_frame", detail: "message" });
    if (f.payload.length > 64 * 1024) return send(ws, { type: "error", message: "payload_too_large" });
    const frame = { type: "message", to: f.to, from: ws.address, payload: f.payload, msgId: f.msgId, sts: Date.now(), ...(f.ephemeral ? { ephemeral: true } : {}) };
    if (!f.ephemeral) mailbox(f.to).set(f.msgId, frame);
    const to = live(f.to);
    to.forEach((peer) => send(peer, frame));
    if (to.length === 0 && f.ephemeral) send(ws, { type: "peer-offline", pubkey: f.to, reason: "message" });
  }

  function ack(ws, f) {
    // The proof: Borsh {account key, msgId, at, device: None} and its signature, by the acknowledging address's key.
    try {
      const proof = fromBase64Url(f.proof);
      const body = proof.subarray(0, proof.length - 64);
      const r = new Reader(body);
      const key = r.fixed(32);
      const msgId = r.string(256);
      r.u64();
      if (r.u8() !== 0) throw new Error("device");
      r.end();
      const signed = ed25519.verify(proof.subarray(proof.length - 64), derive("Saltix mailbox ack v1", body), key);
      if (!signed || msgId !== f.msgId || encodeAddress(network, accountId(key)) !== ws.address) throw new Error("proof");
    } catch {
      return send(ws, { type: "error", message: "bad_proof" });
    }
    mailbox(ws.address).delete(f.msgId);
  }

  function fileNew(ws, f) {
    const size = f.size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE) return send(ws, { type: "error", message: "file_refused", detail: "too_large", ref: f.ref ?? null });
    const id = toBase64Url(randomBytes(16));
    files.set(id, { size, bytes: Buffer.alloc(0), done: false });
    send(ws, { type: "file_slot", id, ref: f.ref ?? null });
  }

  const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  /** The file routes on the relay's port: true when it answered. */
  function handle(req, res) {
    const m = /^\/_file\/([A-Za-z0-9_-]{22})(\/status|\/done)?$/.exec((req.url ?? "").split("?")[0]);
    if (!m) return false;
    const [, id, tail] = m;
    const file = files.get(id);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!file) return res.writeHead(404).end();
      if (req.method === "PUT" && !tail) {
        const offset = Number(req.headers["x-offset"]);
        const body = Buffer.concat(chunks);
        const fault = relay.filePutHook?.(id, offset, body.length);
        if (fault) return fault === 404 ? (files.delete(id), res.writeHead(404).end()) : res.writeHead(fault).end();
        if (!Number.isSafeInteger(offset)) return res.writeHead(400).end();
        if (offset !== file.bytes.length) return json(res, 409, { received: file.bytes.length });
        if (body.length > MAX_PIECE || offset + body.length > file.size) return res.writeHead(413).end();
        file.bytes = Buffer.concat([file.bytes, body]);
        return json(res, 200, { received: file.bytes.length });
      }
      if (req.method === "GET" && tail === "/status") return json(res, 200, { size: file.size, received: file.bytes.length, done: file.done });
      if (req.method === "POST" && tail === "/done") {
        if (file.bytes.length !== file.size) return json(res, 409, { received: file.bytes.length });
        file.done = true;
        return json(res, 200, { size: file.size });
      }
      if (req.method === "GET" && !tail) {
        if (!file.done) return res.writeHead(404).end();
        return res.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.size }).end(file.bytes);
      }
      res.writeHead(405).end();
    });
    return true;
  }

  const relay = {
    network, records, mailboxes, files, sent,
    /** The newest numbers of each grain its servers reported (`grain_stats`), by slug. */
    stats,
    /** `(id, offset, bytes) => status | undefined`: answer a piece with this status instead (404 also drops the file). */
    filePutHook: null,
    handle,
    /** The endpoint clients dial. */
    endpoint: () => ({ url: `ws://127.0.0.1:${server.address().port}${path}`, cert_sha256: null }),
    /** The next frame of `type` a client sends. */
    next: (type) => new Promise((resolve) => awaited.push({ type, resolve })),
    /** Close every connection of `address` (its clients reconnect). */
    kick(address) {
      live(address).forEach((ws) => ws.terminate());
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(() => r()));
      if (own) await new Promise((r) => server.close(() => r()));
    },
  };
  if (own) return new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", () => resolve(relay)));
  return relay;
}
