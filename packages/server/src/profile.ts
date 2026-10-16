// The Connect profile (Saltix 19-connect §11): what a service says about itself on Saltix Connect's sheet, in its own
// words, signed by a key that speaks for its owner's account. One format for mini-apps and websites:
// - a mini-app's (subject `grain`) lives in the registry beside its manifest: its owner sets it with `SetGrainProfile`
//   (12-grains §3, `GrainCall` `profile`), `grain_get` serves it, and a wallet checks it with `checkGrainProfile`;
// - a website's (subject `site`) is served by the site at `/.well-known/saltix-connect` in its JSON form, and a wallet
//   checks it with `checkSiteProfile` and, by the owner's key event log, `checkProfileOwner`.
//
// The TypeScript objects are the JSON form (bytes in lowercase hex, absent links null); Borsh is what is signed. Byte for
// byte `saltix-types` `connect::profile`, refusals and their reasons included (vectors/connect-profiles-v1.json). Plain
// TypeScript for any runtime (a page, the simulator); the profile link's writer needs Node's zlib (`profile-link.ts`).
import { ed25519 } from "@noble/curves/ed25519";
import { accountId } from "./address.js";
import { Reader, Writer, compareUtf8, derive, fromBase64, fromHex, toHex } from "./bytes.js";
import { handleProblem } from "./handle.js";
import { inflateRaw } from "./inflate.js";
import { type DeviceKey, deviceKeyOf, readDeviceKey, verifyByDeviceKey, writeDeviceKey } from "./keys.js";
import { type AccountPolicy, keySpeaksFor } from "./keylog.js";

/** The domain of the message a profile's key signs. */
export const PROFILE_DOMAIN = "Saltix connect profile v1";
/** The format's version, the profile's first byte. */
export const PROFILE_VERSION = 1;
/** A profile's Borsh form, at most. */
export const MAX_PROFILE_BYTES = 8192;
/** Where a site serves its signed profile, at its origin (19-connect §11.3). */
export const CONNECT_PROFILE_PATH = "/.well-known/saltix-connect";

/** The bounds of 19-connect §11.1: characters (Unicode scalar values) unless they say bytes. */
export const PROFILE_LIMITS = {
  /** Languages, 1 to this many, `en` among them. */
  languages: 8,
  /** A tagline: 1 to this many characters, one line. */
  tagline: 80,
  /** The about text: at most this many characters, line breaks allowed. */
  about: 600,
  /** Highlights, at most. */
  highlights: 4,
  /** A highlight: 1 to this many characters, one line. */
  highlight: 60,
  /** The privacy summary: at most this many characters, one line. */
  privacy: 300,
  /** A link (website, support, terms), bytes. */
  linkBytes: 256,
  /** A site's name: 1 to this many characters. */
  siteName: 32,
  /** A site's category: 0 to this (24-app-studio §6). */
  category: 9,
  /** An origin, bytes (19-connect §3). */
  originBytes: 128,
} as const;

/** Whom a profile speaks for: a mini-app by its slug (its name, icon and category are its manifest's and its registry
 *  record's), or a website by its origin as a browser serializes it, the name it goes by and a category. */
export type ProfileSubject = { grain: { slug: string } } | { site: { origin: string; name: string; category: number } };

/** A profile's words in one language. */
export interface ProfileText {
  /** What the service is, in one line. */
  tagline: string;
  /** What it does; may be empty; line breaks allowed. */
  about: string;
  /** What it is good at: short lines of fact. */
  highlights: string[];
  /** What it keeps about a user, and for how long; may be empty. */
  privacy: string;
}

/** What a service says about itself (19-connect §11.1): the `profile` object of the JSON form. */
export interface ConnectProfile {
  version: number;
  subject: ProfileSubject;
  /** The service's owner, an account id in hex: a grain's owner, a site's operator. The key that signs speaks for it. */
  owner: string;
  /** At least 1, raised with every change: a reader keeps the highest it saw, and the registry takes only a higher one. */
  revision: number;
  /** By language code: 1 to 8, `en` among them. */
  texts: Record<string, ProfileText>;
  /** An `https://` link. */
  website: string | null;
  /** An `https://` link, a `mailto:` address or a Saltix username (`@name`). */
  support: string | null;
  /** An `https://` link to its terms of use. */
  terms: string | null;
}

