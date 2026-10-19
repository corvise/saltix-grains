// `@saltix/grain-server/dev`: a network on one computer for development and tests, with no node.
//
// - `createDevRelay`: the part of a Saltix relay (09-relay §3, §10.5) a grain's server and a wallet use. It checks address
//   records as relays do (this relay, this connection's challenge, the time, the signatures), forwards frames with
//   `from`, keeps kept frames in the addressee's mailbox until a signed ack (and delivers them again on the next
//   registration), keeps files (`file_new`, then `PUT /_file/<id>` with `X-Offset`, `GET …/status`, `POST …/done`,
//   `GET /_file/<id>`) and an app's numbers (`grain_stats`, the newest of each grain). Plain `ws://` and `http://`:
//   loopback only.
// - `createDevRegistry`: what a node's wallet interface says of one grain (`node_status`, `grain_get`, `account_get`,
//   `relay_list`): its owner, server keys, access and team, changed in place, each change a new beacon block; and a node's
//   named blobs (`blob_put`, `blob_get`, 32-images §7–§8) as the node takes them: an icon the registry names, a bundle in
//   pieces, named or held pending on a registered server key's statement, refused with the node's reasons.
//
//   const relay = await createDevRelay();                   // its own server on 127.0.0.1, a free port
//   const relay = createDevRelay({ server, path: "/relay" }) // or beside your routes: call relay.handle(req, res)
//
// Development keys only: nothing here is a network anyone else uses.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { type WebSocket, WebSocketServer } from "ws";
import { ed25519 } from "@noble/curves/ed25519";
import { type NetworkName, accountId, encodeAddress } from "./address.js";
import { Reader, derive, fromBase64, fromHex, toBase64, toHex } from "./bytes.js";
import { verifyEd25519 } from "./keys.js";
import { bundleUploadNames, bundleUploadProblem, decodeSignedBundleUpload, pendingUntil } from "./bundle-upload.js";
import { BLOB_PIECE, NAMED_KINDS, type NamedKind, NO_ICON, namedHash, namedProblem } from "./named.js";
import { RpcError } from "./node.js";
import type { Controller } from "./member.js";
import { type Manifest, type SignedManifest, signManifest } from "./manifest.js";
import { decodeAddressRecord, fromBase64Url, recordProblem, toBase64Url } from "./records.js";
import type { RegisteredGrain } from "./registry.js";
import type { RelayEndpoint } from "./relay.js";
import { type SignedGrainStats, decodeSignedGrainStats, encodeSignedGrainStats } from "./stats.js";

const MAX_FILE = 50 * 1024 * 1024 + 16;
const MAX_PIECE = 1024 * 1024;
const SKEW_MS = 10 * 60_000;

/** A frame as the relay's clients send and get it (09-relay §3): JSON with a `type`. */
export type DevFrame = { type: string } & Record<string, unknown>;

interface Session extends WebSocket {
  address?: string;
}

interface DevFile {
  size: number;
  bytes: Buffer;
  done: boolean;
}

export interface DevRelay {
  network: NetworkName;
  /** Address records by address, as registered (base64url). */
  records: Map<string, string>;
  /** Kept frames not yet acknowledged, by address and message id. */
  mailboxes: Map<string, Map<string, DevFrame>>;
  files: Map<string, DevFile>;
  /** Every frame clients sent, in order. */
  sent: DevFrame[];
  /** The newest numbers of each grain its servers reported (`grain_stats`), by slug. */
  stats: Map<string, SignedGrainStats>;
  /** `(id, offset, bytes) => status | undefined`: answer a piece with this status instead (404 also drops the file). */
  filePutHook: ((id: string, offset: number, bytes: number) => number | undefined) | null;
  /** The file routes on the relay's port: true when it answered. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** The endpoint clients dial. */
  endpoint(): RelayEndpoint;
  /** The next frame of `type` a client sends. */
  next(type: string): Promise<DevFrame>;
  /** Close every connection of `address` (its clients reconnect). */
  kick(address: string): void;
  close(): Promise<void>;
}

