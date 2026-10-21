// The wallet's answer to a Connect offer (Saltix 19-connect §4–§5): `ConnectSeen`, then a `ConnectReply` naming where
// the page confirms (§14.2), then a `ConnectGrant` — a `ConnectLogin` naming this page's network, origin, slot and
// session key, signed by a key of the account. The page takes a grant only when every rule of §5 holds, and then
// answers the reply with a `ConnectConfirm`, which a wallet takes only for the login it sent; `saltix-types` `connect`
// has the same checks, and vectors/connect-v1.json pins both to the same bytes and reasons. A port of the explorer's
// own.
import {
  type AccountPolicy, type CheckedLog, type DeviceKey, Reader, Writer, derive, keySpeaksFor, readDeviceKey, verifyByDeviceKey, toHex,
  writeDeviceKey,
} from "@saltix/grain-server/web";
import { equal } from "./codec.js";

export const LOGIN_DOMAIN = "Saltix connect login v1";
export const GRANT_VERSION = 1;
export const SEEN_TAG = 0;
/** A `ConnectReply`'s first byte: where the page confirms (19-connect §14.2). */
export const REPLY_TAG = 2;
/** A `ConnectConfirm`'s first byte. */
export const CONFIRM_VERSION = 1;
/** How long a wallet tries to deliver a grant in all (§14.3). */
export const CONNECT_DELIVERY_MS = 30_000;
/** How long a wallet waits for the page's confirmation once the grant was delivered (§14.3). */
export const CONNECT_CONFIRM_MS = 10_000;
/** How long the page waits for the relay's `link_delivered` of its confirmation before it closes its slot (§14.2). */
export const CONFIRM_DELIVERED_MS = 5_000;
/** How far a login's `at` may be from the page's clock. */
export const CONNECT_SKEW_MS = 10 * 60_000;
/** How long the page keeps a grant. */
export const CONNECT_LIFE_MS = 30 * 24 * 60 * 60_000;
/** An origin in a login is at most this long; the payload is at most 8 KiB anyway (09-relay §10.3). */
const MAX_LOGIN_ORIGIN = 8 * 1024;

export interface ConnectLogin {
  /** The genesis hash. */
  network: Uint8Array;
  account: Uint8Array;
  origin: string;
  sid: Uint8Array;
  /** `P`, the session's Ed25519 key. */
  page: Uint8Array;
  /** Unix ms. */
  at: bigint;
}

export interface ConnectGrant {
  version: number;
  login: ConnectLogin;
  /** `{ed25519: hex}` or `{p256: hex}`. */
  signer: DeviceKey;
  signature: Uint8Array;
}

/** Where the page confirms (19-connect §14.2): the wallet's reply slot at its relay, the key the confirmation is
 *  sealed to, and the message of the login that follows, so the page answers one grant. */
export interface ConnectReply {
  /** The node key of the relay that holds the reply slot. */
  relay: Uint8Array;
  /** The reply slot. */
  sid: Uint8Array;
  /** `K`: an X25519 key of this request. */
  key: Uint8Array;
  /** `loginMessage` of the login that follows. */
  login: Uint8Array;
}

/** "The page took the login": the page's answer at the reply slot. */
export interface ConnectConfirm {
  version: number;
  /** `loginMessage` of the login the page took. */
  login: Uint8Array;
  /** Unix ms. */
  at: bigint;
}

export type ConnectPayload =
  | { kind: "seen"; at: bigint }
  | { kind: "grant"; grant: ConnectGrant; bytes: Uint8Array }
  | { kind: "reply"; reply: ConnectReply };

/** Why the page refuses a payload or a grant: the reasons of vectors/connect-v1.json. */
export type Refusal =
  | "open"
  | "encoding"
  | "version"
  | "network"
  | "origin"
  | "slot"
  | "page"
  | "time"
  | "login"
  | "signature"
  | "not_the_account"
  | "upgraded"
  | "not_a_device"
  | "guardian"
  | "log";

export class ConnectError extends Error {
  constructor(
    readonly reason: Refusal,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ConnectError";
  }
}

/** The kind of a signer, for what the page shows and its telemetry. */
export const signerKind = (k: DeviceKey): "ed25519" | "p256" => ("ed25519" in k ? "ed25519" : "p256");

export function writeLogin(w: Writer, l: ConnectLogin): Writer {
  return w.fixed(l.network, 32).fixed(l.account, 32).string(l.origin).fixed(l.sid, 32).fixed(l.page, 32).u64(l.at);
}

export const encodeLogin = (l: ConnectLogin): Uint8Array => writeLogin(new Writer(), l).done();

/** `derive("Saltix connect login v1", borsh(login))`: what the signer signed. */
export const loginMessage = (l: ConnectLogin): Uint8Array => derive(LOGIN_DOMAIN, encodeLogin(l));

export function encodeGrant(g: ConnectGrant): Uint8Array {
  const w = new Writer().u8(g.version);
  writeLogin(w, g.login);
  writeDeviceKey(w, g.signer);
  return w.fixed(g.signature, 64).done();
}

export const encodeSeen = (at: bigint): Uint8Array => new Writer().u8(SEEN_TAG).u64(at).done();

