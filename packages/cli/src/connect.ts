// A grain's Connect profile in its project (Saltix 19-connect §11, 12-grains §10): `connect.json`, the JSON form's
// `profile` object without `owner` and `revision` (`grain profile` fills them in: the owner's account, the registry's
// revision and one), and what `grain lint` says of it, of the icon, and of permissions nothing uses — everything
// Saltix's Connect sheet shows before anyone signs in.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  type ConnectProfile, type Manifest, MAX_PROFILE_BYTES, MAX_PROFILE_LINK, PERMISSIONS, PROFILE_LIMITS, ProfileError, encodeProfile, httpsLinkOk,
  languageOk, offlineOwner, profileFromJson, profileLink, profileProblem, refusedChar, supportAddress, supportOk,
} from "@saltix/grain-server";
import { ICON_FILES, checkIcon } from "./icon.js";
import { connectTexts } from "./template.js";

/** The project's Connect profile. */
export const CONNECT_FILE = "connect.json";
/** Where a project keeps the icon its manifest names (`grain icon`). */
export { ICON_FILES } from "./icon.js";

export interface Lint {
  errors: string[];
  warnings: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `connect.json` parsed; throws with the file's name when it is not JSON. */
export function readConnectFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

/** The profile a project file makes for `owner` (hex) at `revision`: what is signed. Its bounds are `profileProblem`'s
 *  (or `lintConnect`'s, which says more) to check; throws when it is no profile at all. */
export function profileOfProject(value: unknown, owner: string, revision: number): ConnectProfile {
  if (!isObject(value)) throw new Error(`${CONNECT_FILE}: an object of the Connect profile's fields`);
  try {
    return profileFromJson({ ...value, owner, revision });
  } catch (e) {
    // `json (texts)`: the field that is missing or of the wrong type.
    throw new Error(`${CONNECT_FILE}: ${e instanceof ProfileError ? `${e.message}: a field missing or of the wrong type` : (e as Error).message}`);
  }
}

/** What is wrong with a text of `min`–`max` characters (`lines`: line feeds allowed), in words naming `field`; `what`
 *  says what a required one is for. */
function textIssue(field: string, text: unknown, min: number, max: number, lines: boolean, what = ""): string | null {
  if (typeof text !== "string") return `${field}: text expected`;
  const chars = [...text];
  if (chars.length < min) return `${field}: required, 1 to ${max} characters${what}`;
  if (chars.length > max) return `${field}: ${chars.length} characters, at most ${max}`;
  if (!lines && text.includes("\n")) return `${field}: one line, no line breaks`;
  const bad = chars.find((c) => c !== "\n" && refusedChar(c.codePointAt(0)!));
  if (bad !== undefined || /\p{Cs}/u.test(text)) {
    return `${field}: U+${(bad?.codePointAt(0) ?? 0xfffd).toString(16).toUpperCase().padStart(4, "0")} is refused (control, format and bidirectional characters)`;
  }
  if (/^[ \n]|[ \n]$/.test(text)) return `${field}: no space or line break at its start or end`;
  return null;
}

/** Whether a link leads to a host reserved for examples and tests (RFC 2606, RFC 6761: `.example`, `.invalid`, `.test`,
 *  `localhost`, `example.com`…): it leads nowhere, so a Connect profile never carries one. `grain init`'s placeholders
 *  end in `.example`. */
export function placeholderLink(link: string): boolean {
  let host: string;
  if (link.startsWith("mailto:")) host = link.slice(link.lastIndexOf("@") + 1);
  else {
    try {
      host = new URL(link).hostname;
    } catch {
      return false;
    }
  }
  host = host.toLowerCase().replace(/\.$/, "");
  return /(^|\.)(example|invalid|test|localhost)$/.test(host) || /(^|\.)example\.(com|net|org)$/.test(host);
}

/** The links of a project's profile that lead to such a host, in words: an error each, for `grain lint` and
 *  `grain profile`. */
export function placeholderLinks(value: unknown): string[] {
  if (!isObject(value)) return [];
  return (["website", "support", "terms"] as const)
    .filter((field) => typeof value[field] === "string" && placeholderLink(value[field] as string))
    .map((field) => `${field}: ${String(value[field])} is a placeholder that leads nowhere (an example domain): the app's own link, or null for none`);
}

/** `grain lint`'s warning for a profile that still says what `grain init` wrote. */
export const TEMPLATE_RULE = "connect-template";

/** What is left while `connect.json` holds `grain init`'s words: said the same by `grain lint`'s last line and `grain
 *  doctor`. */
export const TEMPLATE_NEXT = "rewrite connect.json for this app (docs/agents/app.md: the Connect profile): it still holds grain init's words, which grain profile refuses";

/** Whether the project in `dir` has a `connect.json` that still holds `grain init`'s words (none, or one that does not
 *  read, is `grain lint`'s to say). */
export function stillTemplate(dir: string): boolean {
  try {
    return templateTexts(readConnectFile(join(dir, CONNECT_FILE))).length > 0;
  } catch {
    return false;
  }
}

/** A text of the template with the app's name in it, as a pattern that takes any name: the project's name may have
 *  changed since `grain init` wrote it. */
const NAME_MARK = "\u0000";
const namePattern = (text: string): RegExp =>
  new RegExp(`^${text.split(NAME_MARK).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".{1,64}")}$`, "s");

/**
 * Where a project's profile still says what `grain init` wrote about the counter (or the hello chat) it makes, in words,
 * one line a language: its tagline, about or privacy, or all its highlights, unchanged (the about with any name in it,
 * which the app's may have changed since). A wallet would show those words as the app's own, so `grain lint` warns
 * (`connect-template`) and `grain profile` refuses.
 */
export function templateTexts(value: unknown): string[] {
  if (!isObject(value) || !isObject(value.texts)) return [];
  const found: string[] = [];
  for (const [lang, t] of Object.entries(value.texts)) {
    if (!isObject(t)) continue;
    for (const chat of [false, true]) {
      const template = connectTexts(NAME_MARK, chat)[lang];
      if (!template) continue;
      const same: string[] = [];
      if (t.tagline === template.tagline) same.push("tagline");
      if (typeof t.about === "string" && namePattern(template.about).test(t.about)) same.push("about");
      if (Array.isArray(t.highlights) && JSON.stringify(t.highlights) === JSON.stringify(template.highlights)) same.push("highlights");
      if (t.privacy === template.privacy) same.push("privacy");
      if (same.length > 0) {
        const fields = same.length === 1 ? same[0] : `${same.slice(0, -1).join(", ")} and ${same.at(-1)}`;
        found.push(`texts.${lang}: ${fields} ${same.length === 1 ? "is" : "are"} grain init's words for the ${chat ? "hello chat" : "counter"} it makes, not this app's`);
        break;
      }
    }
  }
  return found;
}

const LINK_RULE = `an https:// link of at most ${PROFILE_LIMITS.linkBytes} bytes: a lowercase host (an international one in its xn-- form), no user, no :443, the rest percent-encoded (http:, javascript: and data: are refused)`;

/**
 * What stops `connect.json` from being set, and what is worth a look (19-connect §11.1, 12-grains §10), for the grain
 * `m`: every rule of the format with the field and its limit; the privacy summary required when the manifest asks for
 * the address or storage; English and Russian; the link's length for a QR code.
 */
export function lintConnect(projectDir: string, m: Manifest): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const file = join(projectDir, CONNECT_FILE);
  const where = CONNECT_FILE;
  if (!existsSync(file)) {
    errors.push(`${where}: missing. Every app ships a Connect profile: what Saltix's Connect sheet shows before anyone signs in, in your words (grain init writes one; docs/agents/app.md says how to write it)`);
    return { errors, warnings };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    errors.push(`${where}: not JSON (${(e as Error).message})`);
    return { errors, warnings };
  }
  if (!isObject(value)) {
    errors.push(`${where}: an object of the Connect profile's fields (version, subject, texts, website, support, terms)`);
    return { errors, warnings };
  }
  if ("owner" in value || "revision" in value) {
    warnings.push(`${where}: owner and revision are filled in when it is set (the owner's account, the registry's revision and one): leave them out`);
  }
  if (value.version !== 1 && value.version !== 2) {
    errors.push(`${where}: version: 1, the format's version; 2 when support is a Saltix address (protocol version 9 and later: grain support sets both)`);
  }
  const subject = value.subject;
  const slug = isObject(subject) && Object.keys(subject).length === 1 && isObject(subject.grain) ? subject.grain.slug : undefined;
  if (slug === undefined) errors.push(`${where}: subject: {"grain": {"slug": "${m.slug}"}}`);
  else if (slug !== m.slug) errors.push(`${where}: subject.grain.slug "${String(slug)}" is not grain.json's slug "${m.slug}"`);

