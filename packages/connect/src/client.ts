// `createConnect`: Saltix Connect for a website or a DApp in a few calls, without a framework (Saltix 19-connect §13,
// §15). In the page's own mode it runs the page's session (keys, a link slot at a relay the page reaches, the offer as
// text, link and QR code), checks the grant the wallet delivers (rules 1–5, the account's key event log from the page's
// node included), and keeps the connection in this origin's storage for 30 days or until the visitor disconnects. In
// the server-held mode (`server`) the site's server makes the offer's keys and takes the login; the page is its
// courier, holds no secret, keeps nothing, and shows what the server answered. Events tell the page what to show; the
// button (`signInButton`) and the dialog (`openConnectDialog`) are built on it, in both modes.
import { type NetworkName, connectOriginOk, fromHex } from "@saltix/grain-server/web";
import { type Courier, type ServerPaths, httpCourier } from "./courier.js";
import { type Offer, nameOk } from "./offer.js";
import { type NodeLike, type NodeStatus, nodeCall } from "./node.js";
import { type QrCode, qrCode } from "./qr.js";
import { type Dial, dialWebSocket } from "./relay.js";
import { ConnectSession, type KeptSlotStore, type Phase, type SessionKeys, type SessionOptions, makeKeys } from "./session.js";
import { type Connection, type KeptStorage, defaultStorage, forgetConnection, loadConnection, saveConnection, STORAGE_KEY } from "./store.js";
import { CONNECT_LIFE_MS } from "./grant.js";
import { verifyGrant } from "./verify.js";

export interface ConnectOptions {
  /** The network the page reads: `mainnet`, `testnet` or `devnet` (Saltix's test network is of the devnet kind). A
   *  relay of another kind is refused, and addresses are written with its prefix. */
  network: NetworkName;
  /**
   * Relays the page opens its slot at, tried in random order: `wss://` URLs or paths on this site. Relays' certificates
   * are self-signed and pinned by apps; a browser cannot pin, so these are the site's own WebSocket paths that pass to
   * one relay each and pin its certificate (as saltix.io's `/explorer/r/1/`), or a public gateway once one exists.
   */
  relays: readonly string[];
  /** The wallet interface the page reads the network's status and accounts' key event logs from: a URL the page can
   *  reach (a path on this site that passes to a node), or an object that answers calls. The page's own mode needs it;
   *  in the server-held mode the server reads its own node, and the page none. */
  node?: NodeLike;
  /** What the page calls itself in the offer: 1–40 bytes, shown by Saltix beside the origin. In the server-held mode
   *  the offer's name is the server's; given here too, the two must agree. */
  name?: string;
  /** The page's origin as the browser serializes it; `location.origin` by default. A wallet connects to https only. */
  origin?: string;
  /** The network's genesis hash (hex): the node must be on it. Without it the node's word is taken. */
  genesis?: string;
  /** Where the connection is kept: `localStorage` by default; null keeps it for this page only. */
  storage?: KeptStorage | null;
  /** How the page reaches a relay: the browser's WebSocket by default (a test's fake otherwise). */
  dial?: Dial;
  /** Events worth counting (`connect_open`, `connect_seen`, `connect_grant`, `connect_refused`…), with numbers and
   *  reasons only: never a key, a slot, an account or an address. */
  telemetry?: (event: string, meta?: Record<string, string | number | boolean>) => void;
  /** Fresh session keys (tests). */
  keys?: () => Promise<SessionKeys>;
  /** The browser's user agent (tests): on Android the Open Saltix link is an intent link. */
  userAgent?: string;
  /** Where the slot is kept across a reload: `sessionStorage` by default, null for nowhere (tests). */
  keep?: KeptSlotStore | null;
  /**
   * The server-held mode (19-connect §15): the site's server makes the offer's keys, takes every payload the slot
   * receives and opens the session; this page is its courier and holds no secret. The server's two paths on this
   * origin (`POST` for an offer, `POST` for each payload, as `@saltix/connect/server` answers them), or a courier of
   * the site's own. The session is then the server's (its cookie or token), so the page keeps no connection here:
   * `connection` is null, and `connected` carries what the server told of the sign-in, with the server's own fields in
   * `answer`.
   */
  server?: ServerPaths | Courier<Connection>;
}

/** An offer as the page shows it. */
export interface OfferView {
  /** The offer's text: what the QR code holds. */
  text: string;
  /** `https://saltix.io/connect#…`: the link that opens Saltix, for a message or another device. */
  link: string;
  /** The link that opens Saltix on this device without unloading the page (19-connect §14.1): an intent link on
   *  Android, `link` elsewhere. What "Open Saltix" on a phone points at. */
  app: string;
  qr: QrCode;
  /** When an unseen offer is replaced by a new one (Unix ms), or null once the wallet saw it. */
  expiresAt: number | null;
}

/** Why no offer could be made: no relay answered, a relay or the node is of another network, the node did not answer,
 *  the site's server gave no offer the page can show (the server-held mode), or the page cancelled the session. */
