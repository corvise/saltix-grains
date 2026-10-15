// A grain's developer key (Saltix 24-app-studio §3): a server key the grain's registry record names, handed to
// whoever builds the app as one string, `saltix-app:1:<hrp>:<genesis>:<slug>:<secret>` — the network's address prefix,
// the first 8 bytes of its genesis hash, the grain's slug and the server key's Ed25519 secret, hex in lower case. It is
// read as strictly as the reference's `saltix_types::app_key` reads it, and it is a secret: whoever holds it speaks
// for the app until the owner replaces the key. An `AppKey` never prints, logs or serializes its secret.
//
// No Node APIs here.
import { ed25519 } from "@noble/curves/ed25519";
import { type NetworkName, accountId, encodeAddress } from "./address.js";
import { fromHex, toHex } from "./bytes.js";

/** What every developer key starts with. */
export const APP_KEY_PREFIX = "saltix-app:1:";

const HRP: Record<NetworkName, string> = { mainnet: "salt", testnet: "tsalt", devnet: "dsalt" };

/** Why a text is not a developer key, as the reference names it. The text itself is never part of it. */
export type AppKeyProblem = "not_app_key" | "unknown_network" | "malformed" | "bad_slug";

const EXPLAINED: Record<AppKeyProblem, string> = {
  not_app_key: "not a developer key (it starts with saltix-app:1:)",
  unknown_network: "a developer key of an unknown network",
  malformed: "a malformed developer key",
  bad_slug: "the developer key names no grain's slug",
};

/** A text that is not a developer key; `problem` says why, and the message never quotes the text. */
export class AppKeyError extends Error {
  constructor(public readonly problem: AppKeyProblem) {
    super(EXPLAINED[problem]);
    this.name = "AppKeyError";
  }
}

/** White space as Rust's `str::trim` takes it (Unicode `White_Space`; not U+FEFF, which JavaScript's `trim` drops). */
const trim = (text: string) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const slugOk = (slug: string) => /^[a-z0-9][a-z0-9-]{2,31}$/.test(slug);
const lowerHex = (text: string, bytes: number) => new RegExp(`^[0-9a-f]{${2 * bytes}}$`).test(text);

const SECRETS = new WeakMap<AppKey, Uint8Array>();

/** A grain's server key on one network, read from its developer key. */
export class AppKey {
  readonly network: NetworkName;
  /** The network's address prefix: `salt`, `tsalt` or `dsalt`. */
  readonly hrp: string;
  /** The first 8 bytes of the network's genesis hash, hex. */
  readonly genesis: string;
  readonly slug: string;
  /** The server key's Ed25519 public key, hex: what the registry names. */
  readonly publicKey: string;
  /** The server's address at relays (its personal address on this network): the app chat's address. */
  readonly address: string;

  private constructor(network: NetworkName, genesis: string, slug: string, secret: Uint8Array) {
    this.network = network;
    this.hrp = HRP[network];
    this.genesis = genesis;
    this.slug = slug;
    const publicKey = ed25519.getPublicKey(secret);
    this.publicKey = toHex(publicKey);
    this.address = encodeAddress(network, accountId(publicKey));
    SECRETS.set(this, secret);
    Object.freeze(this);
  }

  /**
   * Read a developer key: exactly the form Saltix writes, `saltix-app:1:<hrp>:<16 hex>:<slug>:<64 hex>`, lower-case
   * hex, a known prefix, a valid slug, white space only around it. Throws an `AppKeyError` that never quotes the text.
   */
  static parse(text: string): AppKey {
    const body = trim(text);
    if (!body.startsWith(APP_KEY_PREFIX)) throw new AppKeyError("not_app_key");
    const parts = body.slice(APP_KEY_PREFIX.length).split(":");
    if (parts.length !== 4) throw new AppKeyError("malformed");
    const [hrp, genesis, slug, secret] = parts as [string, string, string, string];
    const network = (Object.keys(HRP) as NetworkName[]).find((n) => HRP[n] === hrp);
    if (!network) throw new AppKeyError("unknown_network");
    if (!slugOk(slug)) throw new AppKeyError("bad_slug");
    if (!lowerHex(genesis, 8) || !lowerHex(secret, 32)) throw new AppKeyError("malformed");
    return new AppKey(network, genesis, slug, fromHex(secret, 32));
  }

  /** The developer key of `slug` on the network of `genesis` (its full hash, or its first 8 bytes) with the server key
   *  `secret`: what Saltix makes, for tools and tests. */
  static of(network: NetworkName, genesis: string, slug: string, secret: Uint8Array): AppKey {
    if (!lowerHex(genesis, 32) && !lowerHex(genesis, 8)) throw new TypeError("genesis: the network's genesis hash in lowercase hex");
    if (!slugOk(slug)) throw new AppKeyError("bad_slug");
    if (secret.length !== 32) throw new TypeError("secret: 32 bytes");
    return new AppKey(network, genesis.slice(0, 16), slug, Uint8Array.from(secret));
  }

  /** Whether the key is for the network a node reports: its kind and its genesis hash (hex). */
  isFor(network: string, genesis: string): boolean {
    return network === this.network && genesis.slice(0, 16) === this.genesis;
  }

  /** The server key's Ed25519 secret: for the SDK's signers and the relay connection. Never log or print it. */
  secret(): Uint8Array {
    return SECRETS.get(this)!;
  }

  /** The text to hand over: it holds the secret, so it is written only on purpose (`grain app-key make`). */
  reveal(): string {
    return `${APP_KEY_PREFIX}${this.hrp}:${this.genesis}:${this.slug}:${toHex(this.secret())}`;
  }

  /** Its public parts: the network, the genesis, the slug and the public key. */
  describe(): { network: NetworkName; hrp: string; genesis: string; slug: string; publicKey: string; address: string } {
    return { network: this.network, hrp: this.hrp, genesis: this.genesis, slug: this.slug, publicKey: this.publicKey, address: this.address };
  }

  toString(): string {
    return `AppKey(${this.hrp} ${this.genesis} ${this.slug}, key ${this.publicKey.slice(0, 16)}…)`;
  }

  toJSON(): ReturnType<AppKey["describe"]> {
    return this.describe();
  }

  /** What Node's `console.log` and `util.inspect` show: the public parts only. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
