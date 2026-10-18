// The wallet's answer to a Connect offer (Saltix 19-connect §4–§5): `ConnectSeen`, then a `ConnectGrant` — a
// `ConnectLogin` naming this page's network, origin, slot and session key, signed by a key of the account. The page
// takes a grant only when every rule of §5 holds; `saltix-types` `connect` has the same checks, and
// vectors/connect-v1.json pins both to the same bytes and reasons. A port of the explorer's own.
import {
  type AccountPolicy, type CheckedLog, type DeviceKey, Reader, Writer, derive, keySpeaksFor, readDeviceKey, verifyByDeviceKey, toHex,
  writeDeviceKey,
} from "@saltix/grain-server/web";
import { equal } from "./codec.js";

export const LOGIN_DOMAIN = "Saltix connect login v1";
export const GRANT_VERSION = 1;
export const SEEN_TAG = 0;
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

export type ConnectPayload = { kind: "seen"; at: bigint } | { kind: "grant"; grant: ConnectGrant; bytes: Uint8Array };

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

/** One Borsh value and nothing after it: a seen notice by its first byte 0, a grant of version 1 by its first byte 1. */
export function decodePayload(bytes: Uint8Array): ConnectPayload {
  if (bytes.length === 0) throw new ConnectError("encoding", "empty");
  if (bytes[0] !== SEEN_TAG && bytes[0] !== GRANT_VERSION) throw new ConnectError("version", String(bytes[0]));
  const r = new Reader(bytes);
  try {
    if (r.u8() === SEEN_TAG) {
      const at = r.u64();
      r.end();
      return { kind: "seen", at };
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
