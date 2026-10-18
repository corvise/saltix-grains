// A page's offer (Saltix 19-connect §3): its slot at a relay, its session's keys, its origin and its name, as the QR
// code's text and as the link that opens Saltix on the phone the page is on. The rules are `saltix-types` `connect`'s,
// and vectors/connect-v1.json holds offers refused for each. A port of the explorer's own.
import { connectOriginOk, refusedChar } from "@saltix/grain-server/web";
import { b64url, fromB64url } from "./codec.js";

export const OFFER_PREFIX = "saltix-connect:1:";
/** The link: the offer follows the `#`, which never reaches a server. */
export const LINK_PREFIX = "https://saltix.io/connect#";
/** An offer's name at most, bytes. */
export const MAX_NAME = 40;

export interface Offer {
  /** The node key of the relay that holds the slot. */
  relay: Uint8Array;
  sid: Uint8Array;
  /** `Q`: the X25519 key payloads are sealed to. */
  boxKey: Uint8Array;
  /** `P`: the session's Ed25519 key, which the login names. */
  page: Uint8Array;
  origin: string;
  name: string;
}

export type OfferRefusal = "scheme" | "fields" | "value" | "origin" | "name";

const encoder = new TextEncoder();

export function offerText(o: Offer): string {
  return OFFER_PREFIX + [o.relay, o.sid, o.boxKey, o.page, encoder.encode(o.origin), encoder.encode(o.name)].map(b64url).join(":");
}

export const offerLink = (o: Offer): string => LINK_PREFIX + offerText(o);

/** A page's name as an offer carries it: 1–40 bytes, no control, format or bidirectional character, no line or
 *  paragraph separator. */
export function nameOk(name: string): boolean {
  if (name.length === 0 || encoder.encode(name).length > MAX_NAME || /\p{Cs}/u.test(name)) return false;
  for (const ch of name) if (refusedChar(ch.codePointAt(0)!)) return false;
  return true;
}

/** An offer from its text or its link, by every rule of §3; the refusal's reason otherwise. */
export function parseOffer(input: string): Offer | OfferRefusal {
  const text = input.startsWith(LINK_PREFIX) ? input.slice(LINK_PREFIX.length) : input;
  if (!text.startsWith(OFFER_PREFIX)) return "scheme";
  const values = text.slice(OFFER_PREFIX.length).split(":");
  if (values.length !== 6) return "fields";
  const decoded = values.map(fromB64url);
  const keys = decoded.slice(0, 4);
  if (keys.some((k) => !k || k.length !== 32)) return "value";
  let origin: string;
  let name: string;
  try {
    // A leading U+FEFF stays in the text (and is refused there), as the node reads it.
    const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    if (!decoded[4] || !decoded[5]) return "value";
    origin = strict.decode(decoded[4]);
    name = strict.decode(decoded[5]);
  } catch {
    return "value";
  }
  if (!connectOriginOk(origin)) return "origin";
  if (!nameOk(name)) return "name";
  return { relay: keys[0]!, sid: keys[1]!, boxKey: keys[2]!, page: keys[3]!, origin, name };
}
