// `grain status` and `grain doctor`: where a project's server stands, read from its files and the registry, and the
// exact next step. `status` answers one question, whether the server is paired with its app (Saltix 24-app-studio §3a);
// a page alone has no server, so for it pairing is `not_needed`. `doctor` checks the rest of the path to an app that runs
// or a page that is published, and stops at the first thing to do: before a page's first publish, what registering it
// takes (the deposit, and on the test network without a phone the faucet and `--key owner.key`). Neither writes
// anything but the steps' log, and neither prints a secret: keys appear by their fingerprint.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, APP_KEY_FILE, type NodeLike, type RegisteredGrain, NO_ICON, blobHeld, decodeOffer, fromHex, grainGet, grainQuote, iconHash,
  keyFingerprint, nodeCall, registeredKeyStatus, toHex,
} from "@saltix/grain-server";
import { makeBundle } from "./bundle.js";
import { GRAIN_DIR } from "./devlog.js";
import { saltOf } from "./faucet.js";
import { ICON_FILES, checkIcon } from "./icon.js";
import { accountOf, addressOf } from "./owner.js";
import { PAIR_KEY_FILE, gitignoreOk, namedFor, pendingKey, readPairState } from "./pair.js";
import { KEY_FILE, readKey } from "./project.js";
import { readPublishState } from "./publish-flow.js";
import { salt } from "./registry.js";

/** Where a project's server stands with its app; `not_needed` for a page alone, which has no server. */
export type PairStatus =
  | "paired" | "not_needed" | "pairing" | "unpaired" | "revoked" | "replaced" | "retired" | "unregistered" | "other_network" | "invalid"
  | "unknown";

/** The states `grain status` exits 0 for: nothing to pair. */
export const settled = (status: PairStatus): boolean => status === "paired" || status === "not_needed";

/** What the project in `dir` is: a page alone (its manifest names a page, and there is no `chat.json`), an app with a
 *  chat (`chat.json`, or a chat-only manifest), or no app's project. */
export function projectKind(dir: string): "page" | "chat" | "none" {
  let entry: unknown;
  try {
    const value = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")) as { entry?: unknown; manifest?: { entry?: unknown } };
    entry = value.manifest?.entry ?? value.entry;
  } catch {
    entry = undefined;
  }
  const object = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
  if (existsSync(join(dir, "chat.json")) || (object !== null && "chat" in object)) return "chat";
  return object !== null ? "page" : "none";
}

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
  // A page alone has no server, so no key to pair; a key it has (or one being paired) is still checked below.
  if (!existsSync(appKeyPath) && !existsSync(join(dir, PAIR_KEY_FILE)) && projectKind(dir) === "page") {
    return {
      status: "not_needed",
      detail: "a page alone needs no server key: nothing to pair (grain pair would only let grain publish put the bundle into the network before the owner signs)",
      next: `grain doctor${flags}`,
    };
  }
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

/** Where a page's publish stands (Saltix 32-images §7.3): its bundle not uploaded, held pending on a server key's word,
 *  waiting for the owner's signature (the link shown), its day over, or published. */
export type PublishStatus = "not_uploaded" | "pending" | "waiting_for_owner" | "pending_expired" | "published";

/** What a test network's key file needs beyond a slug's deposit: two registry calls' fees (registering, then making it
 *  private), with room to spare: 0.001 SALT. */
const FEES_MARGIN = 1_000_000n;

/**
 * Before a page's first publish (its slug free): what registering it takes, and the way there. The owner's Saltix
 * registers it from `grain publish`'s QR code and pays the deposit; on a test network without a phone, `owner.key`
 * does with `--key`, once the faucet gave its account the deposit and the fees.
 */
async function firstPublish(dir: string, node: NodeLike, slug: string, flags: string): Promise<Finding> {
  const { deposit } = await grainQuote(node, slug);
  const { network } = await nodeCall<{ network: string }>(node, "node_status");
  let detail = `${slug} is free: its first grain publish registers it, keeping a deposit of ${salt(deposit)} SALT until it retires`;
  let next = `grain publish${flags}: a QR code, and the owner's Saltix registers the app and pays the deposit`;
  if (network !== "mainnet") {
    let noPhone = `grain faucet --wait${flags}, then grain publish --key ${KEY_FILE}${flags}`;
    if (existsSync(join(dir, KEY_FILE))) {
      try {
        const account = accountOf(readKey(join(dir, KEY_FILE)));
        const held = await saltOf(node, addressOf(network, account));
        detail += `; ${KEY_FILE}'s account holds ${salt(held)} SALT`;
        if (held >= deposit + FEES_MARGIN) noPhone = `grain publish --key ${KEY_FILE}${flags}`;
      } catch {
        // An unreadable key file is grain publish's to report; the way stays as it is.
      }
    }
    next += `; without a phone, on the test network: ${noPhone} (the app is then ${KEY_FILE}'s account's)`;
  }
  return { ok: false, what: "registry", detail, next };
}

