// `grain chat-spec` and `grain cert`: a grain's chat (Saltix 22-grain-chats §2) — the spec the owner key signs, and the
// certificate that lets the server key speak in the chat for at most 31 days (§1).
import { existsSync, readFileSync } from "node:fs";
import {
  type ChatDocument, type GrainChatSpec, type InvoiceKeyCert, type Manifest, CHAT_CERT_LIFE_MS, chatDocumentOf, chatSpecFromJson,
  chatSpecProblem, decodeSignedChatSpec, encodeChatSpec, encodeSignedChatSpec, encodeCert, issueInvoiceKeyCert, signChatSpec, toHex,
} from "@saltix/grain-server";
import { ed25519 } from "@noble/curves/ed25519";

export const CHAT_SPEC_FILE = "chat.json";
export const CHAT_DOCUMENT_FILE = "chat.signed.json";
export const SERVER_KEY_FILE = "server.key";
export const CERT_FILE = "cert.json";
const DAY_MS = 86_400_000;

const EXPLAINED: Record<string, string> = {
  slug: "slug: 3 to 32 of [a-z0-9-], not starting with -",
  version: "version: at least 1",
  language: "a language code is not 2 to 8 of [a-z-]",
  name: "a name: commands 1 to 24 of [a-z0-9_] starting with a letter, parameters 1 to 24 of [a-z0-9_], each unique; at most 32 commands and 8 parameters a command",
  price: "price: 0 in this version (22-grain-chats §7: paid actions come later)",
  "bounds:text": "a text is empty, too long (intro 300, titles 32, help 120 characters) or holds control characters",
  "bounds:languages": "texts: at most 16 languages, \"en\" among them (help may be empty)",
  "bounds:intro": "intro: at least one language",
  "bounds:choice": "a choice's value is not 1 to 32 of [a-z0-9_-]",
  "bounds:parameter kind": "a parameter's kind: text max 1 to 2 000; number min not above max, decimals at most 9; 1 to 16 unique choices; " +
    "1 to 16 durations in ascending order, above 0; a file of 1 byte to 50 MiB with at most 8 media types",
  "bounds:revoked": "revoked: at most 16 server keys",
  "bounds:spec size": "the spec is over 32 KiB of Borsh: shorten its texts",
};

/** Where in `spec` its first problem is, in words: the command and parameter at fault, and what is wrong. */
export function explainChatSpec(spec: GrainChatSpec): string | null {
  const problem = chatSpecProblem(spec);
  if (problem === null) return null;
  const what = EXPLAINED[problem] ?? problem;
  const alone = (commands: GrainChatSpec["commands"]) => chatSpecProblem({ ...spec, commands, revoked: [] }) !== null;
  if (alone([])) return what;
  for (const command of spec.commands) {
    if (!alone([command])) continue;
    for (const param of command.params) {
      if (alone([{ ...command, params: [param] }]) && !alone([{ ...command, params: [] }])) return `command ${command.name}, parameter ${param.name}: ${what}`;
    }
    return `command ${command.name}: ${what}`;
  }
  return what;
}

/** The spec in `path` (its JSON form, `chatSpecFromJson`). */
export function readChatSpec(path: string): GrainChatSpec {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  try {
    return chatSpecFromJson(value);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

export interface Lint {
  errors: string[];
  warnings: string[];
}

/** What stops `spec` from being signed for the grain of `manifest` by the key file whose public key is `owner`, and
 *  what a wallet's user would miss. */
export function lintChatSpec(spec: GrainChatSpec, manifest?: Manifest, owner?: string): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = explainChatSpec(spec);
  if (problem) errors.push(problem);
  if (manifest && spec.slug !== manifest.slug) errors.push(`slug: ${spec.slug}, but the manifest is ${manifest.slug}'s`);
  if (manifest && owner !== undefined && !("ed25519" in manifest.owner_key && manifest.owner_key.ed25519 === owner)) {
    errors.push("the key file is not the manifest's owner_key: wallets check the spec against it");
  }
  if (!problem) {
    if (!("ru" in spec.intro)) warnings.push("intro: no Russian text (wallets show the English one)");
    for (const c of spec.commands) if (Object.keys(c.help).length === 0) warnings.push(`command ${c.name}: no help`);
    if (spec.commands.length === 0) warnings.push("commands: none, so users can only write text");
    const size = encodeChatSpec(spec).length;
    if (size > 24 * 1024) warnings.push(`the spec is ${size} bytes of Borsh, near the 32 KiB limit`);
  }
  return { errors, warnings };
}

/** The document `/.well-known/saltix-grain-chat` serves: `spec` signed now with the owner's secret, and `cert`'s hex
 *  when there is one. Refused when the document already in `out` holds a version at least as high with another spec. */
export function signedChatDocument(spec: GrainChatSpec, ownerSecret: Uint8Array, cert: InvoiceKeyCert | null, out?: string): Partial<ChatDocument> & { spec: string } {
  if (out && existsSync(out)) {
    try {
      const before = decodeSignedChatSpec((JSON.parse(readFileSync(out, "utf8")) as { spec: string }).spec).spec;
      const same = toHex(encodeChatSpec(before)) === toHex(encodeChatSpec(spec));
      if (!same && before.version >= spec.version) {
        throw new Error(`${out} holds version ${before.version}: raise "version" above it, since a wallet keeps the highest it has seen`);
      }
    } catch (e) {
      if ((e as Error).message.includes("raise")) throw e;
    }
  }
  const signed = signChatSpec(spec, ownerSecret);
  if (cert) {
    if (cert.slug !== spec.slug) throw new Error(`the certificate is ${cert.slug}'s, not ${spec.slug}'s`);
    return chatDocumentOf(signed, cert);
  }
  return { spec: toHex(encodeSignedChatSpec(signed)) };
}

/** A certificate in `path` (`grain cert`'s JSON form). */
export function readCert(path: string): InvoiceKeyCert {
  const c = JSON.parse(readFileSync(path, "utf8")) as InvoiceKeyCert;
  if (typeof c.slug !== "string" || !/^[0-9a-f]{64}$/.test(c.key) || !Number.isSafeInteger(c.expires_at) || !/^[0-9a-f]{128}$/.test(c.signature)) {
    throw new Error(`${path}: not a certificate (slug, key, expires_at, signature)`);
  }
  return c;
}

/** The owner key's certificate for `serverKey` (hex) in `slug` for `days` from `now`, and what is worth knowing. */
export function issueCert(ownerSecret: Uint8Array, slug: string, serverKey: string, days: number, now = Date.now()): { cert: InvoiceKeyCert & { hex: string }; warnings: string[] } {
  if (!/^[0-9a-f]{64}$/.test(serverKey)) throw new Error("the server key: 64 hex digits of its Ed25519 public key");
  if (!(days > 0)) throw new Error("--days: a positive number");
  if (serverKey === toHex(ed25519.getPublicKey(ownerSecret))) throw new Error("the server key is the owner key: keep the owner key off servers and certify another");
  const expiresAt = now + Math.round(days * DAY_MS);
  const warnings = expiresAt > now + CHAT_CERT_LIFE_MS
    ? ["it ends more than 31 days ahead: wallets refuse it in chats until then (it still signs invoices and notifications)"]
    : [];
  const cert = issueInvoiceKeyCert(ownerSecret, slug, serverKey, expiresAt);
  return { cert: { ...cert, hex: encodeCert(cert) }, warnings };
}
