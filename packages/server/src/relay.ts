import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import { ed25519 } from "@noble/curves/ed25519";
import { type NetworkName, accountId, encodeAddress } from "./address.js";
import { toHex } from "./bytes.js";
import { rpc } from "./node.js";
import {
  type KeyBinding, encodeAddressRecord, fromBase64Url, messagingKeyOf, signAddressRecord, signKeyBinding, signMailboxAck, toBase64Url,
} from "./records.js";
import { messagingPublic, openFrame, sealFrame, serverMessagingSecret } from "./seal.js";
import { type SignedGrainStats, encodeSignedGrainStats } from "./stats.js";

/** A relay's client endpoint as `relay_list` gives it: `cert_sha256` pins a self-signed certificate. */
export interface RelayEndpoint {
  url: string;
  cert_sha256: string | null;
}

export interface RelayOptions {
  /** Your node's wallet interface (plain HTTP: your own node or a tunnel): relays come from its `relay_list`. */
  node?: string;
  /** Or the endpoints to use, tried in random order. */
  endpoints?: RelayEndpoint[];
  /** More endpoints, asked before each round of relays (`ChatServer` asks the network's relays for the rest). */
  discover?: () => Promise<RelayEndpoint[]>;
  /** The Ed25519 secret of the address you write from — your grain's server key. It never leaves the process. */
  secret: Uint8Array;
  network: NetworkName;
  /** The X25519 secret users seal frames to you with; by default `serverMessagingSecret(secret)`. */
  messagingSecret?: Uint8Array;
  /** Events worth logging (no keys, no payloads). */
  log?: (level: "info" | "warn", event: string, meta?: Record<string, unknown>) => void;
  /** How long `send` waits for a connection, ms. */
  timeoutMs?: number;
  /**
   * When a kept frame leaves the mailbox: `"on_receipt"` (the default) acknowledges it as it arrives; `"by_handler"`
   * leaves it there until the `frame` event's `ack()`, so a frame your server took but had not finished with comes
   * again after a restart (`ChatServer` does this, and answers each request once).
   */
  ackKept?: "on_receipt" | "by_handler";
}

/** What a relay's node made of the numbers `reportStats` sent (Saltix 09-relay §3): taken, or why not. */
export type StatsOutcome = { taken: true; slug: string; at: number } | { taken: false; reason: string };

/** A frame to your address, opened. `kept`: it was kept in your mailbox. */
export interface RelayFrame {
  from: string;
  payload: Uint8Array;
  kept: boolean;
  /** The sender's id of the frame; null for a live one. */
  msgId: string | null;
  /** Take a kept frame off the mailbox with a signed proof (once; nothing for a live frame, or with `ackKept`
   *  `"on_receipt"`, which did it already). Without a connection it stays, and comes again on the next one. */
  ack(): void;
}

/** A file reserved next to the relay a client is registered at (09-relay §10.5): where its pieces go. */
export interface FileSlot {
  /** 16 bytes, base64url without padding. */
  id: string;
  /** The relay's endpoint: uploads go to its host and port, over its pinned certificate. */
  endpoint: RelayEndpoint;
}

/** A relay refused `file_new`: `detail` is `too_large`, `too_many`, `quota`, `full`, `unavailable`, or
 *  `payment_required` (the paid lane, which servers do not use yet). */
export class FileRefused extends Error {
  constructor(public readonly detail: string) {
    super(`the relay refused the file: ${detail}`);
    this.name = "FileRefused";
  }
}

/** What the relays take in a `message` payload: base64url of the sealed frame, at most 64 KiB (09-relay §3). */
const MAX_PAYLOAD_TEXT = 64 * 1024;
const KEY_TTL_MS = 10 * 60_000;
/** An address without a record may register any moment: ask again soon. */
const NO_KEY_TTL_MS = 30_000;
const KEY_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether the client dials `endpoint`: `wss://` (pinned by `cert_sha256`, or a CA's certificate), or plain `ws://` on loopback only. */
export function usableEndpoint(endpoint: RelayEndpoint): boolean {
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return false;
  }
  if (endpoint.cert_sha256 != null && !/^[0-9a-fA-F]{64}$/.test(endpoint.cert_sha256)) return false;
  return url.protocol === "wss:" || (url.protocol === "ws:" && LOOPBACK.has(url.hostname));
}

