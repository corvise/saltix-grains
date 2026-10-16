// Writing a grain's Connect profile for the owner's wallet to sign (Saltix 12-grains §10): the link `grain profile`
// shows as a QR code, `salt:grain-profile?p=` and base64url without padding of the raw DEFLATE of the profile's Borsh
// form with its owner and revision zero. Node's zlib compresses it; any runtime reads it back (`readProfileLink` in
// `profile.ts`), and a reader never compresses again, so another compressor's link is just as good.
import { deflateRawSync } from "node:zlib";
import { toBase64 } from "./bytes.js";
import {
  type ConnectProfile, MAX_PROFILE_BYTES, MAX_PROFILE_LINK, PROFILE_LINK_PREFIX, ProfileLinkError, encodeProfile, unownedProfile,
} from "./profile.js";

/** The link of a grain's profile `p` (its owner and revision are left out); throws a `ProfileLinkError`: `subject` for
 *  a site's profile, `size` when it would be longer than 2 048 characters (set such a profile in Saltix's app studio, or
 *  with a key file). */
export function profileLink(p: ConnectProfile): string {
  if (!("grain" in p.subject)) throw new ProfileLinkError("subject");
  const borsh = encodeProfile(unownedProfile(p));
  if (borsh.length > MAX_PROFILE_BYTES) throw new ProfileLinkError("size");
  const link = PROFILE_LINK_PREFIX + toBase64(new Uint8Array(deflateRawSync(borsh, { level: 9 })), true);
  if (link.length > MAX_PROFILE_LINK) throw new ProfileLinkError("size");
  return link;
}
