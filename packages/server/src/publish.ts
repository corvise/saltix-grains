// A manifest on its way to the phone that signs it (Saltix 12-grains §10): its Borsh form with `owner` and
// `owner_key` zeroed — the wallet fills in its account and the key that speaks for it —, raw DEFLATE, base64url
// without padding. A publishing link carries it after `salt:grain-publish?m=`, and so does a chat card's `Publish`
// action, which an app's program sends its team in the console for the owner to approve (22-grain-chats §4).
//
// Reading is here, in plain TypeScript for any runtime (the simulator too); writing needs Node's zlib
// (`publish-link.ts`).
import { fromBase64 } from "./bytes.js";
import { inflateRaw } from "./inflate.js";
import { type Manifest, decodeManifest } from "./manifest.js";

/** What a publishing link starts with. */
export const PUBLISH_LINK_PREFIX = "salt:grain-publish?m=";
/** A publishing link's characters at most: what a QR code carries. */
export const MAX_PUBLISH_LINK = 2048;
/** The manifest's text at most, in a link or a `Publish` action: the link's limit less its prefix (2 027). */
export const MAX_PUBLISH_TEXT = MAX_PUBLISH_LINK - PUBLISH_LINK_PREFIX.length;
/** Bytes a manifest's text inflates to at most. */
export const MAX_PUBLISH_MANIFEST = 16_384;

/** The owner a publishing link leaves for the wallet to fill in: zero bytes, an Ed25519 key. */
export const UNOWNED = { owner: "00".repeat(32), owner_key: { ed25519: "00".repeat(32) } } as const;

/** Why a text is not a manifest to publish: `size`, `encoding` (not canonical base64url without padding), `inflate`
 *  (not one raw DEFLATE stream of at most 16 384 bytes with nothing after it), `manifest` (not the canonical Borsh of a
 *  manifest), `owned` (an owner or owner key filled in), `link` (not a publishing link). */
export type PublishProblem = "size" | "encoding" | "inflate" | "manifest" | "owned" | "link";

export class PublishTextError extends TypeError {
  constructor(readonly problem: PublishProblem) {
    super(`a manifest to publish: ${problem}`);
    this.name = "PublishTextError";
  }
}

/**
 * The manifest a link's or a card's `text` carries, its owner still zero, read strictly as every reader reads it: 1–2 027
 * characters of canonical base64url without padding, one raw DEFLATE stream with nothing after it, inflating to at most
 * 16 384 bytes, which are the canonical Borsh of a manifest whose `owner` and `owner_key` are zero. Throws a
 * `PublishTextError` otherwise. Its bounds (`manifestProblem`) are the publishing sheet's to check.
 */
export function readPublishText(text: string): Manifest {
  if (text.length === 0 || text.length > MAX_PUBLISH_TEXT) throw new PublishTextError("size");
  let packed: Uint8Array;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError("alphabet");
    packed = fromBase64(text, true);
  } catch {
    throw new PublishTextError("encoding");
  }
  const borsh = inflateRaw(packed, MAX_PUBLISH_MANIFEST);
  if (borsh === null) throw new PublishTextError("inflate");
  let m: Manifest;
  try {
    m = decodeManifest(borsh);
  } catch {
    throw new PublishTextError("manifest");
  }
  if (m.owner !== UNOWNED.owner || !("ed25519" in m.owner_key) || m.owner_key.ed25519 !== UNOWNED.owner_key.ed25519) {
    throw new PublishTextError("owned");
  }
  return m;
}

/** The manifest of a publishing link, its owner still zero; throws a `PublishTextError` otherwise. */
export function readPublishLink(link: string): Manifest {
  if (!link.startsWith(PUBLISH_LINK_PREFIX)) throw new PublishTextError("link");
  return readPublishText(link.slice(PUBLISH_LINK_PREFIX.length));
}

/** The manifest's text of `linkOrText`: a publishing link's part after its prefix, or the text itself. */
export const publishTextOf = (linkOrText: string): string =>
  linkOrText.startsWith(PUBLISH_LINK_PREFIX) ? linkOrText.slice(PUBLISH_LINK_PREFIX.length) : linkOrText;
