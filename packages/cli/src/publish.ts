// The link that asks the owner's wallet to publish a grain (Saltix 12-grains §10): the manifest's Borsh form with
// `owner` and `owner_key` zeroed — the wallet fills in its account and the key that speaks for it — raw DEFLATE,
// base64url. The server SDK writes and reads it (an app's program also sends it to its console as a card's `Publish`
// action, 22-grain-chats §4).
import { encodeManifest, readPublishLink } from "@saltix/grain-server";

export { MAX_PUBLISH_LINK, publishLink } from "@saltix/grain-server";

/** The manifest bytes a publish link carries, its owner zero; null when it is not one. */
export function publishLinkManifest(link: string): Uint8Array | null {
  try {
    return encodeManifest(readPublishLink(link));
  } catch {
    return null;
  }
}
