// `grain profile` and `grain connect-profile` (Saltix 19-connect §11, 12-grains §10): a grain's Connect profile set in
// the registry — the owner's wallet signs it from a QR code, or a key file on test networks — and a website's signed by
// its operator's key and written where the site serves it.
import {
  type ConnectProfile, type GrainCall, type NodeLike, type RegisteredGrain, type SignedConnectProfile, CATEGORIES, CONNECT_PROFILE_PATH, categoryOf, checkSiteProfile,
  decodeAddress, encodeProfile, grainGet, plainOwnerOf, profileLink, profileProblem, signProfile, signedProfileFromJson, toHex, unownedProfile,
} from "@saltix/grain-server";
import { existsSync, readFileSync } from "node:fs";
import { CONNECT_FILE, profileOfProject } from "./connect.js";
import { ownGrain } from "./studio.js";

/** The project file's profile, checked as the network checks it, for `owner` at `revision`; throws with the reason. */
function checkedProfile(value: unknown, owner: string, revision: number): ConnectProfile {
  const profile = profileOfProject(value, owner, revision);
  const problem = profileProblem(profile);
  if (problem) throw new Error(`${CONNECT_FILE}: ${problem}: out of bounds (Saltix 19-connect §11.1); grain lint says more`);
  return profile;
}

/** The revision a new profile takes: one above the highest the registry took (`profile_revision`, which outlives a
 *  cleared profile), or above the profile it holds on a node that does not say. */
const nextRevision = (g: RegisteredGrain): number => Math.max(g.profile_revision ?? 0, g.profile?.profile.revision ?? 0) + 1;

/** The owner's call that sets the project's profile for `slug`, signed with the key file's `secret`: its account the
 *  owner, the registry's revision and one. */
export async function profileCall(node: NodeLike, slug: string, value: unknown, secret: Uint8Array): Promise<GrainCall> {
  const g = await ownGrain(node, slug, secret);
  const profile = checkedProfile(value, plainOwnerOf(secret), nextRevision(g));
  return { profile: { slug, profile: signProfile(profile, secret) } };
}

/** The owner's call that clears `slug`'s profile; refused when there is none. */
export async function clearCall(node: NodeLike, slug: string, secret?: Uint8Array): Promise<GrainCall> {
  const g = secret ? await ownGrain(node, slug, secret) : await grainGet(node, slug);
  if (g === null) throw new Error(`${slug}: not registered`);
  if (!g.profile) throw new Error(`${slug}: has no Connect profile to clear`);
  return { profile: { slug, profile: null } };
}

/** The link the owner's Saltix sets the project's profile from (12-grains §10), after what the registry says rules it
 *  out; and the revision it holds now, which the wallet's profile goes above. */
export async function profileLinkFor(node: NodeLike, slug: string, value: unknown): Promise<{ link: string; profile: ConnectProfile; before: number }> {
  const g = await grainGet(node, slug);
  if (g === null) throw new Error(`${slug}: not registered yet: grain publish first`);
  if (g.retired !== null) throw new Error(`${slug}: retired at slot ${g.retired}`);
  // Checked as the wallet will check it once it fills in the owner and the revision.
  const profile = checkedProfile(value, g.owner, nextRevision(g));
  try {
    return { link: profileLink(profile), profile, before: nextRevision(g) - 1 };
  } catch {
    throw new Error(`${CONNECT_FILE}: too long for a QR code: set it in Saltix's app studio (My apps → ${slug} → Connect profile), or with --key on a test network`);
  }
}

/** The profile the registry holds once the owner's wallet set `profile` (any owner key, a revision above `before`);
 *  null after `ms`. */
export async function waitForProfile(node: NodeLike, slug: string, profile: ConnectProfile, before: number, ms: number, every = 3000, onWait?: () => void): Promise<SignedConnectProfile | null> {
  const wanted = toHex(encodeProfile(unownedProfile(profile)));
  const end = Date.now() + ms;
  for (;;) {
    const p = (await grainGet(node, slug))?.profile;
    if (p && p.profile.revision > before && toHex(encodeProfile(unownedProfile(p.profile))) === wanted) return p;
    if (Date.now() >= end) return null;
    onWait?.();
    await new Promise((r) => setTimeout(r, every));
  }
}

/** A site's profile is read in at most this many bytes, as a wallet reads it (19-connect §11.3). */
const SITE_PROFILE_MAX = 64 * 1024;

/**
 * The revision of the profile `origin` serves now at its well-known path, read as a wallet reads it (no cookies, no
 * redirect followed, at most 64 KiB, within `timeoutMs`): 0 when it serves none (404, 410) or another origin's, null
 * when it cannot be told (unreachable, a redirect, another error, something that is no profile). A wallet keeps a site's
 * profile and replaces it only with a higher revision, so the next one goes above this.
 */
