// A grain's project on the developer's computer: its manifest (`grain.json`), the owner's key file and the checks
// a manifest must pass before it is registered (Salarium 12-grains §2–3).
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  type Manifest, type SignedManifest, manifestProblem, verifyManifest, signManifest, originOf, encodeGrainTx,
  MAX_TX_SIZE, fromHex, toHex,
} from "@salarium/grain-server";

export const MANIFEST_FILE = "grain.json";
export const KEY_FILE = "owner.key";

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
      : `${problem}: out of bounds (Salarium 12-grains §2)`);
  }
  if (ownerKey !== undefined && m.owner_key !== ownerKey) errors.push("owner_key: not the key file's public key");
  if (!problem) {
    // The manifest rides in the transaction that registers it.
    const signed: SignedManifest = { manifest: m, signature: "00".repeat(64) };
    // The proof adds its tag and the signature.
    const size = encodeGrainTx({ sender: m.owner_key, nonce: 0, fee: 0, validUntilSlot: 0 }, { register: signed }).length + 1 + 64;
    if (size > MAX_TX_SIZE) errors.push(`size: registering it takes a ${size}-byte transaction, a node takes at most ${MAX_TX_SIZE}; shorten the descriptions`);
  }
  if (/^0+$/.test(m.icon ?? "")) warnings.push("icon: still zero; `grain icon <256x256.png>` gives its hash");
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
  if (manifest.owner_key !== owner) throw new Error("owner_key: not the key file's public key");
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
  if (!("hosted" in m.entry)) throw new Error("grain dev serves hosted grains");
  const url = new URL(m.entry.hosted.url);
  return { ...m, entry: { hosted: { url: origin + url.pathname + url.search, origins: [origin] } } };
}

export { originOf };