/** A profile with its signature: the JSON form a site serves and `grain_get` shows. */
export interface SignedConnectProfile {
  profile: ConnectProfile;
  /** A key that speaks for `owner` (13-accounts §5): Ed25519, or a phone's P-256 key. */
  key: DeviceKey;
  /** 64 bytes of hex over `profileMessage(profile)`: Ed25519, or ECDSA P-256 over its SHA-256 with a low `s`. */
  signature: string;
}

/** Why a profile is refused, as the vectors and every reader name it; checked in this order. */
export type ProfileReason =
  | "encoding"
  | "version"
  | "subject"
  | "revision"
  | "languages"
  | "tagline"
  | "about"
  | "highlights"
  | "privacy"
  | "website"
  | "support"
  | "terms"
  | "size"
  | "signature"
  | "service"
  | "owner"
  | "key"
  | "json";

export class ProfileError extends TypeError {
  constructor(
    readonly reason: ProfileReason,
    detail?: string,
  ) {
    super(detail ? `a Connect profile: ${reason} (${detail})` : `a Connect profile: ${reason}`);
    this.name = "ProfileError";
  }
}

// ── Texts, origins and links ─────────────────────────────────────────────────

/** The Unicode format characters (Cf) as of 15.1: the node's list (`connect::refused_char`), so every reader refuses
 *  the same whatever its Unicode tables. */
const FORMAT: [number, number][] = [
  [0x00ad, 0x00ad], [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f], [0x0890, 0x0891],
  [0x08e2, 0x08e2], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f],
  [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a], [0xe0001, 0xe0001], [0xe0020, 0xe007f],
];

/** Whether the code point is refused in a name or a profile's text: Unicode's control (Cc) and format (Cf, which holds
 *  the bidirectional controls) characters, and the line and paragraph separators. */
export function refusedChar(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || FORMAT.some(([lo, hi]) => code >= lo && code <= hi);
}

/** A text of `min`–`max` characters without a refused one (a line feed only where `lines`), neither starting nor ending
 *  with a space or a line feed: so a blank required text is none. A lone surrogate is no character at all. */
export function profileTextOk(text: unknown, min: number, max: number, lines: boolean): boolean {
  if (typeof text !== "string" || /\p{Cs}/u.test(text)) return false;
  const chars = [...text];
  return (
    chars.length >= min &&
    chars.length <= max &&
    chars.every((c) => (lines && c === "\n") || !refusedChar(c.codePointAt(0)!)) &&
    !/^[ \n]/.test(text) &&
    !/[ \n]$/.test(text)
  );
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;
const dnsLabelOk = (label: string): boolean => /^[a-z0-9-]{1,63}$/.test(label) && !label.startsWith("-") && !label.endsWith("-");

/**
 * An origin as a browser serializes it (`location.origin`, 19-connect §3): `https://` or `http://`, a lowercase ASCII
 * host (DNS labels, an internationalized name in its `xn--` form, or an IPv6 address in brackets) and a port other than
 * the scheme's default if the page has one; at most 128 bytes. The node's `connect::check_origin`.
 */
export function connectOriginOk(origin: unknown): boolean {
  if (typeof origin !== "string" || origin.length === 0 || utf8Length(origin) > PROFILE_LIMITS.originBytes) return false;
  let rest: string;
  let defaultPort: string;
  if (origin.startsWith("https://")) [rest, defaultPort] = [origin.slice(8), "443"];
  else if (origin.startsWith("http://")) [rest, defaultPort] = [origin.slice(7), "80"];
  else return false;
  let host: string | null;
  let port: string;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return false;
    const address = rest.slice(1, close);
    if (address.length < 2 || !address.includes(":") || !/^[0-9a-f:.]+$/.test(address)) return false;
    host = null;
    port = rest.slice(close + 1);
  } else {
    const at = rest.indexOf(":");
    host = at < 0 ? rest : rest.slice(0, at);
    port = at < 0 ? "" : rest.slice(at);
  }
  if (host !== null && (host.length === 0 || host.length > 253 || !host.split(".").every(dnsLabelOk))) return false;
  if (port !== "") {
    if (!port.startsWith(":")) return false;
    const digits = port.slice(1);
    if (!/^[1-9][0-9]{0,4}$/.test(digits) || Number(digits) > 65_535 || digits === defaultPort) return false;
  }
  return true;
}

