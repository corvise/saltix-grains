/**
 * `@saltix/connect/server`: the site's server in Saltix Connect's server-held mode (Saltix 19-connect §15), for Node
 * 20 and later. The server makes and keeps the keys of every offer and hands the page only what is public; the page
 * is its courier, forwarding every payload its slot receives sealed, as it came; a grant opens a session here after
 * every check of §15.2 — the offer live, the payload opened with `Q`'s secret, the login this offer's and in time, the
 * signature, the signer the account's by its key event log from a node (the page's own check, `verifyGrant`), the
 * site's own rule — with `sid` spent in the same step, once. The confirmation the wallet waits for is sealed here, to
 * the reply the wallet delivered, and handed to the page to deliver (§15.3). Offers live 5 minutes, bounded in number,
 * the oldest dropped first (§15.4).
 *
 * Any site runs it beside its own sessions (a cookie or a token it mints after `take` says `connected`, never derived
 * from anything the page sent); a hosted check is never the only way. `packages/connect/example` is a whole site to
 * copy. The journal names outcomes, reasons and timings: never the login's bytes, an account or an address (§15.5).
 */
import { ed25519 } from "@noble/curves/ed25519";
import { type NetworkName, connectOriginOk, fromHex } from "@saltix/grain-server/web";
import { b64url, equal, fromB64Loose } from "./codec.js";
import type { Confirmation, Forwarded, ServerOffer, Taken } from "./courier.js";
import { CONFIRM_VERSION, ConnectError, type ConnectReply, decodePayload, encodeConfirm, loginMessage } from "./grant.js";
import type { NodeLike } from "./node.js";
import { nameOk } from "./offer.js";
import { boxPublic, openLinkPayload, randomSecret, sealLinkPayload } from "./seal.js";
import { SERVER_OFFER_LIFE_MS } from "./session.js";
import type { Connection } from "./store.js";
import { UncheckedError, verifyGrant } from "./verify.js";

/** An offer lives this long at the server, from its making, with its keys (§15.4): 5 minutes, so that a code shown for
 *  a minute or two still leaves the scan, the sheet and the PIN their time, and a relayed or photographed one dies
 *  sooner than the slot's 30. */
export const OFFER_LIFE_MS = SERVER_OFFER_LIFE_MS;
/** Offers kept at most, unless told otherwise: the oldest is dropped first. */
export const MAX_OFFERS = 10_000;
/** A link payload is at most this long (09-relay §10.3): a longer one was never a wallet's. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;

const NETWORKS: readonly NetworkName[] = ["mainnet", "testnet", "devnet"];

/** The keys of one offer as the server makes them: `sid`, `Q`'s secret, and `P`'s public key (its secret is dropped
 *  at once: nothing signs with it, §15.1 step 1). */
export interface ServerKeys {
  sid: Uint8Array;
  boxSecret: Uint8Array;
  page: Uint8Array;
}

/** Fresh keys for one offer. */
export function makeServerKeys(): ServerKeys {
  const seed = randomSecret();
  const page = ed25519.getPublicKey(seed);
  seed.fill(0);
  return { sid: crypto.getRandomValues(new Uint8Array(32)), boxSecret: randomSecret(), page };
}

export interface ServerConnectOptions {
  /** A node's wallet interface the account's key event log is read from: a URL, or an object that answers calls. */
  node: NodeLike;
  /** The network: `mainnet`, `testnet` or `devnet` (Saltix's test network is of the devnet kind). */
  network: NetworkName;
  /** The network's genesis hash, hex: what every login must name, and what the node must be on (§15.2 step 3, 5). */
  genesis: string;
  /** The origin of the page this server makes offers for, as a browser serializes it: the login is held to it. A
   *  server with several origins makes a `ServerConnect` for each. */
  origin: string;
  /** What the offer calls the page: 1–40 bytes, shown by Saltix beside the origin. */
  name: string;
  now?: () => number;
  /** Offers kept at most: the oldest dropped first (§15.4). */
  maxOffers?: number;
  /** Waits between tries of a node that could not answer (the page's own: 1 and 3 seconds). */
  retryMs?: number[];
  /** Events worth counting (`connect_server_offer`, `connect_server_take` with its outcome and reason…), numbers and
   *  reasons only: never a key, a slot, an account or an address. */
  telemetry?: (event: string, meta?: Record<string, string | number | boolean>) => void;
  /** Fresh keys for an offer (tests). */
  keys?: () => ServerKeys;
}