  const texts = isObject(value.texts) ? value.texts : null;
  const langs = texts ? Object.keys(texts).sort() : [];
  if (!texts || langs.length === 0 || langs.length > PROFILE_LIMITS.languages || !langs.includes("en")) {
    errors.push(`${where}: texts: 1 to ${PROFILE_LIMITS.languages} languages, "en" among them`);
  }
  for (const lang of langs.filter((l) => !languageOk(l))) errors.push(`${where}: texts.${lang}: a language code is 2 to 8 of [a-z-] ("en", "ru", "pt-br")`);
  const asks = [m.permissions & PERMISSIONS.address ? "address" : "", m.permissions & PERMISSIONS.storage ? "storage" : ""].filter(Boolean);
  for (const lang of langs) {
    const t = texts![lang];
    const at = `${where}: texts.${lang}`;
    if (!isObject(t)) {
      errors.push(`${at}: {"tagline", "about", "highlights", "privacy"}`);
      continue;
    }
    const tagline = textIssue(`${at}.tagline`, t.tagline, 1, PROFILE_LIMITS.tagline, false, ": what the app is, in one line");
    if (tagline) errors.push(tagline);
    const about = textIssue(`${at}.about`, t.about, 0, PROFILE_LIMITS.about, true);
    if (about) errors.push(about);
    else if (t.about === "") warnings.push(`${at}.about: empty: say what the app does (up to ${PROFILE_LIMITS.about} characters); Saltix shows it under "In its own words"`);
    if (!Array.isArray(t.highlights)) {
      errors.push(`${at}.highlights: a list of at most ${PROFILE_LIMITS.highlights} lines ([] for none)`);
    } else {
      if (t.highlights.length > PROFILE_LIMITS.highlights) errors.push(`${at}.highlights: ${t.highlights.length} of them, at most ${PROFILE_LIMITS.highlights}`);
      t.highlights.forEach((h, i) => {
        const issue = textIssue(`${at}.highlights[${i}]`, h, 1, PROFILE_LIMITS.highlight, false);
        if (issue) errors.push(issue);
      });
    }
    const privacy = textIssue(`${at}.privacy`, t.privacy, 0, PROFILE_LIMITS.privacy, false);
    if (privacy) errors.push(privacy);
    else if (t.privacy === "" && asks.length > 0) {
      errors.push(`${at}.privacy: required: grain.json asks for ${asks.join(" and ")}, so say what the app keeps about a user and for how long (at most ${PROFILE_LIMITS.privacy} characters)`);
    }
  }
  if (langs.length === 1 && langs[0] === "en") warnings.push(`${where}: texts: English only; add "ru" (Saltix shows the English words to every other reader)`);
  for (const [field, ok, rule] of [["website", httpsLinkOk, LINK_RULE], ["terms", httpsLinkOk, LINK_RULE]] as const) {
    const v = value[field];
    if (v !== undefined && v !== null && !ok(v)) errors.push(`${where}: ${field}: ${rule}`);
  }
  const support = value.support;
  if (support !== undefined && support !== null && !supportOk(support)) {
    if (supportAddress(support) === null) {
      errors.push(`${where}: support: an https:// link, a mailto: address with nothing after it, a Saltix username (@name), or a Saltix ` +
        "address in its canonical form (lowercase, dsalt1…; protocol version 9 and later): grain support writes one");
    } else if (value.version !== 2) {
      errors.push(`${where}: support: a Saltix address needs version 2, which networks take from protocol version 9: grain support sets both`);
    }
  }
  if (value.version === 2 && supportAddress(support) === null) {
    warnings.push(`${where}: version 2 with no support address: a network before protocol version 9 refuses it, and version 1 says the same (grain support sets it)`);
  }
  // A link that leads nowhere: Saltix's sheet would show it, and users would tap it.
  errors.push(...placeholderLinks(value).map((words) => `${where}: ${words}`));
  // The template's words, about the counter grain init makes: they pass every rule, and describe another app.
  warnings.push(...templateTexts(value).map((words) =>
    `${TEMPLATE_RULE}: ${where}: ${words}. Rewrite it for this app (docs/agents/app.md: the Connect profile); grain profile refuses it as it is`));
  if (errors.length > 0) return { errors, warnings };

