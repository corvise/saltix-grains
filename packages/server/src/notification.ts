import { ed25519 } from "@noble/curves/ed25519";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { type InvoiceKeyCert, readCert, signerOf, writeCert } from "./invoice.js";
import { type DeviceKey, verifyByDeviceKey } from "./keys.js";

/**
 * A grain's notification to a user (12-grains §5.5): sealed to the user's key in the grain and sent as
 * a kept frame through the relays (`RelayClient.notify`). The wallet shows it — with the grain closed —
 * when the user allowed the grain's notifications and the checks of `notificationProblem` pass.
 */
export interface GrainNotification {
  slug: string;
  /** 1–64 characters, no control characters. */
  title: string;
  /** At most 256 characters, no control characters. */
  body: string;
  /** Opens the grain with it (`grain_info.start`): 1–64 of `[A-Za-z0-9_-]`. */
  start?: string | null;
  /** Unix ms. */
  at: number;
}

export const NOTIFICATION_LIMITS = {
  title: 64,
  body: 256,
  /** A wallet drops notifications older than this. */
  maxAgeMs: 7 * 86_400_000,
  /** …or further ahead of its clock than this. */
  aheadMs: 5 * 60_000,
  /** A wallet shows at most this many a day per grain. */
  perDay: 10,
} as const;

const textOk = (text: string, min: number, max: number) => {
  const n = [...text].length;
  return n >= min && n <= max && !/\p{Cc}/u.test(text);
};
const startOk = (start: string) => /^[A-Za-z0-9_-]{1,64}$/.test(start);

export function encodeNotification(n: GrainNotification): Uint8Array {
  if (!textOk(n.title, 1, NOTIFICATION_LIMITS.title)) throw new TypeError("title: 1 to 64 characters, no control characters");
  if (!textOk(n.body, 0, NOTIFICATION_LIMITS.body)) throw new TypeError("body: at most 256 characters, no control characters");
  if (n.start != null && !startOk(n.start)) throw new TypeError("start: 1 to 64 of [A-Za-z0-9_-]");
  const w = new Writer().string(n.slug).string(n.title).string(n.body);
  if (n.start != null) w.u8(1).string(n.start);
  else w.u8(0);
  return w.u64(n.at).done();
}

/** What the signer signs: the notification on the network of `genesisHash` (hex). */
export function notificationMessage(n: GrainNotification, genesisHash: string): Uint8Array {
  return derive("Salarium grain notification v1", fromHex(genesisHash, 32), encodeNotification(n));
}

/**
 * Sign `n` with `secret` — the owner's, or the server key's with the owner's `cert` for it — for the
 * network of `genesisHash`: the bytes `RelayClient.notify` seals to the user.
 */
export function signNotification(n: GrainNotification, secret: Uint8Array, genesisHash: string, cert?: InvoiceKeyCert): Uint8Array {
  const signature = ed25519.sign(notificationMessage(n, genesisHash), secret);
  return writeCert(new Writer().raw(encodeNotification(n)), cert).raw(signature).done();
}

export function decodeNotification(bytes: Uint8Array): { notification: GrainNotification; cert: InvoiceKeyCert | null; signature: string } {
  const r = new Reader(bytes);
  const slug = r.string(64);
  const title = r.string(NOTIFICATION_LIMITS.title * 4);
  const body = r.string(NOTIFICATION_LIMITS.body * 4);
  const tag = r.u8();
  if (tag > 1) throw new TypeError("borsh: bad option");
  const start = tag === 1 ? r.string(64) : null;
  const notification: GrainNotification = { slug, title, body, start, at: Number(r.u64()) };
  const cert = readCert(r);
  const signature = toHex(r.fixed(64));
  r.end();
  return { notification, cert, signature };
}

/**
 * What a wallet checks (12-grains §5.5): why it would not show `bytes` as `slug`'s notification, or
 * null. `ownerKey` is the manifest's owner key.
 */
export function notificationProblem(bytes: Uint8Array, slug: string, ownerKey: DeviceKey, genesisHash: string, now = Date.now()): string | null {
  let decoded;
  try {
    decoded = decodeNotification(bytes);
  } catch {
    return "malformed";
  }
  const { notification: n, cert, signature } = decoded;
  if (n.slug !== slug) return "grain";
  if (!textOk(n.title, 1, NOTIFICATION_LIMITS.title) || !textOk(n.body, 0, NOTIFICATION_LIMITS.body)) return "text";
  if (n.start != null && !startOk(n.start)) return "start";
  if (n.at + NOTIFICATION_LIMITS.maxAgeMs < now || n.at > now + NOTIFICATION_LIMITS.aheadMs) return "time";
  const signer = signerOf(cert, slug, ownerKey, now);
  if (!signer) return "cert";
  return verifyByDeviceKey(signer, notificationMessage(n, genesisHash), signature) ? null : "signature";
}