/** The site's own rule on a login that passed the protocol's checks (§15.2 step 6): null admits the account, a
 *  reason (`not_listed`, `window`…) refuses it, which spends nothing. */
export type Admit = (connection: Connection) => Promise<string | null> | string | null;

export interface ServerConnect {
  /** Fresh keys for one offer, kept here for 5 minutes; what the page shows and needs, nothing secret. */
  offer(): Promise<ServerOffer>;
  /** A payload the page forwarded (§15.1 step 4): the server's word on it, which the page is answered with as it is.
   *  `connected` carries the account's public facts, never the grant's bytes, and the confirmation the page delivers. */
  take(forwarded: Forwarded, admit?: Admit): Promise<Taken>;
  /** The confirmation for the grant taken at `sid` (§15.3), sealed afresh: for a server that answers the page in two
   *  steps. Null before a grant was taken, or without a reply for its login. */
  confirm(sid: string | Uint8Array): Promise<Confirmation | null>;
  /** Drop an offer before its time (the page cancelled): whether one was held. */
  drop(sid: string | Uint8Array): boolean;
  /** Offers held now, spent ones included until their time. */
  readonly size: number;
}

interface Held {
  keys: ServerKeys;
  boxKey: Uint8Array;
  made: number;
  /** The latest reply that opened for the offer (§14.2): where the wallet waits for the page's word. */
  reply: ConnectReply | null;
  /** Spent: the login message of the grant taken (§15.2 step 7). */
  taken: Uint8Array | null;
}

const bytesOf = (v: string | Uint8Array | undefined): Uint8Array | null => (v instanceof Uint8Array ? v : typeof v === "string" ? fromB64Loose(v) : null);

