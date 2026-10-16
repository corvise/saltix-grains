// Writing a manifest for the owner's wallet to publish (Saltix 12-grains §10): as a link `grain publish` shows as a QR
// code, or as the text of a chat card's `Publish` action (22-grain-chats §4). Node's zlib compresses it; any runtime
// reads it back (`publish.ts`).
import { deflateRawSync } from "node:zlib";
import { toBase64 } from "./bytes.js";
import { type Manifest, encodeManifest } from "./manifest.js";
import { MAX_PUBLISH_MANIFEST, MAX_PUBLISH_TEXT, PUBLISH_LINK_PREFIX, UNOWNED } from "./publish.js";

/** The text a link or a card carries for `m`, its owner zeroed; throws when it would be longer than 2 027 characters
 *  (a manifest that large is published with a key file). */
export function publishText(m: Manifest): string {
  const borsh = encodeManifest({ ...m, ...UNOWNED });
  if (borsh.length > MAX_PUBLISH_MANIFEST) throw new RangeError(`the manifest is ${borsh.length} bytes, at most ${MAX_PUBLISH_MANIFEST}: publish it with a key file`);
  const text = toBase64(new Uint8Array(deflateRawSync(borsh, { level: 9 })), true);
  if (text.length > MAX_PUBLISH_TEXT) {
    throw new RangeError(`the manifest makes a ${PUBLISH_LINK_PREFIX.length + text.length}-character link, at most ${MAX_PUBLISH_TEXT + PUBLISH_LINK_PREFIX.length}: publish it with a key file`);
  }
  return text;
}

/** The publishing link of `m`: what `grain publish` shows as a QR code and the owner's Saltix opens. */
export const publishLink = (m: Manifest): string => PUBLISH_LINK_PREFIX + publishText(m);
