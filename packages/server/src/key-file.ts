// Where a server finds its key (Saltix 24-app-studio §3, §3a): the key `grain pair` made on this computer and the
// registry named, in the project's `app.key`; or a developer key handed over where no command runs. A server that has
// no key, or only one `grain pair` has not paired yet, refuses to start and says to run `grain pair`: it would answer
// nobody, since wallets trust only a key the registry names. And where the key of an app's support address is: in the
// environment alone (19-connect §11.1, `supportConsentFromEnvironment`).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppKey } from "./app-key.js";
import { fromHex } from "./bytes.js";
import { ChatSetupError } from "./chat-server.js";
import { type SupportConsent, signSupportConsent } from "./profile.js";

/** The project's key file, which `grain pair` writes once the registry names its key. */
export const APP_KEY_FILE = "app.key";
/** Where `grain pair` keeps a key it has not paired yet, in the project. */
export const PENDING_KEY_FILE = join(".grain", "pair.key");

/**
 * The server's key, from (in order) `SALTIX_APP_KEY` (the developer key itself), the file `SALTIX_APP_KEY_FILE` names
 * (a systemd credential), or `app.key` in `dir`: owner-only, never from the command line, which shells keep. Throws a
 * `ChatSetupError` `chat_unpaired` (exit 78) when there is none, saying to run `grain pair`, `chat_key_exposed` for a
 * file others may read, and an `AppKeyError` for a text that is not a developer key. Whether the registry names it is
 * `ChatServer.start`'s check.
 */
export function appKeyFromEnvironment(options: { dir?: string; env?: NodeJS.ProcessEnv } = {}): AppKey {
  const env = options.env ?? process.env;
  const dir = options.dir ?? process.cwd();
  if (env.SALTIX_APP_KEY?.trim()) return AppKey.parse(env.SALTIX_APP_KEY);
  const file = env.SALTIX_APP_KEY_FILE || join(dir, APP_KEY_FILE);
  if (!existsSync(file)) {
    const pending = existsSync(join(dir, PENDING_KEY_FILE));
    throw new ChatSetupError("chat_unpaired", pending
      ? "this server's key is not paired with an app yet: run grain pair here again and scan its QR code with the app " +
        "owner's Saltix; it writes app.key once the registry names the key"
      : `no key: this server is not paired with an app (${file} is not there). Run grain pair here and scan its QR code ` +
        "with the app owner's Saltix: the key is made on this computer and never leaves it. Where no command runs, set " +
        "SALTIX_APP_KEY to a developer key made in Saltix");
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new ChatSetupError("chat_key_exposed", `${file}: readable by others; chmod 600 it (it holds the server's key)`);
  }
  return AppKey.parse(readFileSync(file, "utf8"));
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
