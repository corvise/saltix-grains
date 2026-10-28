// `grain support` (Saltix 19-connect §11.1): who answers an app's users — the support contact of its Connect profile,
// `connect.json`, which `grain profile` then sets in the registry, as it sets the rest of the profile. Four forms: an
// https link and a mailto: address (opened outside the wallet), a Saltix username (`@name`: a person's, or one bound to
// the app, which opens the app's chat, where its program answers), and, from protocol version 9, a Saltix address: the
// owner's own, or one whose holder signed its consent (`support_consent`), which a wallet opens a chat with and which
// users reach before they activate their messenger. And the holder's side: `grain support consent`, the consent of the
// address whose key is in `SALTIX_SUPPORT_KEY`, never a file.
import {
  type NetworkName, type NodeLike, type ProfileReading, type ProfileReason, type SupportConsent, SUPPORT_ADDRESS_VERSION, SUPPORT_KEY_ENV, accountId,
  decodeAddress, encodeAddress, fromHex, grainGet, nodeCall, parseHandle, supportConsentFromEnvironment, supportConsentFromJson, supportOk,
  supportProblem, toHex,
} from "@saltix/grain-server";
import { placeholderLink } from "./connect.js";
import { handleGet } from "./studio.js";
import { type VersionStatus, networkVersion, nextSwitch } from "./versions.js";

/** A support contact refused, with a code for the steps' log (`support_<reason>`) and words that say what to do. */
export class SupportError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "SupportError";
  }
}

/** A support contact in the form a profile carries it. */
export type SupportContact =
  | { form: "link"; text: string }
  | { form: "email"; text: string }
  | { form: "username"; text: string; name: string }
  | { form: "address"; text: string; network: NetworkName; kind: 0 | 5; account: string };

const FORMS = "an https:// link, a mailto: address, a Saltix username (@name) or a Saltix address (dsalt1…)";

/**
 * What a typed contact is, written as a profile carries it: an address in its canonical text (lowercase: an uppercase
 * spelling, from a QR code say, is the same address), a username as `@name`, an e-mail address as `mailto:` (typed
 * without it too), an https link as typed. Throws a `SupportError` naming the four forms for anything else.
 */
export function contactOf(typed: string): SupportContact {
  const text = typed.trim();
  const address = decodeAddress(text);
  if (address !== null) {
    if (address.kind !== 0 && address.kind !== 5) {
      throw new SupportError("address_kind", `${text}: an address of kind ${address.kind}; support takes an address people write to, a personal or a managed one`);
    }
    return { form: "address", text: encodeAddress(address.network, address.id, address.kind), network: address.network, kind: address.kind, account: toHex(address.id) };
  }
  if (text.startsWith("@")) {
    const handle = parseHandle(text);
    if (handle === null) throw new SupportError("username", `${text}: not a name (@anna: 1 to 32 of a-z 0-9 _, a letter first)`);
    return { form: "username", text: `@${handle.name}`, name: handle.name };
  }
  const mail = /^[^@\s:/]+@[^@\s/]+$/.test(text) ? `mailto:${text}` : text;
  if (!supportOk(mail)) throw new SupportError("form", `${typed}: not a support contact; one of ${FORMS}`);
  // A host reserved for examples leads nowhere, and a wallet would show it (grain lint and grain profile refuse it too).
  if (placeholderLink(mail)) throw new SupportError("placeholder", `${mail}: a placeholder that leads nowhere (an example domain): the app's own`);
  return mail.startsWith("mailto:") ? { form: "email", text: mail } : { form: "link", text: mail };
}

/**
 * `connect.json`'s fields with `contact` as the support contact (null: none): format 1 for a link, an e-mail address, a
 * username or none, which every network takes; format 2 with its consent (null for the owner's own address) for an
 * address. The other fields stay as they were, in their order.
 */
export function withSupport(value: Record<string, unknown>, contact: SupportContact | null, consent: SupportConsent | null): Record<string, unknown> {
  const address = contact?.form === "address";
  const out: Record<string, unknown> = { ...value, version: address ? 2 : 1, support: contact?.text ?? null };
  if (address) out.support_consent = consent;
  else delete out.support_consent;
  return out;
}

