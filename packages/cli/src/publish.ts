// The link that asks the owner's wallet to publish a grain (Salarium 12-grains §10): the manifest's Borsh form with
// `owner` and `owner_key` zeroed — the wallet fills in its account and the key that speaks for it — raw DEFLATE,
// base64url.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { encodeManifest, MAX_TX_SIZE, UNOWNED, type Manifest } from "@salarium/grain-server";

/** A publish link is at most this long, and its manifest inflates to at most `MAX_TX_SIZE` bytes. */
export const MAX_PUBLISH_LINK = 2048;
const PREFIX = "salt:grain-publish?m=";

/** The link for `m`; throws when it would be too long for a QR code. */
export function publishLink(m: Manifest): string {
  const packed = deflateRawSync(encodeManifest({ ...m, ...UNOWNED }), { level: 9 });
  const link = PREFIX + Buffer.from(packed).toString("base64url");
  if (link.length > MAX_PUBLISH_LINK) {
    throw new Error(`the manifest makes a ${link.length}-character link, at most ${MAX_PUBLISH_LINK}: publish it with a key file`);
  }
  return link;
}

/** The manifest bytes a publish link carries; null when it is not one. */
export function publishLinkManifest(link: string): Uint8Array | null {
  if (!link.startsWith(PREFIX) || link.length > MAX_PUBLISH_LINK) return null;
  try {
    return new Uint8Array(inflateRawSync(Buffer.from(link.slice(PREFIX.length), "base64url"), { maxOutputLength: MAX_TX_SIZE }));
  } catch {
    return null;
  }
}