export type FailReason = "no_relay" | "network" | "node" | "server" | "cancelled";

export interface ConnectEvents {
  /** A new offer to show: the first, or one that replaced an expired one. */
  offer: OfferView;
  /** The wallet read the offer: "continue on your phone". */
  seen: OfferView;
  /** A grant came and is being checked. */
  checking: Record<string, never>;
  /** Signed in: the account the page now shows first, checked — by this page, or by the site's server. */
  connected: Connection;
  /** A grant was refused (`time`, `not_a_device`, the server's `spent`…) or could not be checked (`unchecked`); the
   *  offer stays. */
  refused: { reason: string };
  failed: { reason: FailReason };
  /** The connection to the relay dropped (true) or is back (false). */
  reconnecting: { on: boolean };
  /** The visitor disconnected, here or in another tab. */
  disconnected: Record<string, never>;
}

const FAILED: Record<FailReason, string> = {
  no_relay: "no relay answers",
  network: "a relay or the node is of another network",
  node: "the node does not answer",
  server: "the site's server gave no offer",
  cancelled: "the session was cancelled",
};

export class ConnectFailed extends Error {
  constructor(readonly reason: FailReason) {
    super(`Saltix Connect: ${FAILED[reason]}`);
    this.name = "ConnectFailed";
  }
}

export interface SaltixConnect {
  /** The connection kept in this browser, or null: always null in the server-held mode, where the session is the
   *  server's and the page asks it. */
  readonly connection: Connection | null;
  /** Where the session stands: `idle` before an offer and after `cancel`. */
  readonly phase: Phase["kind"] | "idle";
  on<E extends keyof ConnectEvents>(event: E, handler: (data: ConnectEvents[E]) => void): () => void;
  /** Start a session and give its offer (the current one while a session runs); rejects with `ConnectFailed`. A slot
   *  the page kept across a reload is opened again (§14.1). */
  offer(): Promise<OfferView>;
  /** A new offer at once: a new slot and new keys. */
  renew(): Promise<OfferView>;
  /** Stop the session: its slot goes with its connection. */
  cancel(): void;
  /** The visitor opened the link to Saltix on this phone: the offer stays until the slot's end. */
  handOff(): void;
  /** The page is in front again: a dropped connection to the relay is opened again at once. */
  wake(): void;
  /** Forget the connection kept in this browser (the page's own mode; a server's session ends at the server). */
  disconnect(): void;
}

type Handlers = { [E in keyof ConnectEvents]: Set<(data: ConnectEvents[E]) => void> };

const isPaths = (server: ServerPaths | Courier<Connection>): server is ServerPaths => typeof server.offer === "string";