/** What `node_status` says of the network: its kind and genesis hash, and its protocol versions. */
export interface NetworkStatus extends VersionStatus {
  network: NetworkName;
  genesis: string;
}

/** How the network reads a profile now (19-connect §11.1): the version its blocks run, its kind (a support address's
 *  prefix) and its genesis hash (a consent's signature). */
export const readingOf = (status: NetworkStatus): ProfileReading => ({ version: networkVersion(status), network: status.network, genesis: status.genesis });

/** Why the network takes no support address yet, in words, or null when it does. */
export function addressNotTaken(status: NetworkStatus): string | null {
  const runs = networkVersion(status);
  if (runs >= SUPPORT_ADDRESS_VERSION) return null;
  const next = nextSwitch(status);
  const when = next !== null && next.version >= SUPPORT_ADDRESS_VERSION ? `version ${next.version} begins at slot ${next.slot}` : "no schedule names it yet";
  return `the network runs protocol version ${runs}, and a support address is taken from version ${SUPPORT_ADDRESS_VERSION} (${when}); ` +
    "until then the support contact is a link, an e-mail address or a username";
}

/** A refusal of the support contact or its consent (`supportProblem`'s, `profileProblem`'s), in words: what is wrong and
 *  what to do. */
export function supportWords(reason: ProfileReason, contact: string, slug: string): string {
  switch (reason) {
    case "support":
      return `support ${contact}: not a contact this network takes: ${FORMS} of this network (grain support writes one)`;
    case "consent_missing":
      return `${contact} is not the owner's own address, so it needs its holder's consent: they sign it (in their Saltix, or ` +
        `${SUPPORT_KEY_ENV}=… grain support consent --slug ${slug} where its key is), then grain support ${contact} --consent F`;
    case "consent_unneeded":
      return "a consent goes only with a support address other than the owner's own: grain support writes the contact without one";
    case "consent_key":
      return `the consent's key does not make ${contact}: it is another address's consent`;
    case "consent_slug":
      return `the consent is for another app than ${slug}`;
    case "consent_owner":
      return `the consent names another owner than ${slug}'s (the app changed hands since, or it was signed for another account)`;
    case "consent_signature":
      return "the consent's signature does not verify on this network: it was signed for another network, or changed since";
    default:
      return `${reason}: out of bounds (Saltix 19-connect §11.1); grain lint says more`;
  }
}

/** What a username opens, from what the registry holds of it: the app's chat when it is bound to `slug`. */
function usernameWords(name: string, record: { app: string | null } | null, slug: string): string {
  if (record === null) {
    throw new SupportError("username_free", `@${name}: nobody holds it, and whoever mints it would get ${slug}'s users' questions: ` +
      "name a username you hold (bound to the app, it opens the app's chat), a link, an e-mail address or an address");
  }
  if (record.app === slug) return `@${name} opens ${slug}'s chat in Saltix: its program answers there, and every user reaches it`;
  if (record.app !== null) return `@${name} opens the chat of another app, ${record.app}: its program answers there, not ${slug}'s`;
  return `@${name} opens a chat with whoever holds it: users write to a person once their messenger is activated (a support ` +
    "address, from protocol version 9, reaches them before)";
}

export interface SupportOptions {
  contact: SupportContact;
  /** The app: `grain.json`'s slug. */
  slug: string;
  /** Where the registry and the network are read, asked only for a username or an address. */
  node: () => NodeLike;
  /** The consent its holder signed (its JSON form's text: `grain support consent`'s file), for an address that is not the
   *  owner's own. */
  consent?: string;
  /** Where the holder's key may be instead (`SALTIX_SUPPORT_KEY`): the consent is signed here, and the key never leaves. */
  env: NodeJS.ProcessEnv;
}