  // In words above; the format's own check has the last word, so nothing the network refuses passes here.
  let profile: ConnectProfile;
  try {
    profile = profileOfProject(value, offlineOwner(value, m.owner), 1);
  } catch (e) {
    errors.push((e as Error).message);
    return { errors, warnings };
  }
  const size = encodeProfile(profile).length;
  if (size > MAX_PROFILE_BYTES) {
    errors.push(`${where}: ${size} bytes in its Borsh form, at most ${MAX_PROFILE_BYTES}: shorten the texts or drop a language`);
    return { errors, warnings };
  }
  const problem = profileProblem(profile);
  if (problem) {
    errors.push(`${where}: ${problem}: ${problem.startsWith("consent_") ? "the support address's consent does not hold (grain support <address> --consent F checks it against the network)" : "out of bounds"} (Saltix 19-connect §11.1)`);
    return { errors, warnings };
  }
  try {
    profileLink(profile);
  } catch {
    warnings.push(`${where}: its link is longer than ${MAX_PROFILE_LINK} characters, too long for a QR code; set it in Saltix's app studio (My apps → ${m.slug} → Connect profile), or with grain profile when a key file here owns the app (it signs by itself)`);
  }
  return { errors, warnings };
}

/** Width and height of a PNG, or null when the bytes are no PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The icon file a project keeps, when it has one (Saltix 32-images §3.4): an icon every wallet takes (the image check:
 *  512 × 512, or 256 × 256 with a warning) whose hash `grain.json` names, and the standard's warnings. */
