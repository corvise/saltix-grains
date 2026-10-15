// What an app reports about its own use (Saltix 24-app-studio §6a): its users and requests, counted by its server and
// signed by a server key the grain's registry record names. A wallet shows them as reported by the app, never as fact.
// Byte for byte vectors/grain-chats-v1.json.
//
// No Node APIs here: the simulator runs it in a browser.
import { ed25519 } from "@noble/curves/ed25519";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";

export const STATS_DOMAIN = "Saltix grain stats v1";
/** The oldest numbers a wallet shows: 2 days, ms. */
export const STATS_MAX_AGE_MS = 2 * 86_400_000;
/** How far ahead of the wallet's clock they may be dated, ms. */
export const STATS_AHEAD_MS = 5 * 60_000;
/** How often a server publishes them, at most: hourly. */
export const STATS_EVERY_MS = 3_600_000;

/** Distinct grain keys that sent a request in the last day and the last 30 days, and the requests of the last 30 days,
 *  at `at` (Unix ms). */
export interface GrainStats {
  slug: string;
  at: number;
  users_1d: number;
  users_30d: number;
  requests_30d: number;
}

/** The numbers with the registered server key (hex) that signed them. */
export interface SignedGrainStats {
  stats: GrainStats;
  key: string;
  signature: string;
}

/** Why a wallet would not show the numbers, as the reference names it (`StatsError`). */
export type StatsProblem = "grain" | "key" | "time" | "inconsistent" | "signature";

const u32 = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new TypeError(`${what}: an integer from 0 to 2^32 - 1`);
  return n;
};
const u53 = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${what}: an integer from 0 to 2^53 - 1`);
  return n;
};

export function writeGrainStats(w: Writer, s: GrainStats): Writer {
  return w.string(s.slug).u64(u53(s.at, "at")).u32(u32(s.users_1d, "users_1d")).u32(u32(s.users_30d, "users_30d")).u64(u53(s.requests_30d, "requests_30d"));
}

export function readGrainStats(r: Reader): GrainStats {
  return { slug: r.string(), at: r.u64n(), users_1d: r.u32(), users_30d: r.u32(), requests_30d: r.u64n() };
}

export function writeSignedGrainStats(w: Writer, s: SignedGrainStats): Writer {
  return writeGrainStats(w, s.stats).fixed(fromHex(s.key, 32), 32).fixed(fromHex(s.signature, 64), 64);
}

export function readSignedGrainStats(r: Reader): SignedGrainStats {
  return { stats: readGrainStats(r), key: toHex(r.fixed(32)), signature: toHex(r.fixed(64)) };
}

export const encodeGrainStats = (s: GrainStats): Uint8Array => writeGrainStats(new Writer(), s).done();
export const encodeSignedGrainStats = (s: SignedGrainStats): Uint8Array => writeSignedGrainStats(new Writer(), s).done();

/** The Borsh (bytes, or hex as the well-known document carries it) of signed numbers, read back. */
export function decodeSignedGrainStats(bytes: Uint8Array | string): SignedGrainStats {
  const r = new Reader(typeof bytes === "string" ? fromHex(bytes) : bytes);
  const s = readSignedGrainStats(r);
  r.end();
  return s;
}

/** What the server key signs: the numbers on the network of `genesis` (hex). */
export const grainStatsToSign = (s: GrainStats, genesis: string): Uint8Array => derive(STATS_DOMAIN, fromHex(genesis, 32), encodeGrainStats(s));

/** `s` signed by a registered server key's Ed25519 secret, for the network of `genesis`. */
export function signGrainStats(s: GrainStats, serverSecret: Uint8Array, genesis: string): SignedGrainStats {
  if (s.users_1d > s.users_30d || s.users_30d > s.requests_30d) throw new TypeError("stats: users_1d ≤ users_30d ≤ requests_30d");
  return { stats: s, key: toHex(ed25519.getPublicKey(serverSecret)), signature: toHex(ed25519.sign(grainStatsToSign(s, genesis), serverSecret)) };
}

/**
 * What a wallet checks before it shows the numbers (the reference's `SignedGrainStats::verify`, in its order), or null:
 * `slug`'s, signed by one of the `servers` its registry record names, at most 2 days old and 5 minutes ahead, and
 * consistent (a day's users are among the month's, and each of them sent a request).
 */
export function grainStatsProblem(s: SignedGrainStats, check: { genesis: string; slug: string; servers: string[]; now: number }): StatsProblem | null {
  const n = s.stats;
  if (n.slug !== check.slug) return "grain";
  if (!check.servers.includes(s.key)) return "key";
  if (n.at > check.now + STATS_AHEAD_MS || check.now - n.at > STATS_MAX_AGE_MS) return "time";
  if (n.users_1d > n.users_30d || n.users_30d > n.requests_30d) return "inconsistent";
  try {
    return ed25519.verify(fromHex(s.signature, 64), grainStatsToSign(n, check.genesis), fromHex(s.key, 32)) ? null : "signature";
  } catch {
    return "signature";
  }
}
