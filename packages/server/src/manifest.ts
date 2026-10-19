import { ed25519 } from "@noble/curves/ed25519";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { type DeviceKey, deviceKeyOf, readDeviceKey, verifyByDeviceKey, writeDeviceKey } from "./keys.js";
import { MAX_NETWORK_BUNDLE_BYTES } from "./named.js";

export const PERMISSIONS = {
  storage: 1,
  relay: 2,
  notifications: 4,
  camera: 8,
  microphone: 16,
  location: 32,
  address: 64,
} as const;

export type Entry =
  | { hosted: { url: string; origins: string[] } }
  | { sealed: { bundle: string; size: number; sources: string[]; start: string; connect: string[] } }
  /** No page and no origin: the grain is its chat (Saltix 24-app-studio §2), served from the server keys its registry
   *  record names. Its JSON form is `{"chat": {}}`, an empty object. */
  | { chat: Record<string, never> };

/** A grain's manifest (12-grains §2); bytes in lowercase hex. */
export interface Manifest {
  slug: string;
  version: number;
  /** The developer's account id: it registers, updates and retires the grain. */
  owner: string;
  /** The key that signs the manifest and certifies server keys: it speaks for `owner` — a plain account's own Ed25519
   *  key, or a managed account's device (13-accounts §5). */
  owner_key: DeviceKey;
  name: Record<string, string>;
  description: Record<string, string>;
  icon: string;
  entry: Entry;
  permissions: number;
  sponsor: string | null;
  min_host: number;
}

/** The JSON form a hosted grain serves at `/.well-known/saltix-grain`. */
export interface SignedManifest {
  manifest: Manifest;
  signature: string;
}

/** Hosts a developer's grain may run at over plain http (12-grains §10): wallets take them in debug builds only. */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