export async function servedSiteRevision(origin: string, fetcher: typeof fetch = fetch, timeoutMs = 5_000): Promise<number | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetcher(wellKnownOf(origin), { redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: abort.signal });
    if (res.status === 404 || res.status === 410) return 0;
    if (res.status !== 200) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > SITE_PROFILE_MAX) return null;
    const signed = signedProfileFromJson(JSON.parse(new TextDecoder().decode(body)));
    const subject = signed.profile.subject;
    return "site" in subject && subject.site.origin === origin ? signed.profile.revision : 0;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SiteProfileInput {
  /** The project file's fields: texts and links; a `subject` of a site is taken unless the flags name it. */
  value: unknown;
  origin?: string;
  name?: string;
  category?: string;
  revision?: number;
  /** What the site serves now (`servedSiteRevision`): its revision, 0 for none, null when it cannot be told. */
  served: (origin: string) => Promise<number | null>;
  /** The file written before, if any: the next revision goes above its own for the same origin. */
  previous?: string;
  /** The operator's account (an address or its id in hex) when the key is one of its devices; the key's own account
   *  by default. */
  owner?: string;
}

/** An account id in hex from an address or the id itself. */
function accountOf(text: string): string {
  const decoded = decodeAddress(text);
  if (decoded) return toHex(decoded.id);
  if (/^[0-9a-f]{64}$/.test(text)) return text;
  throw new Error(`--owner ${text}: an address (dsalt1…) or an account id in hex`);
}

/**
 * A website's profile (subject `site`) signed with the operator's key file: its JSON form, which the site serves at
 * `/.well-known/saltix-connect`. Its revision, unless given, goes above both the one the site serves now and the file
 * written before; when neither can be told (the site cannot be read and no file of it is here), it asks for one rather
 * than start at 1, which a wallet that keeps a higher revision would never take.
 */
export async function siteProfile(input: SiteProfileInput, secret: Uint8Array): Promise<SignedConnectProfile> {
  const value = (typeof input.value === "object" && input.value !== null ? input.value : {}) as Record<string, unknown>;
  const given = (value.subject as { site?: { origin?: unknown; name?: unknown; category?: unknown } } | undefined)?.site ?? {};
  const origin = input.origin ?? (typeof given.origin === "string" ? given.origin : undefined);
  const name = input.name ?? (typeof given.name === "string" ? given.name : undefined);
  const category = input.category !== undefined ? categoryOf(input.category) : typeof given.category === "number" ? categoryOf(given.category) : null;
  if (origin === undefined) throw new Error("--origin https://…: the site's origin as a browser serializes it (no path, no trailing /)");
  if (name === undefined) throw new Error("--name: what the site goes by, 1 to 32 characters");
  if (category === null) throw new Error(`--category: 0 to 9, or ${CATEGORIES.join(", ")}`);
  const { owner: _owner, revision: _revision, ...rest } = value;
  const owner = input.owner === undefined ? plainOwnerOf(secret) : accountOf(input.owner);
  const at = (revision: number) =>
    profileOfProject({ ...rest, version: rest.version ?? 1, subject: { site: { origin, name, category } } }, owner, revision);
  // Everything that fails whatever the revision fails first, before the site is asked.
  const problem = profileProblem(at(input.revision ?? 1));
  if (problem) throw new Error(`the site's profile: ${problem}: out of bounds (Saltix 19-connect §11.1)`);
  let revision = input.revision;
  if (revision === undefined) {
    let previous = 0;
    if (input.previous !== undefined && existsSync(input.previous)) {
      try {
        const old = signedProfileFromJson(JSON.parse(readFileSync(input.previous, "utf8")));
        if ("site" in old.profile.subject && old.profile.subject.site.origin === origin) previous = old.profile.revision;
      } catch {
        /* not a profile: nothing to go above */
      }
    }
    const served = await input.served(origin);
    if (served === null && previous === 0) {
      throw new Error(`could not read the profile ${origin} serves now, and no file of it is here: pass --revision N above the ` +
        "revision it serves (a wallet keeps a higher one and never takes a lower)");
    }
    revision = Math.max(previous, served ?? 0) + 1;
  }
  const profile = at(revision);
  const signed = signProfile(profile, secret);
  const check = checkSiteProfile(signed, origin);
  if (check) throw new Error(`the site's profile: ${check}`);
  return signed;
}

/** Where a site serves its profile, for people. */
export const wellKnownOf = (origin: string): string => origin + CONNECT_PROFILE_PATH;
