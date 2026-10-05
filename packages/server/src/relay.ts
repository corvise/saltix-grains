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
  /** The Ed25519 secret of the address you write from — your grain's server key. It never leaves the process. */
  secret: Uint8Array;
  network: NetworkName;
  /** The X25519 secret users seal frames to you with; by default `serverMessagingSecret(secret)`. */
  messagingSecret?: Uint8Array;
  /** Events worth logging (no keys, no payloads). */
  log?: (level: "info" | "warn", event: string, meta?: Record<string, unknown>) => void;
  /** How long `send` waits for a connection, ms. */
  timeoutMs?: number;
}

/** A frame to your address, opened. `kept`: it came from a mailbox and was acknowledged. */
export interface RelayFrame {
  from: string;
  payload: Uint8Array;
  kept: boolean;
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
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w(new Error("relay client closed")));
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
    return list.filter(usableEndpoint).sort(() => Math.random() - 0.5);
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
          ping = setInterval(() => ws.ping(), PING_MS);
          this.log("info", "relay_registered", { url: endpoint.url, address: this.address });
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
          this.log("warn", "relay_lost", { url: endpoint.url });
          for (const address of [...this.asked.keys()]) this.answerKey(address, null, false);
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
      case "message":
        void this.onMessage(f);
        return;
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
    let payload: Uint8Array | null = null;
    try {
      const key = await this.keyOf(from);
      if (key) payload = openFrame(fromBase64Url(f.payload), key, this.messagingSecret);
    } catch {
      payload = null;
    }
    if (kept && this.ws) {
      const proof = toBase64Url(signMailboxAck(this.secret, f.msgId as string, Date.now()));
      this.write({ type: "message_ack", to: from, msgId: f.msgId, proof });
    }
    if (!payload) {
      this.log("warn", "relay_unopened", { from });
      return;
    }
    this.emit("frame", { from, payload, kept } satisfies RelayFrame);
  }
}
