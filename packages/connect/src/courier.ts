// The server-held mode's wire (Saltix 19-connect §15): what passes between the page, a courier, and the site's server,
// which made the offer's keys and holds the session. The page gets public keys and sealed bytes, never a secret; it
// forwards every payload its slot receives as it came, opening nothing, and takes the server's word on each. These are
// the JSON both sides speak (`@saltix/connect/server` answers it; `httpCourier` asks it over the site's own paths) and
// the `Courier` a session drives, so a site with a transport of its own brings one of the same shape.
import { b64url, fromB64Loose } from "./codec.js";
import { nameOk } from "./offer.js";
import type { Connection } from "./store.js";

/** The offer as the server gives it to the page (§15.1 step 1): its slot, `Q`'s and `P`'s public keys, the origin the
 *  offer is for and the name it shows, base64url. Nothing secret. */
export interface ServerOffer {
  sid: string;
  boxKey: string;
  page: string;
  origin: string;
  name: string;
}

/** What the page forwards (§15.1 step 3): its slot and the payload, sealed as it came, base64url. */
export interface Forwarded {
  sid: string;
  payload: string;
}

/** The page's confirmation to the wallet (§15.3), sealed by the server for the page to deliver: the wallet's relay and
 *  reply slot, and the sealed `ConnectConfirm`, base64url. */
export interface Confirmation {
  relay: string;
  sid: string;
  payload: string;
}

/**
 * The server's word on a forwarded payload (§15.1 step 4, §15.2): nobody's (`ignored`), the wallet's notice (`seen`),
 * its reply kept (`reply`), a grant refused for its reason (a grant's reasons of §5, `offer` for an offer the server
 * does not hold or holds no more, `spent` for one whose grant was taken, or the site's own), one the node could not
 * check (`unchecked`), or the session opened (`connected`: the account's public facts and the confirmation for the
 * page to deliver, with whatever the site's server answers beside — where to go, a name).
 */
export type Taken =
  | { outcome: "ignored" }
  | { outcome: "seen" }
  | { outcome: "reply" }
  | { outcome: "refused"; reason: string }
  | { outcome: "unchecked"; kind: string }
  | { outcome: "connected"; connection: Connection; confirm: Confirmation | null };

/** An offer as a session holds it: the keys decoded, nothing secret among them. */
export interface CourierOffer {
  sid: Uint8Array;
  boxKey: Uint8Array;
  page: Uint8Array;
  origin: string;
  name: string;
}

/** The server's word, decoded for the session; `value` is what the page is told of the sign-in. */
export type CourierAnswer<T> =
  | { kind: "ignored" | "seen" | "reply" }
  | { kind: "refused"; reason: string }
  | { kind: "unchecked"; detail: string }
  | { kind: "connected"; value: T; confirm: { relay: Uint8Array; sid: Uint8Array; payload: Uint8Array } | null };

/** What a session drives in the server-held mode: the server's offer, and its word on each payload the slot received. */
export interface Courier<T> {
  offer(): Promise<CourierOffer>;
  take(sid: Uint8Array, payload: Uint8Array): Promise<CourierAnswer<T>>;
}

/** The site's two paths, on the page's own origin: `POST`ed for an offer, and `POST`ed each forwarded payload. */
export interface ServerPaths {
  offer: string;
  login: string;
  /** The page's fetch (a test's otherwise). */
  fetch?: typeof fetch;
}

/** Why the server could not be asked, or answered what is no answer: not a word on any login. */
export class CourierError extends Error {
  constructor(
    readonly kind: "unreachable" | "timeout" | "http" | "bad_answer" | "origin" | "name",
    detail?: string,
  ) {
    super(detail ? `the site's server: ${kind}: ${detail}` : `the site's server: ${kind}`);
    this.name = "CourierError";
  }
}

/** How long the page waits for an offer, and for the server's word on a payload (the node's checks take their time). */
export const OFFER_MS = 10_000;
export const TAKE_MS = 20_000;

const HEX64 = /^[0-9a-f]{64}$/;

/** 32 bytes from a base64url string, or null. */
function key32(v: unknown): Uint8Array | null {
  const bytes = typeof v === "string" ? fromB64Loose(v) : null;
  return bytes && bytes.length === 32 ? bytes : null;
}

