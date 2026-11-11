// A grain's project on the developer's computer: its manifest (`grain.json`), the owner's key file and the checks
// a manifest must pass before it is registered (Saltix 12-grains §2–3).
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  type Manifest, type SignedManifest, manifestProblem, verifyManifest, signManifest, originOf, encodeGrainTx,
  MAX_TX_SIZE, accountId, fromHex, toHex,
} from "@saltix/grain-server";

import { UsageError } from "./args.js";

export const MANIFEST_FILE = "grain.json";
export const KEY_FILE = "owner.key";

/** A letter of the Cyrillic script: a name that has one is not an English name. */
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** The names `grain init` gives a new app. */
export interface InitNames {
  /** The English name, which every app has (12-grains §2): what a reader of none of its other languages sees. */
  en: string;
  /** The Russian name, when one was given. */
  ru?: string;
  /** What a page of one language shows: the name as its maker typed it. */
  page: string;
  /** What was decided for the app's maker, to be said to them: a name taken as the Russian one. */
  note?: string;
}

/**
 * The names of a new app from `grain init`'s `--name` (the English name; the slug when not given) and `--name-ru` (the
 * Russian one). A manifest's name is a map by language in which `en` is required, so a name typed in Cyrillic alone is
 * never written as the English one: it is the Russian name, the slug stands for the English one until its maker writes
 * it, and `note` says so. Each name keeps a manifest's bounds (1–32 characters, none of them a control character).
 */
export function initNames(slug: string, name: string | undefined, nameRu: string | undefined): InitNames {
  for (const [flag, value] of [["--name", name], ["--name-ru", nameRu]] as const) {
    if (value !== undefined && (value.length === 0 || [...value].length > 32 || /\p{Cc}/u.test(value))) {
      throw new UsageError(`${flag}: an app's name is 1 to 32 characters, none of them a control character`);
    }
  }
  if (name !== undefined && CYRILLIC.test(name)) {
    if (nameRu !== undefined) {
      throw new UsageError(`--name is the app's English name and --name-ru its Russian one: --name <English> --name-ru "${nameRu}"`);
    }
    return {
      en: slug, ru: name, page: name,
      note: `"${name}" is the app's Russian name (name.ru in ${MANIFEST_FILE}); its English name, which every app has, is the slug ` +
        `"${slug}" until you write one: name.en there, or grain init --name <English> --name-ru "${name}"`,
    };
  }
  const en = name ?? slug;
  return nameRu === undefined ? { en, page: en } : { en, ru: nameRu, page: name ?? nameRu };
}

/** A manifest file holds either the `manifest` object alone or its signed JSON form. */
export function readManifest(path: string): { manifest: Manifest; signed: SignedManifest | null } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  const o = value as Record<string, unknown>;
  if (o && typeof o === "object" && "manifest" in o && "signature" in o) {
    const signed = o as unknown as SignedManifest;
    return { manifest: signed.manifest, signed };
  }
  return { manifest: o as unknown as Manifest, signed: null };
}

/** The owner's 32-byte secret from a key file of 64 hex digits; the file must be the owner's alone. */
export function readKey(path: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`${path}: no key file (grain init makes one)`);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path}: readable by others; chmod 600 it`);
  }
  const text = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error(`${path}: 64 hex digits expected`);
  return fromHex(text.toLowerCase(), 32);
}

/** A new key file, owner-only; its public key in hex. */
export function newKey(path: string): string {
  if (existsSync(path)) throw new Error(`${path} exists already`);
  const secret = randomBytes(32);
  writeFileSync(path, toHex(secret) + "\n", { mode: 0o600 });
  return toHex(ed25519.getPublicKey(secret));
}

export const publicKeyOf = (secret: Uint8Array) => toHex(ed25519.getPublicKey(secret));

/** The plain owner a key file makes (12-grains §2): the key's own account, the key itself. */
export function ownerOf(publicKey: string): Pick<Manifest, "owner" | "owner_key"> {
  return { owner: toHex(accountId(fromHex(publicKey, 32))), owner_key: { ed25519: publicKey } };
}

/** Why `m` is not the key file's to sign and register, or null. */
function notTheKeys(m: Manifest, publicKey: string): string | null {
  const own = ownerOf(publicKey);
  if (!m.owner_key || !("ed25519" in m.owner_key) || m.owner_key.ed25519 !== publicKey) {
    return "owner_key: not the key file's public key";
  }
  return m.owner === own.owner ? null : "owner: not the key file's account (a managed account publishes from its wallet)";
}

export interface Lint {
  errors: string[];
  warnings: string[];
}

/** What stops `m` from being registered, and what is worth a look. */
export function lint(m: Manifest, ownerKey?: string): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = manifestProblem(m);
  if (problem) {
    const developer = manifestProblem(m, true) === null;
    errors.push(developer
      ? "origins: developer origins (http://localhost, 127.0.0.1, 10.0.2.2) work with grain dev only; register an https origin"
      : `${problem}: out of bounds (Saltix 12-grains §2)`);
  }
  const notOurs = ownerKey === undefined ? null : notTheKeys(m, ownerKey);
  if (notOurs) errors.push(notOurs);
  if (!problem) {
    // The manifest rides in the transaction that registers it; a sender is its tag and 32 bytes either way.
    const signed: SignedManifest = { manifest: m, signature: "00".repeat(64) };
    const sender = "ed25519" in m.owner_key ? m.owner_key.ed25519 : "00".repeat(32);
    // The proof adds its tag and the signature.
    const size = encodeGrainTx({ sender, nonce: 0, fee: 0, validUntilSlot: 0 }, { register: signed }).length + 1 + 64;
    if (size > MAX_TX_SIZE) errors.push(`size: registering it takes a ${size}-byte transaction, a node takes at most ${MAX_TX_SIZE}; shorten the descriptions`);
  }
  if (/^0+$/.test(m.icon ?? "")) warnings.push("icon: none yet (wallets draw a monogram); `grain icon <picture> --out icon.png` makes one to the standard and names it");
  if (!("ru" in (m.name ?? {}))) warnings.push("name: no Russian name (wallets show the English one)");
  return { errors, warnings };
}

/** `m` signed with `secret`, after the checks; `dev` takes developer origins. */
export function sign(m: Manifest, secret: Uint8Array, dev = false): SignedManifest {
  return signManifest(m, secret, dev);
}

/** The signed manifest `path` holds, or `m` signed now with `secret`: what goes to the registry. */
export function signedFor(path: string, secret: Uint8Array): SignedManifest {
  const { manifest, signed } = readManifest(path);
  const owner = publicKeyOf(secret);
  const notOurs = notTheKeys(manifest, owner);
  if (notOurs) throw new Error(notOurs);
  if (signed) {
    if (!verifyManifest(signed)) throw new Error(`${path}: the signature or the bounds do not check`);
    return signed;
  }
  const { errors } = lint(manifest, owner);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return sign(manifest, secret);
}

/** The manifest of `m` for a developer's `origin` (`grain dev`): its pages there instead of its own origins. */
export function forOrigin(m: Manifest, origin: string): Manifest {
  if ("chat" in m.entry) throw new Error("a chat-only grain has no page to serve: run its chat server (ChatServer) instead");
  if (!("hosted" in m.entry)) throw new Error("grain dev serves hosted grains");
  const url = new URL(m.entry.hosted.url);
  return { ...m, entry: { hosted: { url: origin + url.pathname + url.search, origins: [origin] } } };
}

export { originOf };