/** The server's side of Saltix Connect for one origin. */
export function createServerConnect(o: ServerConnectOptions): ServerConnect {
  if (!connectOriginOk(o.origin)) throw new TypeError(`Saltix Connect: ${o.origin || "no origin"} is not a page's origin as a browser serializes it`);
  if (!nameOk(o.name)) throw new TypeError("Saltix Connect: the name is 1 to 40 bytes, without control or format characters");
  if (!/^[0-9a-f]{64}$/.test(o.genesis)) throw new TypeError("Saltix Connect: genesis is 64 lowercase hex digits");
  if (!NETWORKS.includes(o.network)) throw new TypeError("Saltix Connect: the network is mainnet, testnet or devnet");
  if (o.maxOffers !== undefined && !(Number.isInteger(o.maxOffers) && o.maxOffers >= 1)) throw new TypeError("Saltix Connect: maxOffers is a whole number of offers");
  const now = o.now ?? (() => Date.now());
  const maxOffers = o.maxOffers ?? MAX_OFFERS;
  const telemetry = o.telemetry ?? (() => {});
  const makeKeys = o.keys ?? makeServerKeys;
  const genesis = fromHex(o.genesis, 32);
  // In the order they were made: the oldest first, so expiry and the bound take from the front.
  const offers = new Map<string, Held>();

  const forget = (key: string, held: Held) => {
    held.keys.boxSecret.fill(0);
    offers.delete(key);
  };

  /** Offers past their life go, then the oldest beyond the bound (§15.4). */
  const sweep = (room = 0) => {
    let expired = 0;
    let bound = 0;
    for (const [key, held] of offers) {
      if (now() - held.made < OFFER_LIFE_MS) break;
      forget(key, held);
      expired++;
    }
    while (offers.size + room > maxOffers) {
      const first = offers.entries().next().value;
      if (!first) break;
      forget(first[0], first[1]);
      bound++;
    }
    if (expired > 0 || bound > 0) telemetry("connect_server_drop", { expired, bound, kept: offers.size });
  };

  const sealConfirm = (held: Held): Confirmation | null => {
    if (!held.taken || !held.reply || !equal(held.reply.login, held.taken)) return null;
    const confirm = encodeConfirm({ version: CONFIRM_VERSION, login: held.taken, at: BigInt(now()) });
    const payload = sealLinkPayload(held.reply.key, held.reply.sid, held.keys.page, confirm);
    return { relay: b64url(held.reply.relay), sid: b64url(held.reply.sid), payload: b64url(payload) };
  };

  const refused = (reason: string, started: number): Taken => {
    telemetry("connect_server_take", { outcome: "refused", reason, ms: now() - started });
    return { outcome: "refused", reason };
  };

  return {
    async offer() {
      sweep(1);
      const keys = makeKeys();
      if (keys.sid.length !== 32 || keys.boxSecret.length !== 32 || keys.page.length !== 32) throw new TypeError("Saltix Connect: keys of 32 bytes");
      const key = b64url(keys.sid);
      // The same slot twice would be two offers in one: the first keeps its keys and its state.
      if (offers.has(key)) throw new Error("Saltix Connect: an offer with this slot is held already");
      const boxKey = boxPublic(keys.boxSecret);
      offers.set(key, { keys, boxKey, made: now(), reply: null, taken: null });
      telemetry("connect_server_offer", { kept: offers.size });
      return { sid: key, boxKey: b64url(boxKey), page: b64url(keys.page), origin: o.origin, name: o.name };
    },

    async take(forwarded, admit) {
      const started = now();
      sweep();
      const sid = bytesOf(forwarded?.sid);
      const payload = bytesOf(forwarded?.payload);
      if (!sid || sid.length !== 32 || !payload || payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
        telemetry("connect_server_take", { outcome: "ignored", reason: "request", ms: now() - started });
        return { outcome: "ignored" };
      }
      // §15.2 step 1: the offer is live, and not spent.
      const key = b64url(sid);
      const held = offers.get(key);
      if (!held) return refused("offer", started);
      if (held.taken) return refused("spent", started);
      // Step 2: the payload opens for this offer and decodes; what does not is nobody's (anyone who saw the QR code
      // can deliver to the slot).
      const plain = openLinkPayload(held.keys.boxSecret, sid, held.keys.page, payload);
      if (!plain) {
        telemetry("connect_server_take", { outcome: "ignored", reason: "open", ms: now() - started });
        return { outcome: "ignored" };
      }
      let decoded;
      try {
        decoded = decodePayload(plain);
      } catch (e) {
        telemetry("connect_server_take", { outcome: "ignored", reason: e instanceof ConnectError ? e.reason : "encoding", ms: now() - started });
        return { outcome: "ignored" };
      }
      if (decoded.kind === "seen") {
        telemetry("connect_server_take", { outcome: "seen", ms: now() - started });
        return { outcome: "seen" };
      }
      if (decoded.kind === "reply") {
        held.reply = decoded.reply;
        telemetry("connect_server_take", { outcome: "reply", ms: now() - started });
        return { outcome: "reply" };
      }
      // Steps 3–5: the page's own check of a grant, against this offer's session and the server's network: the login's
      // network, origin, slot and key, its time, the signature, and the signer the account's by the node's log.
      const session = { network: genesis, origin: o.origin, sid, page: held.keys.page };
      let checked: Connection;
      try {
        checked = await verifyGrant(decoded.grant, decoded.bytes, session, { node: o.node, network: o.network, genesis: o.genesis, now, retryMs: o.retryMs });
      } catch (e) {
        if (e instanceof ConnectError) return refused(e.reason, started);
        if (e instanceof UncheckedError) {
          telemetry("connect_server_take", { outcome: "unchecked", kind: e.kind, ms: now() - started });
          return { outcome: "unchecked", kind: e.kind };
        }
        throw e;
      }
      // The login's bytes stay out of what the server keeps and answers (§15.5).
      const connection: Connection = { network: checked.network, account: checked.account, address: checked.address, signer: checked.signer, managed: checked.managed, since: checked.since };
      // Step 6: the site's own rule.
      if (admit) {
        const why = await admit(connection);
        if (why) return refused(why, started);
      }
      // Step 7: spent in the same step that takes the grant. The checks waited on the node: the offer may have gone
      // or been taken by another grant meanwhile.
      if (offers.get(key) !== held) return refused("offer", started);
      if (held.taken) return refused("spent", started);
      held.taken = loginMessage(decoded.grant.login);
      const confirm = sealConfirm(held);
      telemetry("connect_server_take", { outcome: "connected", signer: connection.signer, managed: connection.managed, confirm: confirm !== null, ms: now() - started });
      return { outcome: "connected", connection, confirm };
    },

    async confirm(sid) {
      sweep();
      const bytes = bytesOf(sid);
      const held = bytes && bytes.length === 32 ? offers.get(b64url(bytes)) : undefined;
      return held ? sealConfirm(held) : null;
    },

    drop(sid) {
      const bytes = bytesOf(sid);
      if (!bytes || bytes.length !== 32) return false;
      const key = b64url(bytes);
      const held = offers.get(key);
      if (!held) return false;
      forget(key, held);
      return true;
    },

    get size() {
      return offers.size;
    },
  };
}