export function lintIcon(projectDir: string, m: Manifest): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const name of ICON_FILES) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    const found = checkIcon(new Uint8Array(readFileSync(path)), m.icon);
    errors.push(...found.errors.map((e) => `${name}: ${e}`));
    warnings.push(...found.warnings.map((w) => `${name}: ${w}`));
  }
  return { errors, warnings };
}

/** What uses each permission (12-grains §6): the page's bridge calls, the server's notifications, the browser's camera,
 *  microphone and location. */
const USES: Record<keyof typeof PERMISSIONS, { pattern: RegExp; what: string }> = {
  storage: { pattern: /grain_storage_|\bstorage\s*\.\s*(?:get|set|remove|keys)\s*\(/, what: "grain.storage" },
  relay: { pattern: /grain_relay_|\brelay\s*\.\s*(?:open|send|close|onFrame)\s*\(/, what: "grain.relay" },
  // A chat's server notifies (`chat.notify`, `chat.notification`), and `ChatServer` reports errors to the team unasked.
  notifications: { pattern: /grain_notifications_|\bnotifications\s*\.\s*allow\s*\(|\.notify(?:Team)?\s*\(|\.notification\s*\(|\bsignNotification\s*\(|\bChatServer\b/, what: "grain.notifications or the server's chat.notify" },
  camera: { pattern: /getUserMedia[\s\S]{0,400}?\bvideo\b|\bvideo\b[\s\S]{0,400}?getUserMedia/, what: "getUserMedia({video})" },
  microphone: { pattern: /getUserMedia[\s\S]{0,400}?\baudio\b|\baudio\b[\s\S]{0,400}?getUserMedia/, what: "getUserMedia({audio})" },
  location: { pattern: /\bgeolocation\b/, what: "navigator.geolocation" },
  address: { pattern: /grain_requestAddress|\brequestAddress\s*\(/, what: "grain.requestAddress()" },
};

const SOURCES = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".htm", ".vue", ".svelte"]);
const SKIP = new Set(["node_modules", "dist", "build", "test", "tests", "coverage"]);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 500;
/** The bridge (`grain.js`, `@saltix/grain`) or a bundle of it names every call itself: it says nothing of what the app
 *  uses. */
const BRIDGE = /["']grain_info["']/;

/** The app's own sources: its page (`public/`), and the program beside `grain.json` (its top files, `src/`, `server/`,
 *  `lib/`); not dependencies, builds or tests, and not the bridge. */
function ownSources(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, deep: boolean) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= MAX_FILES || name.startsWith(".") || SKIP.has(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        if (deep) walk(path, true);
      } else if (st.isFile() && st.size <= MAX_FILE && SOURCES.has(extname(name).toLowerCase())) {
        const text = readFileSync(path, "utf8");
        if (!BRIDGE.test(text)) out.push(text);
      }
    }
  };
  walk(projectDir, false);
  for (const dir of ["public", "src", "server", "lib"]) walk(join(projectDir, dir), true);
  return out;
}

/**
 * Warnings for each permission `m` asks for that nothing of the app's own seems to use: an app asks only for what it
 * uses, since Saltix shows every permission on its Connect sheet. Reading sources is a heuristic (a bundle that holds the
 * bridge is not read), so these are warnings; none when the project has no source of its own to read.
 */
export function lintPermissionsUse(projectDir: string, m: Manifest): string[] {
  const sources = ownSources(projectDir);
  if (sources.length === 0) return [];
  const warnings: string[] = [];
  for (const [name, bit] of Object.entries(PERMISSIONS) as Array<[keyof typeof PERMISSIONS, number]>) {
    if ((m.permissions & bit) === 0) continue;
    if (sources.some((s) => USES[name].pattern.test(s))) continue;
    warnings.push(
      `permissions: grain.json asks for "${name}" (${bit}), but nothing in the app's sources uses ${USES[name].what}. Ask only for ` +
      "what the app uses: Saltix shows every permission on its Connect sheet. Drop the bit, or ignore this if the app uses it another way.",
    );
  }
  return warnings;
}
