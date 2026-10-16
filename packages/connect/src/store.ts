// What the page keeps of a connection (Saltix 19-connect §5): the account, its address and the grant, in this origin's
// storage, one per network, until the visitor disconnects or 30 days pass (`CONNECT_LIFE`). It grants nothing: the page
// shows public data with this account first. Storage that is unavailable (a private window, blocked site data) keeps
// the connection for this page only. As the explorer keeps it.
import { CONNECT_LIFE_MS } from "./grant.js";

export interface Connection {
  /** The genesis hash of the network it was made on, hex. */
  network: string;
  /** The account id, hex. */
  account: string;
  /** The account's address (Address v1), as the page shows it. */
  address: string;
  /** The grant's Borsh, base64url: the proof the page checked, for a server that checks it again. */
  grant: string;
  signer: "ed25519" | "p256";
  /** Whether a device of a managed account signed it (else the plain account's own key). */
  managed: boolean;
  /** When the page took it, Unix ms. */
  since: number;
}

/** The key the connections are kept under in `localStorage`. */
export const STORAGE_KEY = "saltix-connect";

type Stored = Record<string, Connection>;

/** What a page's storage needs to be: `localStorage`'s three methods. */
export type KeptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readAll(storage: KeptStorage | null): Stored {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function writeAll(storage: KeptStorage | null, all: Stored): void {
  try {
    if (Object.keys(all).length === 0) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the connection lasts this page */
  }
}

/** Whether `c` is a connection kept for a network whose genesis is `genesis` (any, when null) and still in its life. */
function valid(c: unknown, genesis: string | null, now: number): c is Connection {
  const v = c as Partial<Connection> | null;
  return (
    !!v &&
    typeof v.network === "string" &&
    /^[0-9a-f]{64}$/.test(v.network) &&
    (genesis === null || v.network === genesis) &&
    typeof v.account === "string" &&
    /^[0-9a-f]{64}$/.test(v.account) &&
    typeof v.address === "string" &&
    v.address.length <= 120 &&
    typeof v.grant === "string" &&
    v.grant.length <= 12_000 &&
    (v.signer === "ed25519" || v.signer === "p256") &&
    typeof v.managed === "boolean" &&
    typeof v.since === "number" &&
    v.since <= now + 60_000 &&
    now - v.since < CONNECT_LIFE_MS
  );
}

/** `localStorage`, or null where the page may not use it. */
export const defaultStorage = (): KeptStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** The connection kept for network `id` (whose genesis is `genesis`, when the page knows it), or null; an expired one,
 *  or one of another genesis (the network was reset), is dropped. */
export function loadConnection(id: string, genesis: string | null, now = Date.now(), storage = defaultStorage()): Connection | null {
  const all = readAll(storage);
  const c = all[id];
  if (c === undefined) return null;
  if (valid(c, genesis, now)) return c;
  delete all[id];
  writeAll(storage, all);
  return null;
}

export function saveConnection(id: string, c: Connection, storage = defaultStorage()): void {
  const all = readAll(storage);
  all[id] = c;
  writeAll(storage, all);
}

export function forgetConnection(id: string, storage = defaultStorage()): void {
  const all = readAll(storage);
  delete all[id];
  writeAll(storage, all);
}
