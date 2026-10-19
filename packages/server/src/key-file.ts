// Where a server finds its key (Saltix 24-app-studio §3, §3a): the key `grain pair` made on this computer and the
// registry named, in the project's `app.key`; or a developer key handed over where no command runs. A server that has
// no key, or only one `grain pair` has not paired yet, refuses to start and says to run `grain pair`: it would answer
// nobody, since wallets trust only a key the registry names.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppKey } from "./app-key.js";
import { ChatSetupError } from "./chat-server.js";

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
