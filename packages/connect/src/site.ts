// A website's Connect profile as a wallet reads it (Saltix 19-connect §11.3): the signed JSON form at
// `/.well-known/saltix-connect` of the offer's origin — no cookies, no referrer, no redirect, at most 64 KiB, within 5
// seconds — taken when it reads strictly, it is the profile of that origin, and its key speaks for its owner by the
// owner's key event log. A site checks its own with it (a status page, its tests), and so may anyone listing sites.
// Signing a profile is the operator's, once, with a key that never comes near a page: `grain connect-profile`. A profile
// of format 2 may name its operator's own Saltix address as its support contact (19-connect §11.1), held to the
// network as a wallet holds it.
import {
  type AccountPolicy, type NetworkName, type ProfileReason, type SignedConnectProfile, CONNECT_PROFILE_PATH, ProfileError, checkProfileOwner,
  checkSiteProfile, fromHex, signedProfileFromJson, toHex,
} from "@saltix/grain-server/web";
import { type KeyLogAnswer, type NodeLike, nodeCall } from "./node.js";

/** The most a wallet reads of a site's profile. */
export const MAX_SITE_PROFILE_BYTES = 64 * 1024;
/** How long a wallet waits for it. */
export const SITE_PROFILE_MS = 5_000;

/** Why a site's profile is not shown: a profile's reason, or `fetch` (none served, a redirect, an error, too slow),
 *  `size` (more than 64 KiB), `json` (not its JSON form). */
export type SiteProfileProblem = ProfileReason | "fetch";

export interface SiteProfile {
  /** The profile read, when it read at all (shown only when `problem` is null). */
  profile: SignedConnectProfile | null;
  problem: SiteProfileProblem | null;
}

/**
 * Check a site's profile document (its JSON form, parsed) for `origin`, the owner's key event log (`account_log`'s
 * events' Borsh) under the network's genesis hash and first account policy: what a wallet decides. With `network`
 * (`node_status`'s), a support address must be of it, as a wallet holds it to its own.
 */
export function checkSiteProfileDocument(document: unknown, origin: string, events: Uint8Array[], genesis: Uint8Array, policy: AccountPolicy,
  network?: NetworkName): SiteProfile {
  let profile: SignedConnectProfile;
  try {
    profile = signedProfileFromJson(document);
  } catch (e) {
    return { profile: null, problem: e instanceof ProfileError ? e.reason : "json" };
  }
  const problem = checkSiteProfile(profile, origin, { network, genesis: toHex(genesis) }) ?? checkProfileOwner(profile, events, genesis, policy);
  return { profile, problem };
}

export interface ReadSiteProfileOptions {
  /** The wallet interface the owner's key event log is read from. */
  node: NodeLike;
  /** The network's genesis hash and first account policy (`node_status`). */
  genesis: string;
  policy: AccountPolicy;
  /** The network's kind (`node_status`'s `network`): a support address must be of it. Any network without it. */
  network?: NetworkName;
  fetch?: typeof fetch;
}

/** Fetch and check the profile `origin` serves, as a wallet does. */
export async function readSiteProfile(origin: string, o: ReadSiteProfileOptions): Promise<SiteProfile> {
  const get = o.fetch ?? fetch;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SITE_PROFILE_MS);
  let text: string;
  try {
    const response = await get(origin + CONNECT_PROFILE_PATH, {
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: abort.signal,
    });
    if (!response.ok) return { profile: null, problem: "fetch" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_SITE_PROFILE_BYTES) return { profile: null, problem: "size" };
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { profile: null, problem: "fetch" };
  } finally {
    clearTimeout(timer);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { profile: null, problem: "json" };
  }
  let profile: SignedConnectProfile;
  try {
    profile = signedProfileFromJson(document);
  } catch (e) {
    return { profile: null, problem: e instanceof ProfileError ? e.reason : "json" };
  }
  const problem = checkSiteProfile(profile, origin, { network: o.network, genesis: o.genesis });
  if (problem) return { profile, problem };
  // The key is checked against the owner's key event log as the node has it now.
  let events: Uint8Array[];
  try {
    const log = await nodeCall<KeyLogAnswer>(o.node, "account_log", { address: profile.profile.owner });
    events = log.events.map((e) => fromHex(e.event));
  } catch {
    return { profile, problem: "key" };
  }
  return { profile, problem: checkProfileOwner(profile, events, fromHex(o.genesis, 32), o.policy) };
}