/**
 * Your grain server's connection to the relays (09-relay §3, 12-grains §5.4–5.5): registered under the
 * address of your server key with a record that key signs, it sends frames sealed to users' keys in
 * your grain — live, or kept in their mailboxes, which is how notifications reach a closed grain — and
 * hears frames sent to it (`frame` events). It reconnects by itself, to another relay when one fails.
 *
 * Your frames use the relay's free share (11-access §3); a paid lane for servers comes later.
 *
 * ```ts
 * const relay = await RelayClient.connect({ node: "http://127.0.0.1:30334", secret, network: "testnet" });
 * await relay.notify(userAddress, signNotification({ slug, title: "Your move", body: "", at: Date.now() }, secret, genesis, cert));
 * relay.on("frame", ({ from, payload }) => …);
 * ```
 */
export class RelayClient extends EventEmitter {
  /** The address frames come from. */
  readonly address: string;
  private readonly secret: Uint8Array;
  private readonly messagingSecret: Uint8Array;
  private readonly accountKey: Uint8Array;
  private readonly log: NonNullable<RelayOptions["log"]>;
  private ws: WebSocket | null = null;
  /** The connection being set up, closed with the client. */
  private dialing: WebSocket | null = null;
  /** Ends the pause between rounds of relays early, on `close`. */
  private wake: (() => void) | null = null;
  private closed = false;
  private binding: KeyBinding | null = null;
  /** A relay knew a later binding of ours: the next one is issued after this (Unix ms). */
  private bindingAfter = 0;
  private readonly keys = new Map<string, { key: Uint8Array | null; until: number }>();
  private readonly asked = new Map<string, { resolvers: Array<(key: Uint8Array | null) => void>; timer: NodeJS.Timeout }>();
  private waiters: Array<(error?: Error) => void> = [];
  /** The endpoint of the registered connection. */
  private current: RelayEndpoint | null = null;
  private readonly slots = new Map<string, { resolve: (slot: FileSlot) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** The newest numbers the app reported: sent again whenever the client registers. */
  private stats: SignedGrainStats | null = null;

  private constructor(private readonly options: RelayOptions) {
    super();
    if (options.secret.length !== 32) throw new TypeError("secret: 32 bytes");
    this.secret = options.secret;
    this.messagingSecret = options.messagingSecret ?? serverMessagingSecret(options.secret);
    this.accountKey = ed25519.getPublicKey(options.secret);
    this.address = encodeAddress(options.network, accountId(this.accountKey));
    this.log = options.log ?? (() => {});
  }

  /** Connect and register; resolves once a relay took the registration. */
  static async connect(options: RelayOptions): Promise<RelayClient> {
    const client = new RelayClient(options);
    void client.run();
    try {
      await client.ready();
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  }

  /** Resolves while registered at a relay; rejects after `timeoutMs` without one. */
  ready(): Promise<void> {
    if (this.ws) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error("relay client closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new Error("no relay took the registration in time"));
      }, this.options.timeoutMs ?? 15_000);
      const done = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      this.waiters.push(done);
    });
  }

  /** The checked messaging key of `address`, or null when no relay knows a valid record of it. */
  async keyOf(address: string): Promise<Uint8Array | null> {
    const known = this.keys.get(address);
    if (known && Date.now() < known.until) return known.key;
    await this.ready();
    return new Promise((resolve) => {
      const pending = this.asked.get(address);
      if (pending) {
        pending.resolvers.push(resolve);
        return;
      }
      const timer = setTimeout(() => this.answerKey(address, null, false), KEY_TIMEOUT_MS);
      this.asked.set(address, { resolvers: [resolve], timer });
      this.write({ type: "get_key", pubkey: address });
    });
  }

  /**
   * Seal `payload` to `to` (a user's key in your grain) and send it: live only, or with `keep` kept in
   * `to`'s mailbox until a wallet takes it. Throws when `to` has no valid record or no relay is reachable.
   */
  async send(to: string, payload: Uint8Array, options: { keep?: boolean } = {}): Promise<void> {
    const key = await this.keyOf(to);
    if (!key) throw new Error(`no messaging key for ${to}: its wallet has not registered it at a relay`);
    const sealed = toBase64Url(sealFrame(payload, key, this.messagingSecret));
    if (sealed.length > MAX_PAYLOAD_TEXT) throw new RangeError("payload too large for a relay frame");
    await this.ready();
    const msgId = toHex(randomBytes(16));
    this.write({ type: "message", to, payload: sealed, msgId, ...(options.keep ? {} : { ephemeral: true }) });
  }

  /** The endpoint of the relay this client is registered at, or null between connections. */
  get endpoint(): RelayEndpoint | null {
    return this.current;
  }

  /**
   * Reserve an upload of `size` bytes of ciphertext next to the relay (`file_new`, 09-relay §10.5): resolves with the
   * file's id and the endpoint to send its pieces to; rejects with `FileRefused` when the relay says no.
   */
  async reserveFile(size: number): Promise<FileSlot> {
    await this.ready();
    const ref = toHex(randomBytes(8));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.answerSlot(ref, new Error("the relay did not answer file_new in time")), this.options.timeoutMs ?? 15_000);
      this.slots.set(ref, { resolve: (slot) => resolve(slot), reject, timer });
      try {
        this.write({ type: "file_new", size, ref });
      } catch (e) {
        this.answerSlot(ref, e as Error);
        return;
      }
    });
  }

  /**
   * Hand the app's newest signed numbers (`signGrainStats`, 24-app-studio §6a) to the relay (`grain_stats`, Saltix
   * 09-relay §3): its node checks them against the registry and gossips them, so every node answers `grain_stats` for
   * the marketplace and the explorer. Kept and sent again whenever the client registers, at this relay or another; the
   * `stats` event says what the node made of them. Nothing goes on chain.
   */
  reportStats(signed: SignedGrainStats): void {
    this.stats = signed;
    if (this.ws) this.sendStats(this.ws, signed);
  }

  private sendStats(ws: WebSocket, signed: SignedGrainStats): void {
    ws.send(JSON.stringify({ type: "grain_stats", stats: toBase64Url(encodeSignedGrainStats(signed)) }));
  }

  /** Send a notification (`signNotification`'s bytes) to `to`: kept, so it reaches the wallet with the grain closed. */
  notify(to: string, signedNotification: Uint8Array): Promise<void> {
    return this.send(to, signedNotification, { keep: true });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.dialing?.terminate();
    this.wake?.();
    for (const address of [...this.asked.keys()]) this.answerKey(address, null, false);
    for (const ref of [...this.slots.keys()]) this.answerSlot(ref, new Error("relay client closed"));
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w(new Error("relay client closed")));
  }

  private answerSlot(ref: string, outcome: FileSlot | Error): void {
    const pending = this.slots.get(ref);
    if (!pending) return;
    this.slots.delete(ref);
    clearTimeout(pending.timer);
    if (outcome instanceof Error) pending.reject(outcome);
    else pending.resolve(outcome);
  }

  private write(frame: object): void {
    if (!this.ws) throw new Error("not connected to a relay");
    this.ws.send(JSON.stringify(frame));
  }

  private answerKey(address: string, key: Uint8Array | null, cache: boolean): void {
    if (cache) this.keys.set(address, { key, until: Date.now() + (key ? KEY_TTL_MS : NO_KEY_TTL_MS) });
    const pending = this.asked.get(address);
    if (!pending) return;
    this.asked.delete(address);
    clearTimeout(pending.timer);
    pending.resolvers.forEach((resolve) => resolve(key));
  }

  private async endpoints(): Promise<RelayEndpoint[]> {
    let list = this.options.endpoints ?? [];
    if (this.options.node) {
      try {
        const { relays } = await rpc<{ relays: Array<{ endpoints: RelayEndpoint[] }> }>(this.options.node, "relay_list");
        list = [...list, ...relays.flatMap((r) => r.endpoints)];
      } catch (e) {
        this.log("warn", "relay_list_failed", { reason: (e as Error).message });
      }
    }
    if (this.options.discover) {
      try {
        list = [...list, ...(await this.options.discover())];
      } catch (e) {
        this.log("warn", "relay_list_failed", { reason: (e as Error).message });
      }
    }
    // One entry an endpoint, the latest source's pin winning: a relay record is fresher than a list given at start.
    const byUrl = new Map<string, RelayEndpoint>();
    for (const e of list.filter(usableEndpoint)) byUrl.set(e.url, e);
    return [...byUrl.values()].sort(() => Math.random() - 0.5);
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      for (const endpoint of await this.endpoints()) {
        if (this.closed) return;
        const registered = await this.session(endpoint).catch((e: Error) => {
          this.log("warn", "relay_failed", { url: endpoint.url, reason: e.message });
          return false;
        });
        if (registered) failures = 0;
        if (this.closed) return;
      }
      failures++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** One connection: resolves when it ends, with whether it registered. */
  private session(endpoint: RelayEndpoint): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const pinned = endpoint.cert_sha256?.toLowerCase() ?? null;
      const ws = new WebSocket(endpoint.url, { rejectUnauthorized: pinned === null, handshakeTimeout: 10_000, maxPayload: 512 * 1024 });
      this.dialing = ws;
      let trusted = !endpoint.url.startsWith("wss:") || pinned === null;
      let registered = false;
      let ping: NodeJS.Timeout | undefined;
      ws.on("upgrade", (response: IncomingMessage) => {
        if (pinned === null) return;
        const raw = (response.socket as TLSSocket).getPeerCertificate?.()?.raw;
        trusted = !!raw && createHash("sha256").update(raw).digest("hex") === pinned;
        if (!trusted) {
          ws.terminate();
          reject(new Error("certificate does not match the relay record"));
        }
      });
      ws.on("message", (data) => {
        if (!trusted) return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        const r = this.onFrame(ws, frame, endpoint);
        if (r === "registered") {
          registered = true;
          this.dialing = null;
          this.ws = ws;
          this.current = endpoint;
          ping = setInterval(() => ws.ping(), PING_MS);
          this.log("info", "relay_registered", { url: endpoint.url, address: this.address });
          if (this.stats) this.sendStats(ws, this.stats);
          const waiters = this.waiters;
          this.waiters = [];
          waiters.forEach((w) => w());
        } else if (r instanceof Error) {
          ws.close();
          reject(r);
        }
      });
      ws.on("error", (e) => {
        if (!registered) reject(e);
      });
      ws.on("close", () => {
        clearInterval(ping);
        if (this.dialing === ws) this.dialing = null;
        if (this.ws === ws) {
          this.ws = null;
          this.current = null;
          this.log("warn", "relay_lost", { url: endpoint.url });
          for (const address of [...this.asked.keys()]) this.answerKey(address, null, false);
          // A reservation is the connection's: one whose answer did not come is not coming.
          for (const ref of [...this.slots.keys()]) this.answerSlot(ref, new Error("the relay connection was lost"));
        }
        resolve(registered);
      });
    });
  }

  /** Handle one frame from the relay; `"registered"` or an Error for the connection's outcome. */
  private onFrame(ws: WebSocket, f: Record<string, unknown>, endpoint: RelayEndpoint): "registered" | Error | void {
    switch (f.type) {
      case "hello": {
        if (f.network !== this.options.network) return new Error(`the relay is on ${String(f.network)}, not ${this.options.network}`);
        const nonce = fromBase64Url(String(f.nonce));
        const relay = fromBase64Url(String(f.relay));
        const sts = Number(f.sts);
        if (nonce.length !== 16 || relay.length !== 32 || !Number.isSafeInteger(sts)) return new Error("malformed hello");
        this.register(ws, relay, nonce, sts);
        return;
      }
      case "registered":
        return "registered";
      case "error": {
        if (f.message === "auth_failed" && f.detail === "stale" && this.binding) {
          // The relays know a later binding of ours (another relay's clock was ahead): sign one after it.
          this.bindingAfter = Math.max(Number(f.keyIssuedAt ?? 0), Number(f.issuedAt ?? 0), this.binding.issuedAt) + 1;
          this.binding = null;
          this.log("info", "relay_stale", { url: endpoint.url });
          return new Error("stale registration: signing a later binding");
        }
        if ((f.message === "file_refused" || f.message === "payment_required") && typeof f.ref === "string" && this.slots.has(f.ref)) {
          this.answerSlot(f.ref, new FileRefused(f.message === "file_refused" ? String(f.detail) : "payment_required"));
          return;
        }
        this.log("warn", "relay_error", { url: endpoint.url, message: f.message, detail: f.detail });
        if (f.message === "auth_failed") return new Error(`registration refused: ${String(f.detail)}`);
        this.emit("relayError", { message: f.message, detail: f.detail });
        return;
      }
      case "key_response": {
        const address = String(f.pubkey);
        if (!this.asked.has(address)) return;
        this.answerKey(address, messagingKeyOf(address, f.record as string | null, Date.now(), this.options.network), true);
        return;
      }
      case "file_slot": {
        if (typeof f.ref !== "string" || !this.slots.has(f.ref)) return;
        const id = String(f.id);
        if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return this.answerSlot(f.ref, new Error("the relay answered file_new with a malformed id"));
        this.answerSlot(f.ref, { id, endpoint });
        return;
      }
      case "message":
        void this.onMessage(f);
        return;
      case "grain_stats_taken": {
        const outcome: StatsOutcome = { taken: true, slug: String(f.slug), at: Number(f.at) };
        this.log("info", "relay_stats_taken", { url: endpoint.url, slug: outcome.slug, at: outcome.at });
        this.emit("stats", outcome);
        return;
      }
      case "grain_stats_refused": {
        const outcome: StatsOutcome = { taken: false, reason: String(f.reason) };
        this.log("warn", "relay_stats_refused", { url: endpoint.url, reason: outcome.reason });
        this.emit("stats", outcome);
        return;
      }
    }
  }

  private register(ws: WebSocket, relay: Uint8Array, nonce: Uint8Array, sts: number): void {
    if (!this.binding) this.binding = signKeyBinding(this.secret, messagingPublic(this.messagingSecret), Math.max(sts, this.bindingAfter));
    const issuedAt = Math.max(sts, this.binding.issuedAt);
    const record = signAddressRecord(this.secret, this.binding, relay, nonce, issuedAt);
    ws.send(JSON.stringify({ type: "register", record: toBase64Url(encodeAddressRecord(record)) }));
  }

  private async onMessage(f: Record<string, unknown>): Promise<void> {
    if (f.to !== this.address || typeof f.from !== "string" || typeof f.payload !== "string") return;
    const from = f.from;
    const kept = f.ephemeral !== true && typeof f.msgId === "string";
    const msgId = typeof f.msgId === "string" ? f.msgId : null;
    let payload: Uint8Array | null = null;
    try {
      const key = await this.keyOf(from);
      if (key) payload = openFrame(fromBase64Url(f.payload), key, this.messagingSecret);
    } catch {
      payload = null;
    }
    let acked = false;
    const ack = () => {
      if (!kept || acked || !this.ws) return;
      acked = true;
      const proof = toBase64Url(signMailboxAck(this.secret, msgId!, Date.now()));
      this.write({ type: "message_ack", to: from, msgId, proof });
    };
    // What does not open is nobody's to handle: it leaves the mailbox now.
    if (!payload || this.options.ackKept !== "by_handler") ack();
    if (!payload) {
      this.log("warn", "relay_unopened", { from });
      return;
    }
    this.emit("frame", { from, payload, kept, msgId, ack } satisfies RelayFrame);
  }
}