/** `https://host[:port]` of an https URL, or null; with `dev`, also a developer's `http://` origin. */
export function originOf(url: string, dev = false): string | null {
  if (dev) {
    const d = /^http:\/\/([^/?#]*)/.exec(url);
    if (d) {
      const [host, port] = d[1]!.split(":");
      const portOk = port === undefined || (/^[0-9]{1,5}$/.test(port) && +port >= 1 && +port <= 65535);
      return DEV_HOSTS.has(host!) && portOk ? `http://${d[1]}` : null;
    }
  }
  const m = /^https:\/\/([^/?#]*)/.exec(url);
  if (!m) return null;
  const authority = m[1]!;
  const colon = authority.lastIndexOf(":");
  const host = colon >= 0 ? authority.slice(0, colon) : authority;
  const port = colon >= 0 ? authority.slice(colon + 1) : null;
  const hostOk = host.length > 0 && host.length <= 253 && /^[a-z0-9.-]+$/.test(host) && !/^[.-]|[.-]$/.test(host);
  const portOk = port === null || (/^[0-9]{1,5}$/.test(port) && +port >= 1 && +port <= 65535);
  return hostOk && portOk ? `https://${authority}` : null;
}

const isOrigin = (o: string, dev = false) => originOf(o, dev) === o;

function texts(w: Writer, map: Record<string, string>): void {
  const keys = Object.keys(map).sort();
  w.u32(keys.length);
  for (const k of keys) w.string(k).string(map[k]!);
}

/** The manifest's Borsh form: what is hashed and signed. */
export function encodeManifest(m: Manifest): Uint8Array {
  const w = writeDeviceKey(new Writer().string(m.slug).u32(m.version).fixed(fromHex(m.owner, 32), 32), m.owner_key);
  texts(w, m.name);
  texts(w, m.description);
  w.fixed(fromHex(m.icon, 32), 32);
  if ("hosted" in m.entry) {
    const e = m.entry.hosted;
    w.u8(0).string(e.url).u32(e.origins.length);
    e.origins.forEach((o) => w.string(o));
  } else if ("sealed" in m.entry) {
    const e = m.entry.sealed;
    w.u8(1).fixed(fromHex(e.bundle, 32), 32).u64(e.size).u32(e.sources.length);
    e.sources.forEach((s) => w.string(s));
    w.string(e.start).u32(e.connect.length);
    e.connect.forEach((c) => w.string(c));
  } else if ("chat" in m.entry) {
    w.u8(2);
  } else {
    throw new TypeError("a manifest's entry: hosted, sealed or chat");
  }
  w.u32(m.permissions);
  if (m.sponsor === null) w.u8(0);
  else w.u8(1).fixed(fromHex(m.sponsor, 32), 32);
  return w.u16(m.min_host).done();
}

function readTexts(r: Reader): Record<string, string> {
  return Object.fromEntries(r.vec((r): [string, string] => [r.string(), r.string()]));
}

/** A manifest from its Borsh form, whole and canonical (what encodes back to the same bytes: no map out of order or
 *  repeated); throws otherwise. Its bounds are `manifestProblem`'s to check. */
export function decodeManifest(bytes: Uint8Array): Manifest {
  const r = new Reader(bytes);
  const slug = r.string();
  const version = r.u32();
  const owner = toHex(r.fixed(32));
  const owner_key = readDeviceKey(r);
  const name = readTexts(r);
  const description = readTexts(r);
  const icon = toHex(r.fixed(32));
  let entry: Entry;
  switch (r.u8()) {
    case 0: entry = { hosted: { url: r.string(), origins: r.vec((r) => r.string()) } }; break;
    case 1: entry = {
      sealed: {
        bundle: toHex(r.fixed(32)), size: r.u64n(), sources: r.vec((r) => r.string()), start: r.string(),
        connect: r.vec((r) => r.string()),
      },
    }; break;
    case 2: entry = { chat: {} }; break;
    default: throw new TypeError("borsh: a manifest's entry tag");
  }
  const permissions = r.u32();
  const sponsor = r.option((r) => toHex(r.fixed(32)));
  const min_host = r.u16();
  r.end();
  const m: Manifest = { slug, version, owner, owner_key, name, description, icon, entry, permissions, sponsor, min_host };
  if (toHex(encodeManifest(m)) !== toHex(bytes)) throw new TypeError("borsh: not the canonical form of a manifest");
  return m;
}

export const manifestId = (m: Manifest) => toHex(derive("Saltix grain manifest id v1", encodeManifest(m)));
export const manifestMessage = (m: Manifest) => derive("Saltix grain manifest v1", encodeManifest(m));
/** What a manifest names its icon or a sealed bundle by. */
export const iconHash = (png: Uint8Array) => toHex(derive("Saltix grain icon v1", png));
export const bundleHash = (zip: Uint8Array) => toHex(derive("Saltix grain bundle v1", zip));

/** The protocol version from which a sealed manifest may name no source (12-grains §2, 32-images §10): the network keeps
 *  its bundle, of at most 16 MiB. Before it, a sealed manifest names 1–8 sources. */
export const NETWORK_BUNDLES = 2;

/**
 * What is out of bounds in `m` (12-grains §2), or null. `dev` takes developer origins (`grain dev`). `protocol` is the
 * version of the blocks that would carry it: by default the newest rules, as a reader takes a manifest; a network
 * before `NETWORK_BUNDLES` refuses a sealed manifest without a source (`sources`).
 */
export function manifestProblem(m: Manifest, dev = false, protocol = NETWORK_BUNDLES): string | null {
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(m.slug)) return "slug";
  if (!Number.isInteger(m.version) || m.version < 1 || m.version > 0xffffffff) return "version";
  if (typeof m.owner !== "string" || !/^[0-9a-f]{64}$/.test(m.owner)) return "owner";
  if (deviceKeyOf(m.owner_key) === null) return "owner_key";
  const textsOk = (map: Record<string, string>, max: number) =>
    Object.keys(map).length <= 16 &&
    Object.entries(map).every(([lang, t]) => /^[a-z-]{2,8}$/.test(lang) && t.length > 0 && [...t].length <= max && !/\p{Cc}/u.test(t));
  if (!textsOk(m.name, 32) || !("en" in m.name)) return "name";
  if (!textsOk(m.description, 200)) return "description";
  if ("hosted" in m.entry) {
    const e = m.entry.hosted;
    if (e.origins.length < 1 || e.origins.length > 4 || !e.origins.every((o) => isOrigin(o, dev))) return "origins";
    const o = originOf(e.url, dev);
    if (e.url.length > 2048 || o === null || !e.origins.includes(o)) return "url";
  } else if ("sealed" in m.entry) {
    const e = m.entry.sealed;
    if (!(e.size >= 1 && e.size <= 20 * 1024 * 1024)) return "size";
    if ((e.sources.length === 0 && protocol < NETWORK_BUNDLES) || e.sources.length > 8 ||
      !e.sources.every((s) => s.length <= 2048 && originOf(s, dev) !== null)) return "sources";
    // With no source, the bundle is one the network keeps: at most 16 MiB (32-images §6.2).
    if (e.sources.length === 0 && e.size > MAX_NETWORK_BUNDLE_BYTES) return "size";
    const parts = e.start.split("/");
    if (!/^[A-Za-z0-9._/-]{1,256}$/.test(e.start) || e.start.startsWith("/") || parts.some((p) => p === "" || p === "." || p === ".."))
      return "start";
    if (e.connect.length > 8 || !e.connect.every((o) => isOrigin(o))) return "connect";
  } else if ("chat" in m.entry) {
    // A chat-only grain has no page, so nothing a page asks for: its notifications only (24-app-studio §2).
    if (typeof m.entry.chat !== "object" || m.entry.chat === null || Object.keys(m.entry.chat).length > 0) return "entry";
    if ((m.permissions & ~PERMISSIONS.notifications) !== 0) return "entry";
  } else {
    return "entry";
  }
  if ((m.permissions & ~127) !== 0) return "permissions";
  if (!Number.isInteger(m.min_host) || m.min_host < 1 || m.min_host > 0xffff) return "min_host";
  return null;
}

/** Whether `m` is a chat-only grain (`Entry::Chat`): no page, no origin. */
export const isChatOnly = (m: Manifest): boolean => "chat" in m.entry;

/** Sign `m` with the owner key's 32-byte Ed25519 secret: the JSON form to publish. `dev` takes developer origins. (A
 *  managed account's phone signs with P-256 in its wallet.) */
export function signManifest(m: Manifest, ownerSecret: Uint8Array, dev = false): SignedManifest {
  const own = toHex(ed25519.getPublicKey(ownerSecret));
  if (!("ed25519" in m.owner_key) || m.owner_key.ed25519 !== own) throw new TypeError("owner_key is not the secret's");
  const problem = manifestProblem(m, dev);
  if (problem) throw new TypeError(`manifest: ${problem}`);
  return { manifest: m, signature: toHex(ed25519.sign(manifestMessage(m), ownerSecret)) };
}

/** Whether `signed` is in bounds and signed by its owner key. That the key speaks for `owner` is the chain's to check
 *  (the owner's account at a node). */
export function verifyManifest(signed: SignedManifest, dev = false): boolean {
  try {
    return manifestProblem(signed.manifest, dev) === null &&
      verifyByDeviceKey(signed.manifest.owner_key, manifestMessage(signed.manifest), signed.signature);
  } catch {
    return false;
  }
}
