// `grain status` and `grain doctor`: where a project's server stands, read from its files and the registry, and the
// exact next step. `status` answers one question, whether the server is paired with its app (Saltix 24-app-studio §3a);
// `doctor` checks the rest of the path to an app that runs, and stops at the first thing to do. Neither writes anything
// but the steps' log, and neither prints a secret: keys appear by their fingerprint.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, APP_KEY_FILE, type NodeLike, type RegisteredGrain, bundleHash, decodeOffer, fromHex, grainGet, keyFingerprint,
  nodeCall, registeredKeyStatus, toHex,
} from "@saltix/grain-server";
import { GRAIN_DIR } from "./devlog.js";
import { PAIR_KEY_FILE, gitignoreOk, namedFor, pendingKey, readPairState } from "./pair.js";

/** Where a project's server stands with its app. */
export type PairStatus =
  | "paired" | "pairing" | "unpaired" | "revoked" | "replaced" | "retired" | "unregistered" | "other_network" | "invalid" | "unknown";

export interface KeyState {
  status: PairStatus;
  /** One line on what holds now. */
  detail: string;
  /** The command to run next, or null when there is none. */
  next: string | null;
  slug?: string;
  network?: string;
  fingerprint?: string;
  /** The registry's record of the app, when the key names one and the node answered. */
  grain?: RegisteredGrain | null;
}

/** Where the server of the project in `dir` stands, by its files and the registry `node` answers for (`flags`: the words
 *  that reach it again in a command suggested). */
export async function keyState(dir: string, node: NodeLike, flags = ""): Promise<KeyState> {
  const appKeyPath = join(dir, APP_KEY_FILE);
  let status: { network: string; genesis: string };
  try {
    status = await nodeCall(node, "node_status");
  } catch (e) {
    return {
      status: "unknown", detail: `the network did not answer (${(e as Error).message})`,
      next: `grain status${flags} again once the network answers (or pass --relay or --node)`,
    };
  }
  if (existsSync(appKeyPath)) {
    let key: AppKey;
    try {
      key = AppKey.parse(readFileSync(appKeyPath, "utf8"));
    } catch (e) {
      return { status: "invalid", detail: `app.key is not a developer key (${(e as Error).message})`, next: `grain pair --new${flags}` };
    }
    const base = { slug: key.slug, network: key.network, fingerprint: keyFingerprint(key.publicKey) };
    if (!key.isFor(status.network, status.genesis)) {
      return {
        ...base, status: "other_network",
        detail: `app.key is for ${key.network} ${key.genesis}, but the network answering is ${status.network} ${status.genesis.slice(0, 16)} (a reset?)`,
        next: `grain pair --new${flags}`,
      };
    }
    const grain = await grainGet(node, key.slug);
    const why = registeredKeyStatus(grain, key.publicKey);
    if (why === null) {
      const first = grain!.servers![0] === key.publicKey;
      return {
        ...base, status: "paired", grain,
        detail: `paired with ${key.slug} on ${key.network} (key ${base.fingerprint}${first ? ", the app's chat goes to it" : ", not the first key: chats go to the first"})`,
        next: null,
      };
    }
    const words = {
      revoked: "the owner revoked the app's keys", replaced: "the owner replaced this key", retired: `${key.slug} is retired`,
      unregistered: `the registry holds no app ${key.slug}`,
    } as const;
    return { ...base, status: why, grain, detail: `app.key: ${words[why]}`, next: `grain pair --new${flags}` };
  }
  const secret = existsSync(join(dir, PAIR_KEY_FILE)) ? pendingKey(dir) : null;
  if (secret !== null) {
    const key = toHex(ed25519.getPublicKey(secret));
    const state = readPairState(dir);
    const answered = state && state.genesis === status.genesis ? state.answered : [];
    const named = answered.length > 0 ? await namedFor(node, key, answered) : null;
    if (named) {
      return {
        status: "pairing", slug: named.slug, fingerprint: keyFingerprint(key),
        detail: `the registry names the pending key ${keyFingerprint(key)} for ${named.slug}: grain pair writes app.key`,
        next: `grain pair${flags}`,
      };
    }
    let offer = "no offer shown";
    if (state) {
      try {
        const o = decodeOffer(fromHex(state.offer));
        offer = Date.now() < o.expiresAt ? `an offer valid until ${new Date(o.expiresAt).toISOString()}` : "its offer expired";
      } catch {
        offer = "an unreadable offer";
      }
    }
    const asked = answered.length > 0 ? `; Saltix asked for ${answered[answered.length - 1]!.slug}, and its transaction has not named the key yet` : "";
    return {
      status: "pairing", fingerprint: keyFingerprint(key),
      detail: `a key made by grain pair (${keyFingerprint(key)}) is not paired yet: ${offer}${asked}`,
      next: `grain pair${flags}`,
    };
  }
  const env = process.env.SALTIX_APP_KEY?.trim() ? " (SALTIX_APP_KEY is set in this shell: the server would use it, this command does not read it)" : "";
  return { status: "unpaired", detail: `no app.key and no key waiting in ${GRAIN_DIR}/${env}`, next: `grain pair${flags}` };
}