/** The connection as the server told it: the account's public facts, never the grant's bytes. */
function connectionOf(v: unknown): Connection | null {
  const c = v as Partial<Connection> | null;
  if (
    !c || typeof c !== "object" || typeof c.network !== "string" || !HEX64.test(c.network) || typeof c.account !== "string" || !HEX64.test(c.account) ||
    typeof c.address !== "string" || c.address.length === 0 || c.address.length > 120 || (c.signer !== "ed25519" && c.signer !== "p256") ||
    typeof c.managed !== "boolean" || typeof c.since !== "number" || !Number.isFinite(c.since)
  ) {
    return null;
  }
  return { network: c.network, account: c.account, address: c.address, signer: c.signer, managed: c.managed, since: c.since };
}

async function post(get: typeof fetch, path: string, body: object, timeoutMs: number): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response: Response;
  try {
    response = await get(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      // The session the server opens travels in its Set-Cookie: this page's own origin keeps it.
      credentials: "same-origin",
      cache: "no-store",
      signal: abort.signal,
    });
  } catch {
    throw new CourierError(abort.signal.aborted ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (response.status < 200 || response.status > 299) throw new CourierError("http", String(response.status));
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    throw new CourierError("bad_answer", "not JSON");
  }
  if (typeof answer !== "object" || answer === null) throw new CourierError("bad_answer", "not an object");
  return answer;
}

/**
 * The courier over the site's own paths (`@saltix/connect/server`'s JSON): the offer must be for this page's origin
 * (§15.1 step 2: the login names the page's own) and, when the page names itself too, under the same name.
 */
export function httpCourier(paths: ServerPaths, expect: { origin: string; name?: string }): Courier<Connection> {
  const get = paths.fetch ?? ((input, init) => fetch(input, init));
  return {
    async offer() {
      const a = (await post(get, paths.offer, {}, OFFER_MS)) as Partial<ServerOffer>;
      const sid = key32(a.sid);
      const boxKey = key32(a.boxKey);
      const page = key32(a.page);
      if (!sid || !boxKey || !page || typeof a.origin !== "string" || typeof a.name !== "string") throw new CourierError("bad_answer", "not an offer");
      if (a.origin !== expect.origin) throw new CourierError("origin", "the server's offer is for another origin");
      if (!nameOk(a.name) || (expect.name !== undefined && a.name !== expect.name)) throw new CourierError("name");
      return { sid, boxKey, page, origin: a.origin, name: a.name };
    },
    async take(sid, payload) {
      const a = (await post(get, paths.login, { sid: b64url(sid), payload: b64url(payload) } satisfies Forwarded, TAKE_MS)) as Partial<Taken> & Record<string, unknown>;
      switch (a.outcome) {
        case "ignored":
        case "seen":
        case "reply":
          return { kind: a.outcome };
        case "refused":
          if (typeof a.reason !== "string" || a.reason.length === 0 || a.reason.length > 64) throw new CourierError("bad_answer", "a refusal without a reason");
          return { kind: "refused", reason: a.reason };
        case "unchecked":
          return { kind: "unchecked", detail: typeof a.kind === "string" ? a.kind : "server" };
        case "connected": {
          const connection = connectionOf(a.connection);
          if (!connection) throw new CourierError("bad_answer", "not a connection");
          let confirm: { relay: Uint8Array; sid: Uint8Array; payload: Uint8Array } | null = null;
          if (a.confirm !== null && a.confirm !== undefined) {
            const c = a.confirm as Partial<Confirmation>;
            const relay = key32(c.relay);
            const replySid = key32(c.sid);
            const bytes = typeof c.payload === "string" ? fromB64Loose(c.payload) : null;
            if (!relay || !replySid || !bytes || bytes.length === 0) throw new CourierError("bad_answer", "not a confirmation");
            confirm = { relay, sid: replySid, payload: bytes };
          }
          // What the site's server answered beside the account (where to go, a name) goes with the connection.
          const { outcome: _o, connection: _c, confirm: _f, ...answer } = a;
          return { kind: "connected", value: Object.keys(answer).length > 0 ? { ...connection, answer } : connection, confirm };
        }
        default:
          throw new CourierError("bad_answer", "no outcome");
      }
    },
  };
}