/** An `https://` link a profile names (website, terms; 19-connect §11.1): at most 256 bytes of printable ASCII without
 *  spaces (an internationalized name in its `xn--` form, the rest percent-encoded), whose origin is one a browser
 *  serializes (no user, a lowercase host, no default port), then optionally a path, query or fragment. */
export function httpsLinkOk(link: unknown): boolean {
  if (typeof link !== "string" || link.length > PROFILE_LIMITS.linkBytes || !/^[\x21-\x7e]*$/.test(link)) return false;
  if (!link.startsWith("https://")) return false;
  const rest = link.slice(8);
  const end = rest.search(/[/?#]/);
  return connectOriginOk(`https://${end < 0 ? rest : rest.slice(0, end)}`);
}

/** A `mailto:` link of one address and nothing else: a local part of 1–64 of ``[A-Za-z0-9.!#$%&'*+/=^_`{|}~-]`` (no
 *  leading, trailing or double dot) and a lowercase domain of at least two labels. */
function mailtoOk(link: string): boolean {
  if (!link.startsWith("mailto:")) return false;
  const address = link.slice(7);
  const at = address.indexOf("@");
  if (at < 0) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const localOk = /^[A-Za-z0-9!#$%&'*+/=^_`{|}~.-]{1,64}$/.test(local) && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
  const domainOk = domain.length <= 253 && domain.includes(".") && domain.split(".").every(dnsLabelOk);
  return link.length <= PROFILE_LIMITS.linkBytes && localOk && domainOk;
}

/** Where users get help: an `https://` link, a `mailto:` address, or a Saltix username in its canonical form (`@name`,
 *  21-names). Anything else (`http:`, `javascript:`, `tel:`…) is refused, so a wallet never opens a link a profile
 *  could turn against it. */
export function supportOk(support: unknown): boolean {
  if (typeof support !== "string") return false;
  if (support.startsWith("@")) return handleProblem({ name: support.slice(1) }) === null;
  return httpsLinkOk(support) || mailtoOk(support);
}

/** A language code as maps of texts have them (12-grains §2): 2–8 of `[a-z-]`. */
export const languageOk = (lang: string): boolean => /^[a-z-]{2,8}$/.test(lang);

const SLUG = /^[a-z0-9][a-z0-9-]{2,31}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const byteKey = (v: unknown, size: number): boolean => typeof v === "string" && new RegExp(`^[0-9a-f]{${2 * size}}$`).test(v);
const integerIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The languages of `texts` in the node's order (their UTF-8 bytes): the order they are encoded and checked in. */
const languagesOf = (texts: Record<string, ProfileText>): string[] => Object.keys(texts).sort(compareUtf8);

// ── Borsh ────────────────────────────────────────────────────────────────────

function writeText(w: Writer, t: ProfileText): void {
  w.string(t.tagline).string(t.about).u32(t.highlights.length);
  for (const h of t.highlights) w.string(h);
  w.string(t.privacy);
}

function writeProfile(w: Writer, p: ConnectProfile): Writer {
  // Out-of-range integers would wrap silently in Borsh's fixed widths: they are refused instead.
  if (!integerIn(p.version, 0, 0xff) || !integerIn(p.revision, 0, 0xffff_ffff)) throw new TypeError("a profile's version or revision is out of range");
  w.u8(p.version);
  if ("grain" in p.subject) {
    w.u8(0).string(p.subject.grain.slug);
  } else if ("site" in p.subject) {
    const s = p.subject.site;
    if (!integerIn(s.category, 0, 0xff)) throw new TypeError("a site's category is out of range");
    w.u8(1).string(s.origin).string(s.name).u8(s.category);
  } else {
    throw new TypeError("a profile's subject: grain or site");
  }
  w.fixed(fromHex(p.owner, 32), 32).u32(p.revision);
  const langs = languagesOf(p.texts);
  w.u32(langs.length);
  for (const lang of langs) writeText(w.string(lang), p.texts[lang]!);
  const link = (w: Writer, v: string) => w.string(v);
  return w.option(p.website, link).option(p.support, link).option(p.terms, link);
}

/** The profile's Borsh form: what is signed and what `MAX_PROFILE_BYTES` bounds. Throws on a value Borsh cannot hold. */
export const encodeProfile = (p: ConnectProfile): Uint8Array => writeProfile(new Writer(), p).done();

/** A signed profile's Borsh form: as the registry's `SetGrainProfile` carries it. */
export function encodeSignedProfile(s: SignedConnectProfile): Uint8Array {
  const w = writeProfile(new Writer(), s.profile);
  writeDeviceKey(w, s.key);
  return w.fixed(fromHex(s.signature, 64), 64).done();
}

function readText(r: Reader): ProfileText {
  return { tagline: r.string(), about: r.string(), highlights: r.vec((r) => r.string()), privacy: r.string() };
}

function readProfile(r: Reader): ConnectProfile {
  const version = r.u8();
  const tag = r.u8();
  let subject: ProfileSubject;
  if (tag === 0) subject = { grain: { slug: r.string() } };
  else if (tag === 1) subject = { site: { origin: r.string(), name: r.string(), category: r.u8() } };
  else throw new TypeError(`borsh: a subject's tag ${tag}`);
  const owner = toHex(r.fixed(32));
  const revision = r.u32();
  // Entries by `fromEntries`: a key such as `__proto__` is an entry like any other, never the object's prototype.
  const texts = Object.fromEntries(r.vec((r): [string, ProfileText] => [r.string(), readText(r)]));
  const website = r.option((r) => r.string());
  const support = r.option((r) => r.string());
  const terms = r.option((r) => r.string());
  return { version, subject, owner, revision, texts, website, support, terms };
}

/** One canonical encoding: what decodes is encoded again and must be the same bytes (keys in order, none repeated). */
function canonical<T>(bytes: Uint8Array, read: (r: Reader) => T, write: (v: T) => Uint8Array): T {
  const r = new Reader(bytes);
  const value = read(r);
  r.end();
  if (toHex(write(value)) !== toHex(bytes)) throw new TypeError("borsh: not the canonical form");
  return value;
}

/** A signed profile from its Borsh form, which must be the canonical one with nothing after it; throws a
 *  `ProfileError` (`encoding`) otherwise. Its bounds and signature are `verifyProfile`'s to check. */
export function decodeSignedProfile(bytes: Uint8Array): SignedConnectProfile {
  try {
    return canonical(bytes, (r) => {
      const profile = readProfile(r);
      const key = readDeviceKey(r);
      return { profile, key, signature: toHex(r.fixed(64)) };
    }, encodeSignedProfile);
  } catch (e) {
    throw new ProfileError("encoding", e instanceof Error ? e.message : String(e));
  }
}

/** A profile alone from its canonical Borsh form (a profile link's); throws a `ProfileError` (`encoding`) otherwise. */
export function decodeProfile(bytes: Uint8Array): ConnectProfile {
  try {
    return canonical(bytes, readProfile, encodeProfile);
  } catch (e) {
    throw new ProfileError("encoding", e instanceof Error ? e.message : String(e));
  }
}

/** What the key signs: `derive("Saltix connect profile v1", Borsh(profile))`. */
export const profileMessage = (p: ConnectProfile): Uint8Array => derive(PROFILE_DOMAIN, encodeProfile(p));

// ── The checks ───────────────────────────────────────────────────────────────

function subjectOk(s: unknown): boolean {
  if (!isObject(s)) return false;
  if (isObject(s.grain)) return typeof s.grain.slug === "string" && SLUG.test(s.grain.slug);
  if (isObject(s.site)) {
    const { origin, name, category } = s.site;
    return connectOriginOk(origin) && profileTextOk(name, 1, PROFILE_LIMITS.siteName, false) && integerIn(category, 0, PROFILE_LIMITS.category);
  }
  return false;
}

function textProblem(t: unknown): ProfileReason | null {
  if (!isObject(t)) return "tagline";
  if (!profileTextOk(t.tagline, 1, PROFILE_LIMITS.tagline, false)) return "tagline";
  if (!profileTextOk(t.about, 0, PROFILE_LIMITS.about, true)) return "about";
  const h = t.highlights;
  if (!Array.isArray(h) || h.length > PROFILE_LIMITS.highlights || !h.every((x) => profileTextOk(x, 1, PROFILE_LIMITS.highlight, false))) {
    return "highlights";
  }
  if (!profileTextOk(t.privacy, 0, PROFILE_LIMITS.privacy, false)) return "privacy";
  return null;
}

/**
 * What is out of bounds in `p` (19-connect §11.1), in the order every reader checks: `version`, `subject`, `revision`,
 * `languages`, then each language's `tagline`, `about`, `highlights` and `privacy` (languages in the node's order),
 * `website`, `support`, `terms` and `size` (the Borsh form at most 8 192 bytes); null when it is in bounds. Never throws,
 * whatever `p` holds.
 */
export function profileProblem(p: ConnectProfile): ProfileReason | null {
  if (!isObject(p)) return "version";
  if (p.version !== PROFILE_VERSION) return "version";
  if (!subjectOk(p.subject)) return "subject";
  if (!integerIn(p.revision, 1, 0xffff_ffff)) return "revision";
  if (!byteKey(p.owner, 32)) return "owner";
  const texts = p.texts as unknown;
  if (!isObject(texts)) return "languages";
  const langs = languagesOf(texts as Record<string, ProfileText>);
  if (langs.length === 0 || langs.length > PROFILE_LIMITS.languages || !langs.includes("en") || !langs.every(languageOk)) return "languages";
  for (const lang of langs) {
    const problem = textProblem(texts[lang]);
    if (problem) return problem;
  }
  if (p.website !== null && !httpsLinkOk(p.website)) return "website";
  if (p.support !== null && !supportOk(p.support)) return "support";
  if (p.terms !== null && !httpsLinkOk(p.terms)) return "terms";
  if (encodeProfile(p).length > MAX_PROFILE_BYTES) return "size";
  return null;
}

/** In bounds and signed by its key: the reason it is not, or null. Whether the key speaks for the owner is the
 *  registry's to check for a grain, and `checkProfileOwner`'s for a site. */
export function verifyProfile(s: SignedConnectProfile): ProfileReason | null {
  const problem = profileProblem(s.profile);
  if (problem) return problem;
  if (deviceKeyOf(s.key) === null || !verifyByDeviceKey(s.key, profileMessage(s.profile), s.signature)) return "signature";
  return null;
}

/** Verified, and the profile of the grain `slug` owned by `owner` (hex), as its registry record has them: the reason it
 *  is not (`service` for another grain or a site, `owner` for another owner), or null. */
export function checkGrainProfile(s: SignedConnectProfile, slug: string, owner: string): ProfileReason | null {
  const problem = verifyProfile(s);
  if (problem) return problem;
  if (!("grain" in s.profile.subject) || s.profile.subject.grain.slug !== slug) return "service";
  return s.profile.owner === owner ? null : "owner";
}

/** Verified, and the profile of the site of `origin` (the offer's): the reason it is not, or null. */
export function checkSiteProfile(s: SignedConnectProfile, origin: string): ProfileReason | null {
  const problem = verifyProfile(s);
  if (problem) return problem;
  return "site" in s.profile.subject && s.profile.subject.site.origin === origin ? null : "service";
}

/**
 * Whether the profile's key speaks for its owner now (13-accounts §5), by the owner's key event log as a node gives it
 * (`account_log`: each event's Borsh), checked offline under the network's genesis hash and first account `policy`:
 * the owner's own Ed25519 key while the log is empty, else a current device of the controller it replays, a guardian
 * excepted. The kind 0 key of an account that upgraded speaks for nothing. `key`, or null.
 */
export function checkProfileOwner(s: SignedConnectProfile, events: Uint8Array[], genesis: Uint8Array, policy: AccountPolicy): "key" | null {
  try {
    return keySpeaksFor(s.key, fromHex(s.profile.owner, 32), events, genesis, policy).problem === null ? null : "key";
  } catch {
    return "key";
  }
}

/** The words for a reader of `lang`: its own language, else English. */
export const profileText = (p: ConnectProfile, lang: string): ProfileText => p.texts[lang] ?? p.texts.en!;

/** Sign `p` with a plain account's own 32-byte Ed25519 secret, or a device's; throws a `ProfileError` when it is out of
 *  bounds. (A managed account's phone signs with P-256 in its wallet.) */
export function signProfile(p: ConnectProfile, secret: Uint8Array): SignedConnectProfile {
  const problem = profileProblem(p);
  if (problem) throw new ProfileError(problem);
  return { profile: p, key: { ed25519: toHex(ed25519.getPublicKey(secret)) }, signature: toHex(ed25519.sign(profileMessage(p), secret)) };
}

/** The account a plain key's profile names as its owner: the key's own (kind 0). */
export const plainOwnerOf = (secret: Uint8Array): string => toHex(accountId(ed25519.getPublicKey(secret)));

// ── The JSON form ────────────────────────────────────────────────────────────

/**
 * The JSON form of `s` as a site serves it at `/.well-known/saltix-connect` and the wallet interface shows it: the fields
 * by name, bytes in lowercase hex, absent links null. The signature covers the Borsh form, so the order of keys does not
 * matter to a reader; this one writes them in the format's order.
 */
export function profileToJson(s: SignedConnectProfile): SignedConnectProfile {
  const p = s.profile;
  const subject: ProfileSubject = "grain" in p.subject
    ? { grain: { slug: p.subject.grain.slug } }
    : { site: { origin: p.subject.site.origin, name: p.subject.site.name, category: p.subject.site.category } };
  const texts = Object.fromEntries(languagesOf(p.texts).map((lang) => {
    const t = p.texts[lang]!;
    return [lang, { tagline: t.tagline, about: t.about, highlights: [...t.highlights], privacy: t.privacy }];
  }));
  return {
    profile: { version: p.version, subject, owner: p.owner, revision: p.revision, texts, website: p.website, support: p.support, terms: p.terms },
    key: "ed25519" in s.key ? { ed25519: s.key.ed25519 } : { p256: s.key.p256 },
    signature: s.signature,
  };
}

/** A string of the JSON form: a lone surrogate (which `\ud800` in JSON makes) is no text, as the node reads JSON. */
function jsonText(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || /\p{Cs}/u.test(v)) throw new ProfileError("json", key);
  return v;
}

function jsonInteger(o: Record<string, unknown>, key: string, max: number): number {
  const v = o[key];
  if (!integerIn(v, 0, max)) throw new ProfileError("json", key);
  return v;
}

/** The `profile` object of the JSON form alone, read as the node reads it; throws a `ProfileError` (`json`) for what is
 *  not one. Its bounds are `profileProblem`'s to check. */
export function profileFromJson(value: unknown): ConnectProfile {
  if (!isObject(value)) throw new ProfileError("json", "profile");
  const subjectValue = value.subject;
  if (!isObject(subjectValue) || Object.keys(subjectValue).length !== 1) throw new ProfileError("json", "subject");
  let subject: ProfileSubject;
  if (isObject(subjectValue.grain)) {
    subject = { grain: { slug: jsonText(subjectValue.grain, "slug") } };
  } else if (isObject(subjectValue.site)) {
    const s = subjectValue.site;
    subject = { site: { origin: jsonText(s, "origin"), name: jsonText(s, "name"), category: jsonInteger(s, "category", 0xff) } };
  } else {
    throw new ProfileError("json", "subject");
  }
  if (!isObject(value.texts)) throw new ProfileError("json", "texts");
  const texts: Record<string, ProfileText> = {};
  for (const [lang, t] of Object.entries(value.texts)) {
    if (!isObject(t)) throw new ProfileError("json", "texts");
    const h = t.highlights;
    if (!Array.isArray(h)) throw new ProfileError("json", "highlights");
    const highlights = h.map((x) => {
      if (typeof x !== "string" || /\p{Cs}/u.test(x)) throw new ProfileError("json", "highlights");
      return x;
    });
    Object.defineProperty(texts, lang, {
      value: { tagline: jsonText(t, "tagline"), about: jsonText(t, "about"), highlights, privacy: jsonText(t, "privacy") },
      enumerable: true, writable: true, configurable: true,
    });
  }
  const owner = jsonText(value, "owner");
  if (!byteKey(owner, 32)) throw new ProfileError("json", "owner");
  const optional = (key: string): string | null => {
    const v = value[key];
    if (v === undefined || v === null) return null;
    return jsonText(value, key);
  };
  return {
    version: jsonInteger(value, "version", 0xff),
    subject,
    owner,
    revision: jsonInteger(value, "revision", 0xffff_ffff),
    texts,
    website: optional("website"),
    support: optional("support"),
    terms: optional("terms"),
  };
}

/** A signed profile from its JSON form (`{profile, key, signature}`); throws a `ProfileError` (`json`) for what is not
 *  one. `verifyProfile` checks it. */
export function signedProfileFromJson(value: unknown): SignedConnectProfile {
  if (!isObject(value)) throw new ProfileError("json", "a signed profile");
  const profile = profileFromJson(value.profile);
  const key = deviceKeyOf(value.key);
  if (key === null) throw new ProfileError("json", "key");
  if (!byteKey(value.signature, 64)) throw new ProfileError("json", "signature");
  return { profile, key, signature: value.signature as string };
}

// ── The profile link (12-grains §10) ─────────────────────────────────────────

/** What a profile link starts with. */
export const PROFILE_LINK_PREFIX = "salt:grain-profile?p=";
/** A profile link's characters at most: what a QR code carries. */
export const MAX_PROFILE_LINK = 2048;

/** The owner a profile link leaves for the wallet to fill in: 32 zero bytes, and revision 0. */
export const UNOWNED_PROFILE = { owner: "00".repeat(32), revision: 0 } as const;

/** `p` as a link carries it: its owner and revision left for the wallet. */
export const unownedProfile = (p: ConnectProfile): ConnectProfile => ({ ...p, ...UNOWNED_PROFILE });

/** Why a link is not a grain's profile to sign: `link` (not a profile link), `size` (empty, or longer than 2 048
 *  characters), `encoding` (not canonical base64url without padding), `inflate` (not one raw DEFLATE stream inflating to
 *  at most 8 192 bytes with nothing after it), `profile` (not the canonical Borsh of a profile), `owned` (an owner or a
 *  revision filled in), `subject` (a site's profile). */
export type ProfileLinkProblem = "link" | "size" | "encoding" | "inflate" | "profile" | "owned" | "subject";

export class ProfileLinkError extends TypeError {
  constructor(readonly problem: ProfileLinkProblem) {
    super(`a profile link: ${problem}`);
    this.name = "ProfileLinkError";
  }
}

/**
 * The profile a link carries, its owner and revision still zero, read strictly as every reader reads it; throws a
 * `ProfileLinkError` otherwise. Its bounds are the wallet's to check once it filled in the owner and the revision.
 */
export function readProfileLink(link: string): ConnectProfile {
  if (!link.startsWith(PROFILE_LINK_PREFIX)) throw new ProfileLinkError("link");
  const text = link.slice(PROFILE_LINK_PREFIX.length);
  if (text.length === 0 || utf8Length(link) > MAX_PROFILE_LINK) throw new ProfileLinkError("size");
  let packed: Uint8Array;
  try {
    // The alphabet alone, no padding: one byte string has one text (`fromBase64` refuses stray bits).
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError("alphabet");
    packed = fromBase64(text, true);
  } catch {
    throw new ProfileLinkError("encoding");
  }
  const borsh = inflateRaw(packed, MAX_PROFILE_BYTES);
  if (borsh === null) throw new ProfileLinkError("inflate");
  let p: ConnectProfile;
  try {
    p = decodeProfile(borsh);
  } catch {
    throw new ProfileLinkError("profile");
  }
  if (p.owner !== UNOWNED_PROFILE.owner || p.revision !== 0) throw new ProfileLinkError("owned");
  if (!("grain" in p.subject)) throw new ProfileLinkError("subject");
  return p;
}