/** A relay on its own server (127.0.0.1, `port` or a free one), or beside `server`'s routes at `path`. */
export function createDevRelay(options?: { network?: NetworkName; port?: number }): Promise<DevRelay>;
export function createDevRelay(options: { network?: NetworkName; server: Server; path?: string }): DevRelay;
export function createDevRelay(options: { network?: NetworkName; port?: number; server?: Server; path?: string } = {}): DevRelay | Promise<DevRelay> {
  const network = options.network ?? "devnet";
  const path = options.path ?? "/relay";
  const relayKey = new Uint8Array(32).fill(9);
  const records = new Map<string, string>();
  const sessions = new Map<string, Set<Session>>();
  const mailboxes = new Map<string, Map<string, DevFrame>>();
  const files = new Map<string, DevFile>();
  const stats = new Map<string, SignedGrainStats>();
  const sent: DevFrame[] = [];
  const awaited: Array<{ type: string; resolve: (f: DevFrame) => void }> = [];
  const own = !options.server;
  const server: Server = options.server ?? createServer((req, res) => {
    if (!handle(req, res)) res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path });

  const send = (ws: WebSocket, frame: object) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
  };
  const live = (address: string): Session[] => [...(sessions.get(address) ?? [])];
  const mailbox = (address: string): Map<string, DevFrame> => {
    if (!mailboxes.has(address)) mailboxes.set(address, new Map());
    return mailboxes.get(address)!;
  };

  wss.on("connection", (ws: Session) => {
    const nonce = randomBytes(16);
    const sts = Date.now();
    send(ws, { type: "hello", nonce: toBase64Url(nonce), sts, relay: toBase64Url(relayKey), network, prices: { frame: "0", file_mib: "0", turn_kib: "0" } });
    ws.on("close", () => {
      if (ws.address) sessions.get(ws.address)?.delete(ws);
    });
    ws.on("message", (data) => {
      let f: DevFrame;
      try {
        f = JSON.parse(data.toString()) as DevFrame;
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
          return send(ws, { type: "key_response", pubkey: f.pubkey, record: records.get(String(f.pubkey)) ?? null, encryptKey: null, managed: null, log: null });
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
  function grainStats(ws: Session, f: DevFrame) {
    let signed: SignedGrainStats;
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

  function register(ws: Session, f: DevFrame, nonce: Uint8Array, sts: number) {
    let r;
    try {
      r = decodeAddressRecord(fromBase64Url(String(f.record)));
    } catch {
      return send(ws, { type: "error", message: "auth_failed", detail: "malformed" });
    }
    const ok = recordProblem(r, Date.now()) === null && toHex(r.relay) === toHex(relayKey) && toHex(r.nonce) === toHex(nonce) &&
      Math.abs(r.issuedAt - sts) <= SKEW_MS;
    if (!ok) return send(ws, { type: "error", message: "auth_failed", detail: "invalid" });
    const address = encodeAddress(network, accountId(r.key.accountKey));
    records.set(address, String(f.record));
    ws.address = address;
    if (!sessions.has(address)) sessions.set(address, new Set());
    sessions.get(address)!.add(ws);
    send(ws, { type: "registered", pubkey: address, keyEpoch: r.key.keyEpoch, turn: null });
    // The mailbox: every kept frame not yet acknowledged.
    for (const frame of mailbox(address).values()) send(ws, frame);
  }

  function message(ws: Session, f: DevFrame) {
    if (typeof f.to !== "string" || typeof f.payload !== "string" || typeof f.msgId !== "string") {
      return send(ws, { type: "error", message: "bad_frame", detail: "message" });
    }
    if (f.payload.length > 64 * 1024) return send(ws, { type: "error", message: "payload_too_large" });
    const frame: DevFrame = { type: "message", to: f.to, from: ws.address, payload: f.payload, msgId: f.msgId, sts: Date.now(), ...(f.ephemeral ? { ephemeral: true } : {}) };
    if (!f.ephemeral) mailbox(f.to).set(f.msgId, frame);
    const to = live(f.to);
    to.forEach((peer) => send(peer, frame));
    if (to.length === 0 && f.ephemeral) send(ws, { type: "peer-offline", pubkey: f.to, reason: "message" });
  }

  function ack(ws: Session, f: DevFrame) {
    // The proof: Borsh {account key, msgId, at, device: None} and its signature, by the acknowledging address's key.
    try {
      const proof = fromBase64Url(String(f.proof));
      const body = proof.subarray(0, proof.length - 64);
      const r = new Reader(body);
      const key = r.fixed(32);
      const msgId = r.string(256);
      r.u64();
      if (r.u8() !== 0) throw new Error("device");
      r.end();
      const signed = verifyEd25519(key, derive("Saltix mailbox ack v1", body), proof.subarray(proof.length - 64));
      if (!signed || msgId !== f.msgId || encodeAddress(network, accountId(key)) !== ws.address) throw new Error("proof");
    } catch {
      return send(ws, { type: "error", message: "bad_proof" });
    }
    mailbox(ws.address!).delete(String(f.msgId));
  }

  function fileNew(ws: Session, f: DevFrame) {
    const size = f.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE) {
      return send(ws, { type: "error", message: "file_refused", detail: "too_large", ref: f.ref ?? null });
    }
    const id = toBase64Url(randomBytes(16));
    files.set(id, { size, bytes: Buffer.alloc(0), done: false });
    send(ws, { type: "file_slot", id, ref: f.ref ?? null });
  }

  const json = (res: ServerResponse, status: number, body: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const m = /^\/_file\/([A-Za-z0-9_-]{22})(\/status|\/done)?$/.exec((req.url ?? "").split("?")[0]!);
    if (!m) return false;
    const [, id, tail] = m as unknown as [string, string, string | undefined];
    const file = files.get(id);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (!file) return res.writeHead(404).end();
      if (req.method === "PUT" && !tail) {
        const offset = Number(req.headers["x-offset"]);
        const body = Buffer.concat(chunks);
        const fault = relay.filePutHook?.(id, offset, body.length);
        if (fault) {
          if (fault === 404) files.delete(id);
          return res.writeHead(fault).end();
        }
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

  const relay: DevRelay = {
    network, records, mailboxes, files, sent, stats,
    filePutHook: null,
    handle,
    endpoint: () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return { url: `ws://127.0.0.1:${port}${path}`, cert_sha256: null };
    },
    next: (type) => new Promise((resolve) => awaited.push({ type, resolve })),
    kick(address) {
      live(address).forEach((ws) => ws.terminate());
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      if (own) await new Promise<void>((r) => server.close(() => r()));
    },
  };
  if (own) return new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", () => resolve(relay)));
  return relay;
}

/** A member of a development grain's team or users: an account (hex) and its roles (`ROLES`). */
export interface DevMember {
  account: string;
  roles: number;
}

/** What a development registry starts with. */
export interface DevRegistryOptions {
  slug: string;
  /** The network's genesis hash (hex, 32 bytes): random by default. */
  genesis?: string;
  network?: NetworkName;
  /** The owner's account key (an Ed25519 secret): it signs the chat-only manifest the registry holds. */
  ownerSecret: Uint8Array;
  /** The server keys the registry names (hex), the first one first. */
  servers: string[];
  /** Public (the default) or private. */
  public?: boolean;
  members?: DevMember[];
  /** The relays `relay_list` names: endpoints of one relay, or relays with their node keys and the space they offer. */
  relays?: RelayEndpoint[] | DevRelayEntry[];
  /** The manifest's name (`{ en }`), the slug by default. */
  name?: string;
  /** The protocol version `node_status` names (23-upgrades §6): 1 by default, as the test network runs. */
  protocol?: number;
  /** False: nobody registered the slug yet, until `publish` (a wallet's `RegisterGrain`). */
  registered?: boolean;
  /** The clock statements are checked against (Unix ms). */
  now?: () => number;
}

/** A relay as `relay_list` names it. */
export interface DevRelayEntry {
  key: string;
  endpoints: RelayEndpoint[];
  /** The space it offers for bundles and fragments, GiB (relay record v3), or null. */
  store_gib: number | null;
}

/** A blob the development node holds. */
export interface DevBlob {
  kind: NamedKind;
  bytes: Uint8Array;
  /** Until when it is held on a statement's word while no manifest names it (Unix ms), or null. */
  pendingUntil: number | null;
}

export interface DevRegistry {
  /** The wallet interface a `ChatServer` (or the command line, `NodeLike`) reads: `node_status`, `grain_get`,
   *  `account_get`, `relay_list`. */
  call<T>(method: string, params?: object): Promise<T>;
  readonly genesis: string;
  readonly network: NetworkName;
  /** The grain's record as the registry holds it now: change it with the methods below, or in place and `block()`. */
  readonly grain: RegisteredGrain;
  /** Accounts' controllers (a managed account's devices), by account hex; none: only the account's own key speaks. */
  readonly controllers: Map<string, Controller>;
  /** Calls by method. */
  readonly calls: Record<string, number>;
  /** A new beacon block: what the registry holds may have changed. */
  block(): void;
  /** Public or private, with its members (accounts and roles), at a new block. */
  setAccess(open: boolean, members: DevMember[]): void;
  /** The server keys the registry names, at a new block: `[]` revokes them all. */
  setServers(servers: string[]): void;
  /** Retire the grain at a new block. */
  retire(): void;
  /** The owner's wallet registers or updates the grain with `signed` (`RegisterGrain`, `UpdateGrain`), at a new block. */
  publish(signed: SignedManifest): void;
  /** The blobs the node holds, by hash. */
  readonly blobs: Map<string, DevBlob>;
  /** Bundles' uploads under way, by hash: the bytes the node holds of each. */
  readonly uploads: Map<string, { size: number; received: number }>;
  /** Answer a `blob_put` with this refusal instead (`{reason, received?}`), or let it through (undefined). */
  blobPutHook: ((params: Record<string, unknown>) => { reason: string; received?: number } | undefined) | null;
}

/** `value` with every object's keys sorted, as a node's wallet interface writes its JSON: a reader that compares what it
 *  sent with what the registry holds compares the canonical form, never JSON text. */
function keysSorted<T>(value: T): T {
  if (Array.isArray(value)) return value.map(keysSorted) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, keysSorted((value as Record<string, unknown>)[k])])) as T;
}

/** A registry of one grain, as a node's wallet interface shows it, for development and tests. */
export function createDevRegistry(o: DevRegistryOptions): DevRegistry {
  const network = o.network ?? "devnet";
  const genesis = o.genesis ?? toHex(randomBytes(32));
  const ownerKey = toHex(ed25519.getPublicKey(o.ownerSecret));
  const owner = toHex(accountId(ed25519.getPublicKey(o.ownerSecret)));
  const manifest: Manifest = {
    slug: o.slug, version: 1, owner, owner_key: { ed25519: ownerKey }, name: { en: o.name ?? o.slug }, description: {},
    icon: "00".repeat(32), entry: { chat: {} }, permissions: 4, sponsor: null, min_host: 1,
  };
  const signed: SignedManifest = signManifest(manifest, o.ownerSecret);
  let height = 1;
  let registered = o.registered ?? true;
  const now = o.now ?? Date.now;
  const blobs = new Map<string, DevBlob>();
  const uploads = new Map<string, { size: number; parts: Uint8Array[]; received: number }>();
  /** Until when a statement holds each bundle being uploaded on its word. */
  const pendingFor = new Map<string, number>();
  const grain: RegisteredGrain = {
    slug: o.slug, owner, version: 1, id: toHex(randomBytes(32)), registered: 1,
    updated: 1, retired: null, deposit: "10000000000", manifest: signed, servers: [...o.servers], category: 9, public: o.public ?? true,
    members: [...(o.members ?? [])], handles: [], ratings: { count: 0, sum: 0, citizens_count: 0, citizens_sum: 0 },
  };
  const controllers = new Map<string, Controller>();
  const calls: Record<string, number> = {};
  const status = () => ({
    network, genesis, genesis_time: Math.floor(now() / 1000) - height, slot: height,
    beacon: { height, hash: height.toString(16).padStart(64, "0") },
    shards: [{ shard: "", hash: (height + 0x8000).toString(16).padStart(64, "0") }],
    protocol: { version: o.protocol ?? 1, supported: [1, 2], next: null, outdated: null },
  });
  const relayList = (): DevRelayEntry[] => {
    const given = o.relays ?? [];
    if (given.length > 0 && "endpoints" in given[0]!) return given as DevRelayEntry[];
    return [{ key: "00".repeat(32), endpoints: given as RelayEndpoint[], store_gib: null }];
  };
  /** What the canonical registry names: the live grain's icon and sealed bundle. */
  const live = () => (registered && grain.retired === null ? grain.manifest?.manifest ?? null : null);
  const named = (kind: NamedKind, hash: string, size?: number): boolean => {
    const m = live();
    if (m === null) return false;
    if (kind === "grain_icon") return m.icon !== NO_ICON && m.icon === hash;
    return kind === "grain_bundle" && "sealed" in m.entry && m.entry.sealed.bundle === hash && (size === undefined || m.entry.sealed.size === size);
  };
  const refused = (what: string, reason: string, received?: number): never => {
    throw new RpcError("blob_put", -32602, `the ${what} is refused: ${reason}`, received === undefined ? { reason } : { reason, received });
  };
  /** `blob_put` as a node answers it (32-images §7.1, §7.3). */
  const blobPut = (p: Record<string, unknown>): Record<string, unknown> => {
    const kind = p.kind as NamedKind;
    if (kind !== "grain_icon" && kind !== "grain_bundle") return refused("image", "kind");
    const hook = registry.blobPutHook?.(p);
    if (hook) return refused(kind === "grain_bundle" ? "bundle" : "image", hook.reason, hook.received);
    let data: Uint8Array;
    try {
      data = fromBase64(String(p.data));
    } catch {
      throw new RpcError("blob_put", -32602, "data: the bytes in base64");
    }
    if (kind === "grain_icon") {
      if (data.length === 0 || data.length > NAMED_KINDS.grain_icon.maxBytes) return refused("image", "size");
      const hash = namedHash(kind, data);
      if (!named(kind, hash)) return refused("image", "not_named");
      const problem = namedProblem(kind, data);
      if (problem) return refused("image", problem);
      blobs.set(hash, { kind, bytes: data, pendingUntil: null });
      return { kind, hash, kept: true };
    }
    const hash = String(p.hash);
    const size = Number(p.size);
    const from = Number(p.from ?? 0);
    if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(size) || !Number.isSafeInteger(from)) {
      throw new RpcError("blob_put", -32602, "hash, size and from: the bundle's");
    }
    if (size === 0 || size > NAMED_KINDS.grain_bundle.maxBytes || data.length > BLOB_PIECE) return refused("bundle", "size");
    const isNamed = named(kind, hash, size);
    if (p.upload !== undefined && p.upload !== null && !isNamed) {
      let statement;
      try {
        statement = decodeSignedBundleUpload(fromHex(String(p.upload)));
      } catch {
        throw new RpcError("blob_put", -32602, "upload: hex of a SignedBundleUpload");
      }
      const servers = registered && grain.retired === null && statement.upload.slug === grain.slug ? grain.servers ?? [] : null;
      const problem = bundleUploadNames(statement, hash, size) ?? bundleUploadProblem(statement, genesis, servers, now());
      if (problem) return refused("bundle", problem);
      const held = blobs.get(hash);
      if (held) {
        // Held already: the statement extends what holds it.
        held.pendingUntil = Math.max(held.pendingUntil ?? 0, pendingUntil(statement.upload));
        uploads.delete(hash);
        return { kind, hash, received: size, kept: true, pending: !isNamed };
      }
      pendingFor.set(hash, pendingUntil(statement.upload));
    } else if (!isNamed && !blobs.has(hash)) {
      return refused("bundle", "not_named");
    }
    const held = blobs.get(hash);
    if (held) {
      uploads.delete(hash);
      return { kind, hash, received: size, kept: true, pending: !isNamed && held.pendingUntil !== null };
    }
    let upload = uploads.get(hash);
    if (!upload) {
      if (from !== 0) return refused("bundle", "offset", 0);
      upload = { size, parts: [], received: 0 };
      uploads.set(hash, upload);
    } else if (upload.size !== size || from !== upload.received) {
      return refused("bundle", "offset", upload.received);
    }
    if (upload.received + data.length > size) return refused("bundle", "offset", upload.received);
    upload.parts.push(data);
    upload.received += data.length;
    if (upload.received < size) return { kind, hash, received: upload.received, kept: false };
    uploads.delete(hash);
    const whole = new Uint8Array(size);
    let at = 0;
    for (const part of upload.parts) {
      whole.set(part, at);
      at += part.length;
    }
    if (namedHash(kind, whole) !== hash) return refused("bundle", "hash");
    const problem = namedProblem(kind, whole);
    if (problem) return refused("bundle", problem);
    blobs.set(hash, { kind, bytes: whole, pendingUntil: isNamed ? null : pendingFor.get(hash) ?? null });
    return { kind, hash, received: size, kept: true, pending: !isNamed };
  };
  /** `blob_get` as a node answers it (32-images §8.1). */
  const blobGet = (p: Record<string, unknown>): Record<string, unknown> => {
    const kind = p.kind as NamedKind;
    const hash = String(p.hash);
    const held = blobs.get(hash);
    if (!held || held.kind !== kind) return { blob: null, fetching: false };
    const from = Number(p.from ?? 0);
    const len = Math.min(Number(p.len ?? 1 << 20), 1 << 20);
    if (kind !== "grain_bundle") return { blob: { kind, hash, type: NAMED_KINDS[kind].type, size: held.bytes.length, from: 0, data: toBase64(held.bytes) }, fetching: false };
    if (from >= held.bytes.length) throw new RpcError("blob_get", -32602, "from: past the bundle's end");
    const piece = held.bytes.subarray(from, from + len);
    return { blob: { kind, hash, type: NAMED_KINDS[kind].type, size: held.bytes.length, from, data: toBase64(piece) }, fetching: false };
  };
  const registry: DevRegistry = {
    genesis, network, grain, controllers, calls, blobs, blobPutHook: null,
    get uploads() {
      return new Map([...uploads].map(([hash, u]) => [hash, { size: u.size, received: u.received }]));
    },
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls[method] = (calls[method] ?? 0) + 1;
      switch (method) {
        case "node_status":
          return status() as T;
        case "grain_get":
          // As a node answers: the record's objects with their keys sorted (the manifest's too), never grain.json's order.
          return { grain: params.slug === o.slug && registered ? keysSorted(structuredClone(grain)) : null, deposit: "10000000000" } as T;
        case "account_get": {
          const account = String(params.address);
          return { account, shard: "", nonce: 0, salt: "0", work: "0", channels: [], controller: controllers.get(account) ?? null } as T;
        }
        case "relay_list":
          return { relays: relayList() } as T;
        case "blob_put":
          return blobPut(params) as T;
        case "blob_get":
          return blobGet(params) as T;
        default:
          throw new Error(`the development registry does not answer ${method}`);
      }
    },
    block() {
      height++;
      grain.updated = height;
    },
    setAccess(open, members) {
      grain.public = open;
      grain.members = members.map((m) => ({ account: m.account, roles: m.roles }));
      registry.block();
    },
    setServers(servers) {
      grain.servers = [...servers];
      registry.block();
    },
    retire() {
      grain.retired = height + 1;
      registry.block();
    },
    publish(next) {
      const m = next.manifest;
      if (m.slug !== grain.slug) throw new Error(`the development registry holds ${grain.slug}, not ${m.slug}`);
      if (registered && m.version <= grain.version) throw new Error(`version ${grain.version} is registered`);
      if (!registered) {
        registered = true;
        grain.registered = height + 1;
      }
      grain.manifest = next;
      grain.version = m.version;
      grain.owner = m.owner;
      // A bundle held pending is kept as any named one from now on.
      for (const blob of blobs.values()) if (blob.kind === "grain_bundle" && "sealed" in m.entry && namedHash(blob.kind, blob.bytes) === m.entry.sealed.bundle) blob.pendingUntil = null;
      registry.block();
    },
  };
  return registry;
}
