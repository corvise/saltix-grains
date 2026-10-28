// Where a server finds its key (Saltix 24-app-studio §3a): the key `grain pair` made on this computer and the
// registry named, in the project's `app.key` beside `app.json`, which names its public half. A server that has no key,
// or only one `grain pair` has not paired yet, refuses to start and says to run `grain pair`: it would answer nobody,
// since wallets trust only a key the registry names. A developer key made in Saltix before pairing (§3, retired
// 2026-10-28: Saltix makes no new ones) still works, from `SALTIX_APP_KEY` or a file, with a warning to pair a server in
// its place. And where the key of an app's support address is: in the environment alone (19-connect §11.1,
// `supportConsentFromEnvironment`).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppKey } from "./app-key.js";
import { fromHex } from "./bytes.js";
import { ChatSetupError } from "./chat-server.js";
import { type SupportConsent, signSupportConsent } from "./profile.js";

/** The project's key file, which `grain pair` writes once the registry names its key. */
export const APP_KEY_FILE = "app.key";
/** Beside it, what `grain pair` paired: the app, its owner, the network and the key's public half (nothing secret). */
export const APP_JSON_FILE = "app.json";
/** Where `grain pair` keeps a key it has not paired yet, in the project. */
export const PENDING_KEY_FILE = join(".grain", "pair.key");

/** What a server says at start of a key that was not paired on this computer (`keyPairedHere`): a developer key made
 *  in Saltix, which keeps working while the owner pairs a server in its place. */
export const DEVELOPER_KEY_WARNING =
  "this server runs on a developer key made in Saltix (or a key written by hand), not one paired here: Saltix makes no new " +
  "developer keys, and this one keeps working until the owner removes it. Pair a server in its place: grain pair --new " +
  "here, scan its QR code with the owner's Saltix, then remove the old key in the app's page.";

/** Whether `key` is the one `grain pair` paired in `dir`: `app.json` beside `app.key` names its public half. A key from
 *  anywhere else (the environment, a file, `app.key` written by hand) was made elsewhere and carried here. */
export function keyPairedHere(dir: string, key: AppKey): boolean {
  try {
    const app = JSON.parse(readFileSync(join(dir, APP_JSON_FILE), "utf8")) as { key?: unknown; slug?: unknown };
    return app.key === key.publicKey && app.slug === key.slug;
  } catch {
    return false;
  }
}

/**
 * The server's key, from (in order) `SALTIX_APP_KEY` (the key's text itself), the file `SALTIX_APP_KEY_FILE` names (a
 * systemd credential), or `app.key` in `dir`: owner-only, never from the command line, which shells keep. Throws a
 * `ChatSetupError` `chat_unpaired` (exit 78) when there is none, saying to run `grain pair`, `chat_key_exposed` for a
 * file others may read, and an `AppKeyError` for a text that is not a key. A key not paired on this computer
 * (`keyPairedHere`: a developer key made in Saltix) is taken with `DEVELOPER_KEY_WARNING` to `warn` (the console unless
 * told): pair a server in its place. Whether the registry names the key is `ChatServer.start`'s check.
 */
export function appKeyFromEnvironment(options: { dir?: string; env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {}): AppKey {
  const env = options.env ?? process.env;
  const dir = options.dir ?? process.cwd();
  const warn = options.warn ?? ((message: string) => console.warn(`warning: ${message}`));
  const taken = (key: AppKey): AppKey => {
    if (!keyPairedHere(dir, key)) warn(DEVELOPER_KEY_WARNING);
    return key;
  };
  if (env.SALTIX_APP_KEY?.trim()) return taken(AppKey.parse(env.SALTIX_APP_KEY));
  const file = env.SALTIX_APP_KEY_FILE || join(dir, APP_KEY_FILE);
  if (!existsSync(file)) {
    const pending = existsSync(join(dir, PENDING_KEY_FILE));
    throw new ChatSetupError("chat_unpaired", pending
      ? "this server's key is not paired with an app yet: run grain pair here again and scan its QR code with the app " +
        "owner's Saltix; it writes app.key once the registry names the key"
      : `no key: this server is not paired with an app (${file} is not there). Run grain pair here with the command from the ` +
        "app's page in Saltix (--app, --owner, --genesis) and scan its QR code with the app owner's Saltix: the key is made on " +
        "this computer and never leaves it");
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new ChatSetupError("chat_key_exposed", `${file}: readable by others; chmod 600 it (it holds the server's key)`);
  }
  return taken(AppKey.parse(readFileSync(file, "utf8")));
}

/** Where `supportConsentFromEnvironment` reads a support address's key: its Ed25519 secret, 64 hex digits. */
export const SUPPORT_KEY_ENV = "SALTIX_SUPPORT_KEY";

/** The key in `SALTIX_SUPPORT_KEY` is missing or not one, or what it would sign for is no app's (the slug, the owner or
 *  the genesis hash out of form). The message names the variable, never its value. */
export class SupportKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportKeyError";
  }
}

/**
 * The consent of the support address whose key `SALTIX_SUPPORT_KEY` holds to answer for `owner`'s (hex account) app
 * `slug` on the network of `genesis` (hash, hex): what the app's owner puts in its Connect profile beside that address
 * (19-connect §11.1, `support_consent`; `grain support <address> --consent F` attaches it). The key is a personal
 * address's own Ed25519 secret (the address is its kind 0, `accountId(publicKey)`), read from the environment alone,
 * never a file in a repository, and it never leaves the process: only its public half and the signature are in the
 * consent, which is public. Throws a `SupportKeyError` that names the variable and never its value.
 */
export function supportConsentFromEnvironment(o: { genesis: string; slug: string; owner: string }, env: NodeJS.ProcessEnv = process.env): SupportConsent {
  const text = env[SUPPORT_KEY_ENV]?.trim();
  if (!text) throw new SupportKeyError(`no ${SUPPORT_KEY_ENV}: set it to the support address's Ed25519 secret (64 hex digits) where its holder runs this`);
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new SupportKeyError(`${SUPPORT_KEY_ENV}: not an Ed25519 secret (64 hex digits)`);
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(o.slug)) throw new SupportKeyError(`the slug ${JSON.stringify(o.slug)}: 3 to 32 of [a-z0-9-]`);
  if (!/^[0-9a-f]{64}$/.test(o.owner)) throw new SupportKeyError("the owner: an account id, 64 lowercase hex digits");
  if (!/^[0-9a-f]{64}$/.test(o.genesis)) throw new SupportKeyError("the genesis hash: 64 lowercase hex digits");
  const secret = fromHex(text.toLowerCase(), 32);
  try {
    return signSupportConsent(secret, o.genesis, o.slug, o.owner);
  } finally {
    // The secret's bytes do not outlive the call (the environment's text is the process's to keep or drop).
    secret.fill(0);
  }
}