/** One of `doctor`'s findings: ok, or what to do. */
export interface Finding {
  ok: boolean;
  what: string;
  detail: string;
  next?: string;
}

/** Every check of `grain doctor`, in the order of the path to an app that runs. */
export async function doctor(dir: string, node: NodeLike, flags = ""): Promise<{ state: KeyState; findings: Finding[] }> {
  const findings: Finding[] = [];
  const manifestPath = join(dir, "grain.json");
  const chatPath = join(dir, "chat.json");
  let manifest: { slug?: string; version?: number; entry?: Record<string, { bundle?: string }> } | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      findings.push({ ok: true, what: "project", detail: `grain.json: ${manifest!.slug}${manifest!.version === undefined ? "" : `, version ${manifest!.version}`}` });
    } catch (e) {
      findings.push({ ok: false, what: "project", detail: `grain.json does not read (${(e as Error).message})`, next: "fix grain.json (grain lint says what is wrong)" });
    }
  } else if (!existsSync(chatPath)) {
    findings.push({ ok: false, what: "project", detail: "no grain.json or chat.json here: not an app's project", next: "grain init <dir> --chat (or cd into your app's project)" });
  }

  const ignored = gitignoreOk(dir);
  findings.push(ignored
    ? { ok: true, what: "git", detail: ".gitignore keeps app.key, *.key and .grain/ out of git" }
    : { ok: false, what: "git", detail: ".gitignore does not keep app.key, *.key and .grain/ out of git", next: `grain pair${flags} (it adds them), or add them to .gitignore` });

  const state = await keyState(dir, node, flags);
  findings.push({ ok: state.status === "paired", what: "key", detail: state.detail, ...(state.next ? { next: state.next } : {}) });

  const appKeyPath = join(dir, APP_KEY_FILE);
  if (existsSync(appKeyPath) && process.platform !== "win32" && (statSync(appKeyPath).mode & 0o077) !== 0) {
    findings.push({ ok: false, what: "key file", detail: "app.key is readable by others", next: "chmod 600 app.key" });
  }

  if (state.status === "paired" && manifest?.slug && manifest.slug !== state.slug) {
    findings.push({ ok: false, what: "app", detail: `grain.json names ${manifest.slug}, but the key is ${state.slug}'s`, next: `set grain.json's slug to ${state.slug}, or grain pair --new${flags} for ${manifest.slug}` });
  }

  const chatOnly = existsSync(chatPath) && (!manifest?.entry || "chat" in manifest.entry);
  if (existsSync(chatPath)) {
    try {
      const version = (JSON.parse(readFileSync(chatPath, "utf8")) as { version?: number }).version ?? 0;
      findings.push(version >= 2
        ? { ok: true, what: "chat spec", detail: `chat.json version ${version}` }
        : { ok: false, what: "chat spec", detail: `chat.json is version ${version}: an app made in Saltix starts at 1, and wallets take only a higher one`, next: 'raise chat.json\'s "version" to 2 or more' });
    } catch (e) {
      findings.push({ ok: false, what: "chat spec", detail: `chat.json does not read (${(e as Error).message})`, next: "fix chat.json (grain chat-spec says what is wrong)" });
    }
    if (existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"))) {
      findings.push({ ok: false, what: "dependencies", detail: "node_modules is missing", next: "npm install" });
    }
  }

  const sealed = manifest?.entry?.sealed;
  if (sealed) {
    const zip = join(dir, "bundle.zip");
    if (!existsSync(zip)) findings.push({ ok: false, what: "bundle", detail: "bundle.zip is not built", next: "grain bundle" });
    else if (bundleHash(new Uint8Array(readFileSync(zip))) !== sealed.bundle) {
      findings.push({ ok: false, what: "bundle", detail: "bundle.zip is not the bundle grain.json names", next: "grain bundle (then raise grain.json's version and publish)" });
    } else findings.push({ ok: true, what: "bundle", detail: "bundle.zip is the one grain.json names" });
  }

  const grain = state.grain;
  if (state.status === "paired" && grain && manifest?.version !== undefined && !chatOnly) {
    const held = grain.version;
    const registryChat = grain.manifest ? "chat" in grain.manifest.manifest.entry : false;
    if (registryChat || held < manifest.version) {
      findings.push({
        ok: false, what: "published", detail: `the registry holds version ${held}${registryChat ? " (a chat-only app)" : ""}, grain.json is ${manifest.version}`,
        next: manifest.version > held ? `grain publish${flags}` : `raise grain.json's version above ${held}, then grain publish${flags}`,
      });
    } else findings.push({ ok: true, what: "published", detail: `the registry holds version ${held}` });
  }
  if (state.status === "paired" && grain) {
    findings.push(grain.profile
      ? { ok: true, what: "connect profile", detail: `revision ${grain.profile.profile.revision} in the registry` }
      : { ok: false, what: "connect profile", detail: "the registry holds no Connect profile: users see only the description", next: `grain profile${flags}` });
  }
  return { state, findings };
}
