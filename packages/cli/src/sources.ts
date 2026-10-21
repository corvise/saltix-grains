// Where a sealed manifest says its bundle may also be fetched (Saltix 12-grains §2, §8; 32-images §6.2, §10): its
// `sources`. The network keeps the bundle and wallets ask their own relay first, so sources are fallbacks. Before
// protocol version 2 a sealed manifest must name 1 to 8 of them, so `grain publish` names copies the network itself
// serves: `https://<relay>/_blob/grain_bundle/<hash>` at up to 3 relays of the network's current relay list (`relay_list`),
// those that keep bundles first. Never a third party's host, never one the developer has to run. From version 2 a
// sealed manifest names none.
import { type NodeLike, NETWORK_BUNDLES, derive, fromHex, nodeCall, originOf, toHex } from "@saltix/grain-server";

/** How many relays' copies a manifest names on a network before protocol version 2. */
export const RELAY_SOURCES = 3;
/** The path a relay serves a bundle at (32-images §8.1). */
export const BLOB_PATH = "/_blob/grain_bundle/";

/** A relay as `relay_list` names it: its node key, its endpoints and the space it offers (GiB), as far as known. */
export interface ListedRelay {
  key?: string;
  endpoints: Array<{ url: string; cert_sha256: string | null }>;
  store_gib?: number | null;
}

/** What `node_status` says of protocol versions; a node from before them says nothing, which is version 1. */
export { protocolOf } from "./versions.js";

/** Whether a source is a relay's copy of a bundle (one the network serves), not one of the developer's own hosts. */
export const isRelaySource = (source: string): boolean => {
  try {
    return new URL(source).pathname.startsWith(BLOB_PATH);
  } catch {
    return false;
  }
};

/** The https URL a relay's endpoint serves `hash` at, or null for an endpoint a manifest cannot name (not `wss://`, a
 *  host that is no origin's, such as an IPv6 literal). */
export function relayBlobUrl(endpoint: string, hash: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "wss:") return null;
  const origin = `https://${url.host}`;
  if (originOf(origin) !== origin) return null;
  const source = `${origin}${BLOB_PATH}${hash}`;
  return source.length <= 2048 ? source : null;
}

/** A relay's place among a bundle's keepers (32-images §6.2): `derive("Saltix bundle placement v1", hash ‖ node key)`,
 *  the highest first. */
const placement = (hash: string, key: string) => toHex(derive("Saltix bundle placement v1", fromHex(hash, 32), fromHex(key, 32)));

/** The network an IPv4 endpoint serves from, by its /16, so the copies a manifest names are not all on one network. */
const networkOf = (source: string) => {
  const host = new URL(source).hostname;
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split(".").slice(0, 2).join(".") : host;
};

/**
 * Up to `max` sources for the bundle `hash` of `size` bytes from a relay list: one URL per relay, relays that offer room
 * for it first (they are its likely keepers), then by the bundle's placement among them, one per /16 network first;
 * the same list and bundle give the same sources.
 */
export function relaySources(relays: readonly ListedRelay[], hash: string, size: number, max = RELAY_SOURCES): string[] {
  const ranked = relays
    .map((r) => {
      const source = r.endpoints.map((e) => relayBlobUrl(e.url, hash)).find((s) => s !== null) ?? null;
      const key = typeof r.key === "string" && /^[0-9a-f]{64}$/.test(r.key) ? r.key : null;
      const room = typeof r.store_gib === "number" && r.store_gib * 2 ** 30 >= size;
      return { source, room, rank: key ? placement(hash, key) : "" };
    })
    .filter((r): r is { source: string; room: boolean; rank: string } => r.source !== null)
    .sort((a, b) => Number(b.room) - Number(a.room) || (a.rank < b.rank ? 1 : a.rank > b.rank ? -1 : 0) || (a.source < b.source ? -1 : 1));
  const picked: string[] = [];
  for (const spread of [true, false]) {
    for (const r of ranked) {
      if (picked.length >= max) break;
      if (picked.some((p) => new URL(p).origin === new URL(r.source).origin)) continue;
      if (spread && picked.some((p) => networkOf(p) === networkOf(r.source))) continue;
      picked.push(r.source);
    }
  }
  return picked;
}

/**
 * The sources a sealed manifest names on a network of `protocol`, given those it names now: the developer's own hosts
 * stay (fallbacks they chose); relays' copies are named afresh from the network's relay list before `NETWORK_BUNDLES`
 * when the developer named none, and dropped from it on.
 */
export async function sourcesFor(node: NodeLike, protocol: number, hash: string, size: number, current: readonly string[]): Promise<{ sources: string[]; from: "own" | "relays" | "network" }> {
  const own = current.filter((s) => !isRelaySource(s));
  if (own.length > 0) return { sources: own.slice(0, 8), from: "own" };
  if (protocol >= NETWORK_BUNDLES) return { sources: [], from: "network" };
  const { relays } = await nodeCall<{ relays: ListedRelay[] }>(node, "relay_list");
  return { sources: relaySources(relays ?? [], hash, size), from: "relays" };
}