/**
 * The consent `o.contact` needs as `o.slug`'s support, checked as the network checks it, and what the contact opens, in
 * words: none for a link or an e-mail address (no network asked); for a username, what the registry says it opens
 * (refused when nobody holds it); for an address, the network's version, its prefix, the owner's own address or a consent
 * (`o.consent`, or signed with the key in `SALTIX_SUPPORT_KEY`) for this app, owner and network. Throws a `SupportError`.
 */
export async function supportFor(o: SupportOptions): Promise<{ consent: SupportConsent | null; said: string }> {
  const { contact, slug } = o;
  if (contact.form === "link" || contact.form === "email") {
    return { consent: null, said: `${contact.text}: ${contact.form === "link" ? "a link users open" : "an e-mail address users write to"} outside Saltix` };
  }
  const node = o.node();
  if (contact.form === "username") return { consent: null, said: usernameWords(contact.name, await handleGet(node, { name: contact.name }), slug) };
  const status = await nodeCall<NetworkStatus>(node, "node_status");
  const notYet = addressNotTaken(status);
  if (notYet) throw new SupportError("version", `${contact.text}: ${notYet}`);
  if (contact.network !== status.network) {
    throw new SupportError("network", `${contact.text}: an address of ${contact.network}, and this network is ${status.network}`);
  }
  const grain = await grainGet(node, slug);
  if (grain === null) throw new SupportError("unregistered", `${slug}: not registered yet: a consent names the app's owner, so grain publish first`);
  if (grain.retired !== null) throw new SupportError("retired", `${slug}: retired at slot ${grain.retired}`);
  const owner = grain.owner;
  let consent: SupportConsent | null = null;
  if (contact.account !== owner) {
    if (o.consent !== undefined) {
      try {
        consent = supportConsentFromJson(JSON.parse(o.consent));
      } catch {
        throw new SupportError("consent_json", "--consent: not a consent's JSON form ({\"slug\", \"owner\", \"key\", \"signature\"}, as grain support consent writes it)");
      }
    } else if (o.env[SUPPORT_KEY_ENV]?.trim()) {
      consent = supportConsentFromEnvironment({ genesis: status.genesis, slug, owner }, o.env);
    }
  }
  const problem = supportProblem({ version: 2, subject: { grain: { slug } }, owner, support: contact.text, support_consent: consent }, readingOf(status));
  if (problem) throw new SupportError(problem, supportWords(problem, contact.text, slug));
  const whose = consent === null ? "the owner's own address" : "an address whose holder consents";
  return {
    consent,
    said: `${contact.text}: ${whose}; Saltix opens a chat with it, and users reach it before they activate their messenger`,
  };
}

/** The account (hex) an `--owner` names: an address of any network, or the id itself. */
export function ownerAccountOf(text: string): string {
  const decoded = decodeAddress(text);
  if (decoded) return toHex(decoded.id);
  if (/^[0-9a-f]{64}$/.test(text)) return text;
  throw new SupportError("owner", `--owner ${text}: an address (dsalt1…) or an account id in hex`);
}

/**
 * The holder's side (`grain support consent`): the consent of the address whose key is in `SALTIX_SUPPORT_KEY` to answer
 * for `slug` of `owner` (an account in hex; the registry's owner of the app when not given) on the network `node` runs,
 * with the address it is for (that key's personal address). The key never leaves the process.
 */
export async function holderConsent(o: { slug: string; owner?: string; node: NodeLike; env: NodeJS.ProcessEnv }): Promise<{
  consent: SupportConsent; address: string; status: NetworkStatus;
}> {
  const status = await nodeCall<NetworkStatus>(o.node, "node_status");
  let owner = o.owner;
  if (owner === undefined) {
    const grain = await grainGet(o.node, o.slug);
    if (grain === null) throw new SupportError("unregistered", `${o.slug}: not registered: name its owner with --owner, or register it first`);
    owner = grain.owner;
  }
  const consent = supportConsentFromEnvironment({ genesis: status.genesis, slug: o.slug, owner }, o.env);
  return { consent, address: encodeAddress(status.network, accountId(fromHex(consent.key, 32))), status };
}