/** Saltix Connect for this page. */
export function createConnect(o: ConnectOptions): SaltixConnect {
  const origin = o.origin ?? (typeof location === "undefined" ? "" : location.origin);
  if (!connectOriginOk(origin)) throw new TypeError(`Saltix Connect: ${origin || "no origin"} is not a page's origin as a browser serializes it`);
  if (o.name !== undefined && !nameOk(o.name)) throw new TypeError("Saltix Connect: the name is 1 to 40 bytes, without control or format characters");
  if (o.genesis !== undefined && !/^[0-9a-f]{64}$/.test(o.genesis)) throw new TypeError("Saltix Connect: genesis is 64 lowercase hex digits");
  if (!o.server && !o.node) throw new TypeError("Saltix Connect: the page's own mode needs a node to check the login with (or `server` for the server-held mode)");
  if (!o.server && o.name === undefined) throw new TypeError("Saltix Connect: the page's own mode names the page (`name`)");
  // The server-held mode: the server's offer, every payload forwarded, nothing kept here.
  const courier: Courier<Connection> | null = o.server ? (isPaths(o.server) ? httpCourier(o.server, { origin, name: o.name }) : o.server) : null;
  const storage = courier ? null : o.storage === undefined ? defaultStorage() : o.storage;
  const telemetry = o.telemetry ?? (() => {});
  const handlers = { offer: new Set(), seen: new Set(), checking: new Set(), connected: new Set(), refused: new Set(), failed: new Set(), reconnecting: new Set(), disconnected: new Set() } as unknown as Handlers;
  const emit = <E extends keyof ConnectEvents>(event: E, data: ConnectEvents[E]) => {
    for (const h of [...handlers[event]]) {
      try {
        h(data);
      } catch {
        /* a page's handler never breaks the session */
      }
    }
  };

  let genesis: string | null = o.genesis ?? null;
  /** Whether the node's network and genesis were read and agree with the page's: each grant reads them again. */
  let known = false;
  let session: ConnectSession<Connection> | null = null;
  let current: OfferView | null = null;
  let kept: Connection | null = courier ? null : loadConnection(o.network, genesis, Date.now(), storage);
  let waiting: Array<{ ok: (v: OfferView) => void; fail: (e: Error) => void }> = [];

  const settle = (result: OfferView | ConnectFailed) => {
    const all = waiting;
    waiting = [];
    for (const w of all) {
      if (result instanceof ConnectFailed) w.fail(result);
      else w.ok(result);
    }
  };

  const view = (p: Extract<Phase, { text: string }>, expiresAt: number | null): OfferView => {
    if (current && current.text === p.text) return { ...current, expiresAt };
    return { text: p.text, link: p.link, app: p.app, qr: qrCode(p.text), expiresAt };
  };

  /** The node's network and genesis, once: a node or a genesis of another network fails the session. The server-held
   *  mode asks no node: the server holds the login to its own network. */
  async function status(): Promise<FailReason | null> {
    if (known || courier) return null;
    let s: NodeStatus;
    try {
      s = await nodeCall<NodeStatus>(o.node!, "node_status");
    } catch {
      return "node";
    }
    if (s.network !== o.network || !/^[0-9a-f]{64}$/.test(s.genesis) || (genesis !== null && s.genesis !== genesis)) return "network";
    genesis = s.genesis;
    known = true;
    // A connection of another genesis (a network reset) is dropped.
    kept = loadConnection(o.network, genesis, Date.now(), storage);
    return null;
  }

  function onPhase(p: Phase): void {
    switch (p.kind) {
      case "offer":
        current = view(p, p.expiresAt);
        emit("offer", current);
        settle(current);
        return;
      case "seen":
        current = view(p, null);
        emit("seen", current);
        return;
      case "checking":
        emit("checking", {});
        return;
      case "failed": {
        const reason: FailReason = p.reason === "network" ? "network" : p.reason === "server" ? "server" : "no_relay";
        emit("failed", { reason });
        settle(new ConnectFailed(reason));
        return;
      }
      default:
        return;
    }
  }

  async function begin(fresh = false): Promise<OfferView> {
    session?.stop();
    session = null;
    current = null;
    const pending = new Promise<OfferView>((ok, fail) => waiting.push({ ok, fail }));
    const failed = await status();
    if (failed) {
      emit("failed", { reason: failed });
      settle(new ConnectFailed(failed));
      return pending;
    }
    // The genesis this session offers under: each grant's node must still be on it.
    const offered = genesis;
    const shared: Omit<SessionOptions<Connection>, "connected" | "events"> = {
      relays: o.relays,
      networkKind: o.network,
      origin,
      dial: o.dial ?? dialWebSocket,
      userAgent: o.userAgent,
      keep: o.keep,
    };
    const mode: Partial<SessionOptions<Connection>> = courier
      ? { courier }
      : {
          network: fromHex(offered!, 32),
          name: o.name,
          keys: o.keys ?? makeKeys,
          verify: (grant, bytes, sess) => verifyGrant(grant, bytes, sess, { node: o.node!, network: o.network, genesis: offered! }),
        };
    const s: ConnectSession<Connection> = new ConnectSession<Connection>({
      ...shared,
      ...mode,
      connected: (c) => {
        if (session !== s) return;
        session = null;
        current = null;
        if (!courier) {
          kept = c;
          saveConnection(o.network, c, storage);
        }
        emit("connected", c);
      },
      events: {
        phase: (p) => {
          if (session === s) onPhase(p);
        },
        refused: (r) => emit("refused", { reason: r.reason }),
        reconnecting: (on) => emit("reconnecting", { on }),
        telemetry,
      },
    });
    session = s;
    void s.start({ fresh });
    return pending;
  }

  // Another tab of this site connected or disconnected (the page's own mode: the server-held one keeps nothing here).
  if (!courier && typeof addEventListener === "function") {
    addEventListener("storage", (e: Event) => {
      const key = (e as StorageEvent).key;
      if (key !== null && key !== STORAGE_KEY) return;
      const before = kept;
      kept = loadConnection(o.network, genesis, Date.now(), storage);
      if (before && !kept) emit("disconnected", {});
      else if (kept && kept.grant !== before?.grant) emit("connected", kept);
    });
  }

  return {
    get connection() {
      // Past its life a connection is gone, whether or not storage keeps it.
      if (kept && Date.now() - kept.since >= CONNECT_LIFE_MS) {
        forgetConnection(o.network, storage);
        kept = null;
      }
      return kept;
    },
    get phase() {
      return session ? session.current.kind : "idle";
    },
    on(event, handler) {
      handlers[event].add(handler);
      return () => handlers[event].delete(handler);
    },
    offer() {
      if (session && current) return Promise.resolve(current);
      if (session) return new Promise<OfferView>((ok, fail) => waiting.push({ ok, fail }));
      return begin();
    },
    renew: () => begin(true),
    cancel() {
      session?.stop();
      session = null;
      current = null;
      settle(new ConnectFailed("cancelled"));
    },
    handOff() {
      session?.handOff();
    },
    wake() {
      session?.wake();
    },
    disconnect() {
      if (courier) return;
      forgetConnection(o.network, storage);
      const had = kept !== null;
      kept = null;
      telemetry("connect_disconnect");
      if (had) emit("disconnected", {});
    },
  };
}

export type { Offer };
