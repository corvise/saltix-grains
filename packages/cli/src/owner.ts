// Who signs an owner's call to the registry (Saltix 12-grains §10, 24-app-studio §2): `grain publish`, `profile`,
// `access`, `configure` and `bind`. The owner's Saltix signs by default, from a QR code (or in My apps); a key file on
// this computer signs only when the command names it (`--key F`), or for an app the registry already names that key's
// account as the owner of. So an app is never registered to a key file by accident: `grain init` writes an `owner.key`
// into every project, and a developer with a phone who runs `grain publish` gets the QR code for their own Saltix, never
// an app owned by a throwaway key. `--wallet` always asks Saltix. The account that will own the app is said before
// anything is signed (`ownerLine`).
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { type NetworkName, accountId, encodeAddress, fromHex, toHex } from "@saltix/grain-server";
import { UsageError } from "./args.js";
import { KEY_FILE, publicKeyOf, readKey } from "./project.js";

/** Who signs: a key file here (named by `--key`, or the owner the registry names), or the owner's Saltix. */
export type Signer =
  | { by: "key"; secret: Uint8Array; account: string; why: "named" | "owns" }
  | { by: "wallet"; why: "asked" | "no_key" | "free" | "not_owner" };

export interface SignerChoice {
  /** `--wallet`: the owner's Saltix, whatever key file is here. */
  wallet: boolean;
  /** The key file: `--key F`, or `owner.key` beside the manifest. */
  keyPath: string;
  /** Whether `--key` named it. */
  named: boolean;
  /** The owner the registry names (an account's hex): the app's, or a username's holder; null when the slug is free. */
  owner: string | null;
  /** The app's slug or the username, for the words of a refusal. */
  what: string;
}

/** The account (hex) a key file's secret speaks for. */
export const accountOf = (secret: Uint8Array): string => toHex(accountId(fromHex(publicKeyOf(secret), 32)));

/**
 * Who signs the owner's call (`SignerChoice`): `--wallet`, the owner's Saltix; a key file `--key` names, which must be
 * the registry's owner when there is one (else refused); without `--key`, the key file only when the registry already
 * names its account as the owner (an app it registered), and the owner's Saltix otherwise — a free slug too, so that a
 * registration by a key file is always asked for.
 */
export function signerFor(c: SignerChoice): Signer {
  if (c.wallet) {
    if (c.named) throw new UsageError("--wallet or --key: the owner's Saltix signs, or a key file does, not both");
    return { by: "wallet", why: "asked" };
  }
  if (!c.named) {
    if (c.owner === null) return { by: "wallet", why: "free" };
    if (!existsSync(c.keyPath)) return { by: "wallet", why: "no_key" };
  }
  const secret = readKey(c.keyPath);
  const account = accountOf(secret);
  if (c.owner !== null && c.owner !== account) {
    if (c.named) {
      throw new Error(`${c.what}: the registry names another owner (${c.owner}) than ${basename(c.keyPath)}'s account: an app made in ` +
        `Saltix is its owner's phone's, so run it without --key and the owner confirms in Saltix (a QR code)`);
    }
    return { by: "wallet", why: "not_owner" };
  }
  if (c.named) return { by: "key", secret, account, why: "named" };
  return { by: "key", secret, account, why: "owns" };
}

/**
 * `--key F` for a command this tool suggests, only when F is not the own `owner.key` of the project in `dir`. One rule for every hint
 * and page: a key file that owns the app signs its owner's calls by itself (`signerFor`), so after the first publish the
 * suggested command never names `owner.key`, and is the same whoever owns the app (a phone's account: the QR code); a
 * key file elsewhere is not found by itself, so it is named. A first publish (`grain publish --key owner.key`) names it
 * on purpose: a free slug is never registered to a key file unasked.
 */
export const keyFlag = (keyPath: string, dir: string): string => (resolve(dir, keyPath) === resolve(dir, KEY_FILE) ? "" : ` --key ${keyPath}`);

/** An account's address on `network`, for people. */
export const addressOf = (network: string, account: string): string =>
  ["mainnet", "testnet", "devnet"].includes(network) ? encodeAddress(network as NetworkName, fromHex(account, 32)) : account;

/**
 * The line that says, before anything is signed, which account owns what the call makes: the key file's (named, or the
 * owner already), or the owner's Saltix (the account that scans the QR code, for a free slug).
 */
export function ownerLine(s: Signer, network: string, owner: string | null, keyPath: string): string {
  const file = basename(keyPath);
  if (s.by === "key") {
    const address = addressOf(network, s.account);
    if (owner === null) return `owner: ${address}, ${file}'s account on this computer (--key names it): the app is registered to it`;
    return `owner: ${address}, ${file}'s account on this computer, which the registry names as the owner`;
  }
  if (owner === null) return "owner: the account of the Saltix that scans the QR code: a new app is registered to it (--key owner.key signs here instead, on the test network)";
  return `owner: ${addressOf(network, owner)}, as the registry names it: its Saltix signs${s.why === "not_owner" ? ` (${file} here is another account's)` : ""}`;
}