export const encodeReply = (r: ConnectReply): Uint8Array =>
  new Writer().u8(REPLY_TAG).fixed(r.relay, 32).fixed(r.sid, 32).fixed(r.key, 32).fixed(r.login, 32).done();

export const encodeConfirm = (c: ConnectConfirm): Uint8Array => new Writer().u8(c.version).fixed(c.login, 32).u64(c.at).done();

/** One Borsh value of version 1 and nothing after it. */
export function decodeConfirm(bytes: Uint8Array): ConnectConfirm {
  if (bytes.length === 0) throw new ConnectError("encoding", "empty");
  if (bytes[0] !== CONFIRM_VERSION) throw new ConnectError("version", String(bytes[0]));
  const r = new Reader(bytes);
  try {
    const version = r.u8();
    const login = r.fixed(32);
    const at = r.u64();
    r.end();
    return { version, login, at };
  } catch (e) {
    throw new ConnectError("encoding", e instanceof Error ? e.message : String(e));
  }
}

/** What a wallet checks of a confirmation (§14.2 step 4): version 1, the login it sent, `at` within the skew. */
export function checkConfirm(c: ConnectConfirm, login: Uint8Array, nowMs: number | bigint): void {
  if (c.version !== CONFIRM_VERSION) throw new ConnectError("version", String(c.version));
  if (!equal(c.login, login)) throw new ConnectError("login");
  const now = BigInt(nowMs);
  const skew = c.at > now ? c.at - now : now - c.at;
  if (skew > BigInt(CONNECT_SKEW_MS)) throw new ConnectError("time");
}

/** One Borsh value and nothing after it: a seen notice by its first byte 0, a grant of version 1 by its first byte 1,
 *  a reply by its first byte 2. */
export function decodePayload(bytes: Uint8Array): ConnectPayload {
  if (bytes.length === 0) throw new ConnectError("encoding", "empty");
  if (bytes[0] !== SEEN_TAG && bytes[0] !== GRANT_VERSION && bytes[0] !== REPLY_TAG) throw new ConnectError("version", String(bytes[0]));
  const r = new Reader(bytes);
  try {
    const first = r.u8();
    if (first === SEEN_TAG) {
      const at = r.u64();
      r.end();
      return { kind: "seen", at };
    }
    if (first === REPLY_TAG) {
      const reply: ConnectReply = { relay: r.fixed(32), sid: r.fixed(32), key: r.fixed(32), login: r.fixed(32) };
      r.end();
      return { kind: "reply", reply };
    }
    const login: ConnectLogin = {
      network: r.fixed(32),
      account: r.fixed(32),
      origin: r.string(MAX_LOGIN_ORIGIN),
      sid: r.fixed(32),
      page: r.fixed(32),
      at: r.u64(),
    };
    const signer = readDeviceKey(r);
    const signature = r.fixed(64);
    r.end();
    return { kind: "grant", grant: { version: GRANT_VERSION, login, signer, signature }, bytes };
  } catch (e) {
    throw new ConnectError("encoding", e instanceof Error ? e.message : String(e));
  }
}

/** What the page knows of the session it offered. */
export interface Session {
  network: Uint8Array;
  origin: string;
  sid: Uint8Array;
  page: Uint8Array;
}

/** Rules 1–4 of §5: this session's network, origin, slot and key, `at` within the skew of `nowMs`, the signature. */
export function checkGrant(g: ConnectGrant, session: Session, nowMs: number | bigint): void {
  const l = g.login;
  if (g.version !== GRANT_VERSION) throw new ConnectError("version", String(g.version));
  if (!equal(l.network, session.network)) throw new ConnectError("network");
  if (l.origin !== session.origin) throw new ConnectError("origin");
  if (!equal(l.sid, session.sid)) throw new ConnectError("slot");
  if (!equal(l.page, session.page)) throw new ConnectError("page");
  const now = BigInt(nowMs);
  const skew = l.at > now ? l.at - now : now - l.at;
  if (skew > BigInt(CONNECT_SKEW_MS)) throw new ConnectError("time");
  if (!verifyByDeviceKey(g.signer, loginMessage(l), toHex(g.signature))) throw new ConnectError("signature");
}

/** The kind of the address the page shows: 0 (plain or upgraded) or 5. */
export type AddressKind = 0 | 5;

/**
 * Rule 5: the signer is the account's now, by the account's key event log (each event's Borsh, as `account_log` gives
 * them) checked offline under the network's genesis hash and first policy. An empty log is a plain account's: its own
 * Ed25519 key signs. Otherwise a current device of the replayed controller signs, never a guardian, and never the kind
 * 0 key of an account that upgraded (13-accounts §11).
 */
export function checkAccount(g: ConnectGrant, events: Uint8Array[], genesis: Uint8Array, policy: AccountPolicy): { kind: AddressKind; log: CheckedLog | null } {
  const { problem, log, detail } = keySpeaksFor(g.signer, g.login.account, events, genesis, policy);
  if (problem !== null) throw new ConnectError(problem, detail);
  return { kind: log?.origin.kind === "root" ? 5 : 0, log };
}