/** Every check of `grain doctor`, in the order of the path to an app that runs; and the next step, or what to say when
 *  there is none. */
export async function doctor(dir: string, node: NodeLike, flags = "", now = Date.now()): Promise<{ state: KeyState; findings: Finding[]; publish: PublishStatus | null; next: string }> {
  const findings: Finding[] = [];
  const manifestPath = join(dir, "grain.json");
  const chatPath = join(dir, "chat.json");
  let manifest: { slug?: string; version?: number; icon?: string; entry?: Record<string, { bundle?: string; origins?: string[] }> } | null = null;
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
  // A page alone needs no server (a paired key only lets grain publish put the bundle up before the owner signs). A key
  // that stopped working still needs one.
  const kind = projectKind(dir);
  if (state.status === "not_needed") {
    findings.push({ ok: true, what: "key", detail: `not needed: a page alone has no server (grain pair${flags} would let grain publish put its bundle into the network before the owner signs)` });
  } else {
    findings.push({ ok: state.status === "paired", what: "key", detail: state.detail, ...(state.next ? { next: state.next } : {}) });
  }

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

  // The registry's record of the app, whether or not this computer's key is paired.
  let grain = state.grain;
  if (grain === undefined && manifest?.slug && state.status !== "unknown") grain = await grainGet(node, manifest.slug).catch(() => undefined);
  const page = manifest?.entry !== undefined && !chatOnly && !("chat" in manifest.entry);
  const placeholder = (manifest?.entry?.hosted?.origins ?? []).length > 0 && manifest!.entry!.hosted!.origins!.every((o) => /\.example(:\d+)?$/.test(o));
  const sealed = manifest?.entry?.sealed;
  let publish: PublishStatus | null = null;
  // A page whose slug is free: what its first publish takes, before anything else of the publish.
  if (page && manifest?.slug && grain === null) {
    try {
      findings.push(await firstPublish(dir, node, manifest.slug, flags));
    } catch {
      // The network did not answer: the key's finding says so.
    }
  }
  if (page && (sealed || placeholder)) {
    // The bundle grain.json names, and whether public/ still makes it.
    let built: string | null = null;
    try {
      built = existsSync(join(dir, "public")) ? makeBundle(join(dir, "public")).hash : null;
    } catch (e) {
      findings.push({ ok: false, what: "bundle", detail: `public/ does not make a bundle (${(e as Error).message})`, next: "fix public/ (names, size), then grain publish" });
    }
    const held = grain?.manifest && "sealed" in grain.manifest.manifest.entry ? grain.manifest.manifest.entry.sealed.bundle : null;
    const version = manifest?.version ?? 0;
    if (!sealed) {
      findings.push({ ok: true, what: "bundle", detail: "public/ is not sealed yet: grain publish seals it and puts it into the network" });
    } else if (built !== null && built !== sealed.bundle) {
      findings.push({
        ok: true, what: "bundle",
        detail: `public/ changed since grain.json's bundle: grain publish seals it again${grain && grain.version >= version ? `, as v${grain.version + 1}` : ""}`,
      });
    } else {
      findings.push({ ok: true, what: "bundle", detail: "grain.json names the bundle public/ makes" });
    }
    // Where the publish stands: published, held pending (waiting for the owner, or not shown yet), its day over, or
    // not uploaded at all.
    const run = readPublishState(dir);
    const ours = run && sealed && run.bundle === sealed.bundle && run.version === version && run.slug === manifest?.slug ? run : null;
    const until = ours?.pending_until ? Date.parse(ours.pending_until) : null;
    if (sealed && grain && grain.version === version && held === sealed.bundle) {
      publish = "published";
      const inNetwork = await blobHeld(node, "grain_bundle", sealed.bundle).catch(() => "absent" as const);
      findings.push(inNetwork === "absent"
        ? { ok: false, what: "upload", detail: "published, but the relay answering neither holds its bundle nor knows where it is", next: `grain publish${flags} (it puts the bundle up again)` }
        : { ok: true, what: "upload", detail: "published: the network holds its bundle" });
    } else if (ours?.uploaded_at && until !== null && until > now) {
      publish = ours.link_shown_at ? "waiting_for_owner" : "pending";
      findings.push({
        ok: false, what: "upload",
        detail: `the network holds the bundle pending until ${ours.pending_until}${ours.link_shown_at ? ": waiting for the owner to sign the publishing link" : ""}`,
        next: ours.link_shown_at ? `the owner scans the QR code in Saltix (grain publish${flags} shows it again, and finishes once they did)` : `grain publish${flags}`,
      });
    } else if (ours?.uploaded_at && until !== null) {
      publish = "pending_expired";
      findings.push({ ok: false, what: "upload", detail: `the bundle's day in the network ended at ${ours.pending_until} before the owner signed`, next: `grain publish${flags} (it puts it up again)` });
    } else if (ours?.link_shown_at) {
      publish = "waiting_for_owner";
      findings.push({ ok: false, what: "upload", detail: "waiting for the owner to sign the publishing link; the bundle goes up once the registry names it", next: `the owner scans the QR code in Saltix, while grain publish${flags} runs` });
    } else {
      publish = "not_uploaded";
      findings.push({ ok: false, what: "upload", detail: "the bundle is not in the network yet", next: `grain publish${flags}` });
    }
  }

  if (grain && manifest?.version !== undefined && !chatOnly && publish === null) {
    const held = grain.version;
    const registryChat = grain.manifest ? "chat" in grain.manifest.manifest.entry : false;
    if (registryChat || held < manifest.version) {
      findings.push({
        ok: false, what: "published", detail: `the registry holds version ${held}${registryChat ? " (a chat-only app)" : ""}, grain.json is ${manifest.version}`,
        // grain publish raises the version itself when the registry holds this one or above.
        next: `grain publish${flags}`,
      });
    } else findings.push({ ok: true, what: "published", detail: `the registry holds version ${held}` });
  }

  // The icon: the file grain.json names, to the standard, and in the network once published.
  if (manifest && !chatOnly) {
    const icon = manifest.icon ?? NO_ICON;
    const file = ICON_FILES.find((f) => existsSync(join(dir, f)));
    if (icon === NO_ICON) {
      findings.push({ ok: true, what: "icon", detail: "none: wallets draw the app's monogram (grain icon <picture> --out icon.png makes one)" });
    } else if (!file || iconHash(new Uint8Array(readFileSync(join(dir, file)))) !== icon) {
      findings.push({ ok: false, what: "icon", detail: `no ${ICON_FILES.join(" or ")} here is the icon grain.json names`, next: "grain icon <picture> --out icon.png (it names the new one)" });
    } else {
      const lint = checkIcon(new Uint8Array(readFileSync(join(dir, file))), icon);
      const published = grain && grain.manifest && grain.manifest.manifest.icon === icon;
      const inNetwork = published ? await blobHeld(node, "grain_icon", icon).catch(() => "absent" as const) : null;
      if (lint.errors.length > 0) findings.push({ ok: false, what: "icon", detail: lint.errors[0]!, next: `grain icon ${file} --out ${file}` });
      else if (inNetwork === "absent") findings.push({ ok: false, what: "icon", detail: "the registry names it, but the network does not hold it: wallets draw the monogram", next: `grain publish${flags} (it uploads the icon)` });
      else findings.push({ ok: true, what: "icon", detail: `${file}${lint.warnings.length > 0 ? `; ${lint.warnings.length} warning(s): grain icon ${file} says them` : ""}${inNetwork === "held" ? "; in the network" : ""}` });
    }
  }
  if (grain && state.status !== "unknown") {
    findings.push(grain.profile
      ? { ok: true, what: "connect profile", detail: `revision ${grain.profile.profile.revision} in the registry` }
      : { ok: false, what: "connect profile", detail: "the registry holds no Connect profile: users see only the description", next: `grain profile${flags}` });
  }
  const first = findings.find((f) => !f.ok);
  const done = kind === "page"
    ? publish === "published"
      ? "nothing: the page is published and the project is in order (a change to public/ or grain.json: grain publish makes the next version)"
      : "nothing: the project is in order"
    : "nothing: the server is paired and the project is in order (npm start runs it)";
  return { state, findings, publish, next: first?.next ?? done };
}
