// `grain publish`: an app's new version from the developer's computer straight into the Saltix network (Saltix 12-grains
// §10, 32-images §7), with no server of the developer's or anyone's in between.
//
// A page (a sealed app, the default for an app with a page):
//   1. build    `public/` sealed into one ZIP (`grain bundle`'s bytes), checked as every node checks it (32-images §2a);
//   2. sources  none on a network that runs protocol version 2; before it, copies the network itself serves at up to 3
//               relays of its relay list (`sources.ts`); the developer's own hosts stay when grain.json names them;
//   3. upload   with a server key the registry names for the app (`grain pair`'s `app.key`, or a developer key), the
//               bundle goes into the network now, in pieces, on that key's statement: held pending for a day, so the
//               owner signs whenever they like and this computer need not stay on; without one, once the registry
//               names it (step 5);
//   4. sign     the owner's Saltix signs the manifest from a QR code (or `owner.key` on test networks);
//   5. registry watched until it holds the version; the bundle goes up now if it did not before;
//   6. icon     the icon the manifest names goes up (`blob_put`), unless the network holds it.
// Run again, it goes on from where it stopped: a version the registry holds already only gets its uploads.
// A chat-only app, and a hosted page (`--hosted`), skip 1–3 and 5's upload.
//
// Every step goes to `.grain/log.jsonl` with a stable reason (docs/devex.md); where the publish stands goes to
// `.grain/publish.json` (nothing secret), which `grain doctor` reads. No key is ever printed or logged.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import {
  AppKey, AppKeyError, BlobRefused, MAX_NETWORK_BUNDLE_BYTES, NAMED_REASONS, NO_ICON, PENDING_MS, UNOWNED, type Manifest, type NodeLike,
  type RegisteredGrain, type SignedManifest, accountId, blobHeld, fromHex, grainGet, grainQuote, iconHash, keyFingerprint, manifestProblem,
  nodeCall, putBundle, putIcon, registeredKeyStatus, signBundleUpload, signManifest, toHex,
} from "@saltix/grain-server";
import { makeBundle, sealed, type Bundle } from "./bundle.js";
import { ICON_FILES } from "./icon.js";
import { type DevLog, GRAIN_DIR, grainDir } from "./devlog.js";
import { ensureGitignore, terminalQr } from "./pair.js";
import { lint, publicKeyOf, readKey } from "./project.js";
import { publishCall, salt, walletLink, waitForPublished, type Signing } from "./registry.js";
import { sendSettled } from "./send.js";
import { protocolOf, sourcesFor } from "./sources.js";
import { APP_KEY_ENV, APP_KEY_FILE } from "./studio.js";

/** Where a publish stands, for `grain doctor` and the next run: nothing secret. */
export const PUBLISH_STATE_FILE = join(GRAIN_DIR, "publish.json");
/** A page with the publishing link's QR code: nothing secret. */
export const PUBLISH_PAGE_FILE = join(GRAIN_DIR, "publish.html");
/** How long a node a block behind the registry that answered may refuse a named blob before the upload gives up. */
const NAMED_GRACE_MS = 120_000;

/** The form a publish takes: a page sealed into the network, a hosted page, or a chat-only app. */
export type PublishForm = "sealed" | "hosted" | "chat";

/** What `.grain/publish.json` holds. */
export interface PublishState {
  network: string;
  /** The first 8 bytes of the genesis hash, hex. */
  genesis: string;
  slug: string;
  version: number;
  form: PublishForm;
  bundle: string | null;
  size: number | null;
  /** When the bundle went into the network, and until when it is held pending on the statement (ISO times). */
  uploaded_at: string | null;
  pending_until: string | null;
  /** When the owner was shown the publishing link. */
  link_shown_at: string | null;
  published_at: string | null;
  icon: string | null;
  icon_uploaded_at: string | null;
}

export function readPublishState(dir: string): PublishState | null {
  const path = join(dir, PUBLISH_STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PublishState;
  } catch {
    return null;
  }
}

function writePublishState(dir: string, state: PublishState): void {
  grainDir(dir);
  writeFileSync(join(dir, PUBLISH_STATE_FILE), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** What each refusal of the network means and what to do about it: every reason `blob_put` gives (32-images §7.3) and
 *  the SDK's own. */
export const BLOB_WORDS: Readonly<Record<string, { words: string; next: string }>> = {
  kind: { words: "the node takes no blob of this kind", next: "update the grain tool (saltix-grains), or pass --relay another relay" },
  not_named: {
    words: "no manifest in the registry names this blob, and no server key the registry names vouched for it",
    next: "grain pair (a paired key puts the bundle up before the owner signs), or let the owner sign first: grain publish uploads it once the registry names it",
  },
  size: { words: "empty, or larger than the network keeps (a bundle 16 MiB, an icon 64 KiB)", next: "make public/ smaller (or the icon: grain icon <picture> --out icon.png)" },
  format: { words: NAMED_REASONS.format, next: "rebuild it with grain bundle (or grain icon); report it if it persists" },
  method: { words: NAMED_REASONS.method, next: "rebuild it with grain bundle" },
  files: { words: NAMED_REASONS.files, next: "public/ holds 1 to 4 096 files" },
  name: { words: NAMED_REASONS.name, next: "rename the file: names use [A-Za-z0-9._ ~@+-] and /" },
  unpacked: { words: NAMED_REASONS.unpacked, next: "make public/ smaller" },
  hash: { words: "the bytes that arrived are not the bundle named", next: "grain publish again: the upload starts over" },
  slug: { words: "the registry holds no live app of this slug", next: "grain status, then grain pair" },
  key: { words: "the registry does not name this server key for the app", next: "grain status, then grain pair --new" },
  time: { words: "the statement is dated more than 10 minutes ahead of the node's clock, or its day is over", next: "check this computer's clock, then grain publish again" },
  signature: { words: "the statement's signature does not check", next: "grain pair --new (app.key may be damaged)" },
  offset: { words: "the node lost its place in the upload", next: "grain publish again" },
  busy: { words: "the node has as many uploads under way as it takes (4, or 64 MiB declared)", next: "grain publish again in a few minutes, or pass --relay another relay" },
  pending: { words: "the node holds as many bundles pending as it takes (2 of an app or a key, 256 MiB in all)", next: "let the owner sign the version before, or wait for its day to end" },
  full: { words: "the node's store is full", next: "pass --relay another relay, or try later" },
  store: { words: "the node keeps no blobs", next: "pass --relay another relay, or --node one with a store" },
  rate_limited: { words: "over the node's 60 uploads a minute", next: "grain publish again in a minute" },
  dimensions: { words: NAMED_REASONS.dimensions, next: "grain icon <picture> --out icon.png makes a 512 × 512 icon" },
  depth: { words: NAMED_REASONS.depth, next: "grain icon <picture> --out icon.png" },
  alpha: { words: NAMED_REASONS.alpha, next: "grain icon <picture> --out icon.png flattens it" },
  metadata: { words: NAMED_REASONS.metadata, next: "grain icon <picture> --out icon.png strips it" },
  animation: { words: NAMED_REASONS.animation, next: "grain icon <picture> --out icon.png keeps one frame" },
  check: { words: "it fails the check every node runs, here before anything was sent", next: "rebuild it (grain bundle, grain icon)" },
  stuck: { words: "the upload stopped moving", next: "grain publish again, or pass --relay another relay" },
  unreachable: { words: "no relay answered for 10 minutes", next: "check the connection, then grain publish again (or pass --relay or --node)" },
};

/** A refusal in words: the node's reason, what it means and what to do. */
export function refusalText(e: BlobRefused, what: string): string {
  const w = BLOB_WORDS[e.reason];
  const inner = e.reason === "check" && e.detail ? `: ${e.detail}, ${NAMED_REASONS[e.detail as keyof typeof NAMED_REASONS] ?? "refused"}` : "";
  return `${what} was refused: ${e.reason} (${w?.words ?? "the node's reason"}${inner}). Next: ${w?.next ?? "grain publish again"}`;
}

/** A failure the publish ends with: its step and stable reason (for the log) and the words. */
export class PublishError extends Error {
  constructor(public readonly step: string, public readonly reason: string, message: string) {
    super(message);
    this.name = "PublishError";
  }
}

/** Whether a hosted entry is `grain init`'s placeholder (origins under `.example`, RFC 2606's: never a real host): a page
 *  nobody hosts yet, which `grain publish` seals into the network. */
export const placeholderHosted = (m: Manifest): boolean =>
  "hosted" in m.entry && m.entry.hosted.origins.length > 0 && m.entry.hosted.origins.every((o) => /\.example(:\d+)?$/.test(o));

/** The form `grain publish` gives `m`: chat-only as it is; `--hosted` a hosted page as it is; any other page sealed. */
export function formOf(m: Manifest, hosted: boolean): PublishForm {
  if ("chat" in m.entry) {
    if (hosted) throw new PublishError("form", "chat_has_no_page", "a chat-only app has no page to host: grain publish (without --hosted)");
    return "chat";
  }
  if (hosted) {
    if (!("hosted" in m.entry) || placeholderHosted(m)) {
      throw new PublishError("form", "hosted_without_origin",
        `--hosted publishes a page at your own https origin: set grain.json's "entry" to {"hosted": {"url", "origins"}} first; without --hosted, grain publish puts public/ into the network`);
    }
    return "hosted";
  }
  if ("hosted" in m.entry && !placeholderHosted(m)) {
    throw new PublishError("form", "hosted_entry",
      `grain.json names a hosted page at ${m.entry.hosted.url}: grain publish --hosted publishes it as it is; to put public/ into the network instead, ` +
      `grain bundle (it makes the entry sealed), then grain publish`);
  }
  return "sealed";
}

/** The node's own time (Unix ms): the start of its current slot, from `node_status`; this computer's clock without one. */
export function nodeNow(status: { genesis_time?: unknown; slot?: unknown }, local = Date.now()): number {
  const g = status.genesis_time;
  const s = status.slot;
  return typeof g === "number" && typeof s === "number" && Number.isSafeInteger(g) && Number.isSafeInteger(s) && g > 0 ? (g + s) * 1000 : local;
}

/** The server key that vouches for a bundle: `--app-key F`, else `SALTIX_APP_KEY`, else `app.key` in the project
 *  (`grain pair`'s). Null when there is none. Never printed. */
export function vouchingKey(dir: string, file: string | undefined, env: NodeJS.ProcessEnv = process.env): { key: AppKey; from: string } | null {
  const ownerOnly = (path: string) => {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new PublishError("key", "key_file_mode", `${path}: readable by others; chmod 600 it (it holds a server key)`);
    }
  };
  if (file !== undefined) {
    ownerOnly(file);
    return { key: AppKey.parse(readFileSync(file, "utf8")), from: "file" };
  }
  if (env[APP_KEY_ENV]?.trim()) return { key: AppKey.parse(env[APP_KEY_ENV]!), from: "env" };
  const path = join(dir, APP_KEY_FILE);
  if (!existsSync(path)) return null;
  ownerOnly(path);
  return { key: AppKey.parse(readFileSync(path, "utf8")), from: "app_key" };
}

/** Why a server key cannot vouch for `slug`'s bundle on this network, or null when the registry names it. */
export function vouchProblem(key: AppKey, network: string, genesis: string, slug: string, grain: RegisteredGrain | null): string | null {
  if (!key.isFor(network, genesis)) return "other_network";
  if (key.slug !== slug) return "other_app";
  return registeredKeyStatus(grain, key.publicKey);
}

const MIB = 1024 * 1024;
const sizeText = (n: number) => (n >= MIB ? `${(n / MIB).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} bytes`);

export interface PublishOptions {
  /** The project's directory: `public/`, `.grain/`, the key files. */
  dir: string;
  manifestPath: string;
  node: NodeLike;
  /** The words that reach the same network in a command the tool suggests (` --network …`). */
  flags: string;
  log: DevLog;
  hosted: boolean;
  /** `--wallet`: the owner's Saltix signs, even with `owner.key` here. */
  wallet: boolean;
  keyPath: string;
  /** `--app-key F`: the server key that vouches for the bundle. */
  appKeyFile?: string;
  wait: boolean;
  timeoutMs: number;
  /** `signed.json`: the signed manifest, once the registry holds it. */
  out: string;
  signing: Signing;
  tty: boolean;
  print?: (line: string) => void;
  /** A line that replaces itself on a terminal (progress). */
  progress?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Tests: the clock, waits and how often the registry is read. */
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  pollMs?: number;
}

/** Progress of an upload in lines: on a terminal one line rewritten; elsewhere (an agent, a pipe) a line a quarter. */
function progressOf(o: PublishOptions, print: (line: string) => void): (received: number, size: number) => void {
  let shown = -1;
  return (received, size) => {
    const pct = size === 0 ? 100 : Math.floor((100 * received) / size);
    if (o.tty && o.progress) {
      o.progress(`  uploading ${String(pct).padStart(3)}%  ${sizeText(received)} of ${sizeText(size)}`);
      if (pct === 100) print("");
      return;
    }
    const step = Math.floor(pct / 25);
    if (step > shown) {
      shown = step;
      print(`  uploaded ${pct}% (${sizeText(received)} of ${sizeText(size)})`);
    }
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `.grain/publish.html`: the publishing link's QR code and what to do, with no script. Nothing secret. */
export async function publishPage(link: string, slug: string, version: number): Promise<string> {
  const svg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "L", margin: 2 });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Publish ${escapeHtml(slug)} ${version}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f4f6fb; color: #0b1020; }
  main { max-width: 420px; margin: 0 auto; text-align: center; }
  .qr { background: #fff; padding: 12px; border-radius: 16px; }
  .qr svg { width: 100%; height: auto; display: block; }
  p { line-height: 1.45; }
  code { word-break: break-all; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Publish ${escapeHtml(slug)}, version ${version}</h1>
  <p>Scan with the app owner's Saltix (the phone's camera), check the app and confirm with the PIN.</p>
  <div class="qr">${svg}</div>
  <p>Nothing on this page is secret.</p>
  <p><code>${escapeHtml(link)}</code></p>
</main>
</body>
</html>
`;
}

/** The whole of `grain publish`: its exit status. Throws a `PublishError` (or another error) for a failure to report. */
export async function publishApp(o: PublishOptions): Promise<number> {
  const print = o.print ?? ((line: string) => console.log(line));
  const now = o.now ?? Date.now;
  const env = o.env ?? process.env;
  const dir = o.dir;
  const { manifest: given } = readManifestFile(o.manifestPath);
  const form = formOf(given, o.hosted);
  const slug = given.slug;

  // The network: its kind, genesis and protocol version.
  const status = await nodeCall<{ network: string; genesis: string; genesis_time?: number; slot?: number; protocol?: { version?: number } }>(o.node, "node_status");
  if (!["mainnet", "testnet", "devnet"].includes(status.network)) throw new PublishError("network", "unknown_network", `the node answers for ${status.network}, a network the SDK does not know`);
  o.log.onNetwork(status.network);
  const protocol = protocolOf(status);
  o.log.step("network", "ok", `protocol_${Math.min(protocol, 99)}`);
  grainDir(dir);
  ensureGitignore(dir);

  const before = await grainGet(o.node, slug);
  if (before?.retired != null) throw new PublishError("registry", "retired", `${slug}: retired at slot ${before.retired}; a retired slug is never used again`);
  const state: PublishState = {
    network: status.network, genesis: status.genesis.slice(0, 16), slug, version: given.version, form, bundle: null, size: null,
    uploaded_at: null, pending_until: null, link_shown_at: null, published_at: null, icon: null, icon_uploaded_at: null,
    ...sameRun(readPublishState(dir), status.genesis, slug, given.version),
  };

  // 1–2. The bundle and its sources.
  let manifest = given;
  let made: Bundle | null = null;
  if (form === "sealed") {
    const publicDir = join(dir, "public");
    if (!existsSync(publicDir)) throw new PublishError("bundle", "no_public", `${publicDir}: no page to seal (a page's files go in public/)`);
    try {
      made = makeBundle(publicDir);
    } catch (e) {
      throw new PublishError("bundle", "refused", `the bundle: ${(e as Error).message}`);
    }
    o.log.step("bundle", "ok", "built");
    print(`bundle: ${made.files.length} files, ${sizeText(made.size)}, ${made.hash}`);
    const current = "sealed" in given.entry ? given.entry.sealed.sources : [];
    const { sources, from } = await sourcesFor(o.node, protocol, made.hash, made.size, current);
    if (made.size > MAX_NETWORK_BUNDLE_BYTES && from !== "own") {
      throw new PublishError("bundle", "too_large",
        `the bundle is ${sizeText(made.size)}; the network keeps one of at most 16 MiB: make public/ smaller, or host it yourself (grain bundle --sources URL) and grain publish`);
    }
    if (sources.length === 0 && protocol < 2) {
      throw new PublishError("sources", "no_relays",
        "the network runs protocol version 1, where a sealed manifest names a source, and its relay list names no relay one can name: pass --relay, or name your own (grain bundle --sources URL)");
    }
    o.log.step("sources", "ok", from);
    print(from === "network" ? `sources: none: the network keeps the bundle (protocol version ${protocol})`
      : from === "relays" ? `sources: the network's own copies at ${sources.length} relays (protocol version ${protocol} needs one; wallets ask their own relay first)`
      : `sources: your own (${sources.length}), as grain.json names them`);
    manifest = sealed(given, made, { sources });
    state.bundle = made.hash;
    state.size = made.size;
  }
  // The registry holds this version already (a run cut short after the owner signed): the same manifest but for its
  // relays' copies, which follow the relay list. Anything else at this version or below is a new version: the next one
  // (an app made in Saltix starts at 1, a project at 1 too), which grain.json says from now on.
  const same = before?.manifest && before.version === manifest.version && sameRegistered(before.manifest.manifest, manifest) ? before.manifest : null;
  if (before && before.version >= manifest.version && !same) {
    print(`version: the registry holds ${slug} v${before.version}; this one is v${before.version + 1} (grain.json says so now)`);
    o.log.step("version", "ok", "raised");
    manifest = { ...manifest, version: before.version + 1 };
    state.version = manifest.version;
    Object.assign(state, { uploaded_at: null, pending_until: null, link_shown_at: null, published_at: null, icon_uploaded_at: null });
  }
  if (same && "sealed" in same.manifest.entry && "sealed" in manifest.entry) {
    manifest = { ...manifest, entry: { sealed: { ...manifest.entry.sealed, sources: same.manifest.entry.sealed.sources } } };
  }
  if (JSON.stringify(manifest) !== JSON.stringify(given)) writeFileSync(o.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (made) writeFileSync(join(dir, "bundle.zip"), made.zip);
  // What the network takes: the manifest's bounds at its protocol version, and a transaction it fits in.
  const problem = manifestProblem({ ...manifest, ...UNOWNED }, false, protocol);
  const { errors } = lint({ ...manifest, ...UNOWNED });
  if (problem || errors.length > 0) {
    throw new PublishError("lint", problem ?? "lint", `grain.json is not ready to register: ${problem ? `${problem}: out of bounds (12-grains §2)` : errors.join("; ")} (grain lint says more)`);
  }
  state.icon = manifest.icon === NO_ICON ? null : manifest.icon;

  // A version the registry holds already: only its uploads are left.
  const published = same;
  let uploaded = false;
  if (published) {
    print(`${slug} v${manifest.version} is in the registry already: finishing its uploads`);
    o.log.step("registry", "ok", "published_before");
  } else if (made && made.size <= MAX_NETWORK_BUNDLE_BYTES) {
    // 3. Into the network before the owner signs, on a registered server key's statement.
    let vouch: ReturnType<typeof vouchingKey> = null;
    let why: string | null = "unpaired";
    try {
      vouch = vouchingKey(dir, o.appKeyFile, env);
      why = vouch === null ? "unpaired" : vouchProblem(vouch.key, status.network, status.genesis, slug, before);
    } catch (e) {
      if (!(e instanceof AppKeyError) || o.appKeyFile !== undefined) throw e;
      why = "invalid";
    }
    if (vouch && why === null) {
      const at = nodeNow(status, now());
      const statement = signBundleUpload(vouch.key.secret(), status.genesis, { slug, bundle: made.hash, size: made.size, at });
      print(`upload: into the network now, vouched for by the server key ${keyFingerprint(vouch.key.publicKey)} (${vouch.from === "app_key" ? "app.key" : vouch.from === "env" ? APP_KEY_ENV : "--app-key"})`);
      const put = await upload(o, print, made, statement);
      uploaded = true;
      state.uploaded_at = new Date(now()).toISOString();
      state.pending_until = put.pending ? new Date(at + PENDING_MS).toISOString() : null;
      writePublishState(dir, state);
      print(put.pending
        ? `the network holds the bundle, pending until ${state.pending_until}: the owner signs within that day, and this computer need not stay on`
        : "the network holds the bundle");
    } else {
      o.log.step("upload", "waiting", `after_registry_${why}`);
      print(`upload: once the registry names the bundle (${vouchWords(why)}); keep this command running until the owner has signed`);
    }
  }

  // 4–5. The owner's signature, and the registry.
  let signed: SignedManifest;
  if (published) {
    signed = published;
  } else {
    const ownerSecret = !o.wallet && existsSync(o.keyPath) ? readKey(o.keyPath) : null;
    const ownerAccount = ownerSecret ? toHex(accountId(fromHex(publicKeyOf(ownerSecret), 32))) : null;
    if (ownerSecret && before && before.owner !== ownerAccount) {
      print(`${slug} is registered to another account than ${o.keyPath}'s (an app made in Saltix is its owner's phone's): asking the owner's Saltix`);
    }
    if (ownerSecret && (before === null || before.owner === ownerAccount)) {
      const result = await signWithKey(o, print, manifest, ownerSecret);
      if (result === null) return 1;
      signed = result;
    } else {
      const result = await signInWallet(o, print, manifest, state, before === null);
      if (result === "no_wait") return 0;
      if (result === null) return 1;
      signed = result;
    }
    o.log.step("registry", "ok", "published");
    state.published_at = new Date(now()).toISOString();
    writePublishState(dir, state);
  }
  writeFileSync(o.out, JSON.stringify(signed, null, 2) + "\n");

  // The bundle, now that the registry names it, when it did not go up before (or the network lost it).
  let failed = false;
  if (made && made.size <= MAX_NETWORK_BUNDLE_BYTES && !uploaded) {
    try {
      const held = await blobHeld(o.node, "grain_bundle", made.hash).catch(() => "absent" as const);
      if (held === "held") {
        o.log.step("upload", "ok", "held");
        print("the network holds the bundle");
      } else {
        print("upload: the registry names the bundle; putting it into the network");
        await upload(o, print, made, null);
        state.uploaded_at = new Date(now()).toISOString();
        state.pending_until = null;
        writePublishState(dir, state);
        print("the network holds the bundle");
      }
    } catch (e) {
      if (!(e instanceof PublishError)) throw e;
      print(e.message);
      failed = true;
    }
  }

  // 6. The icon.
  if (!(await iconStep(o, print, manifest, state))) failed = true;
  writePublishState(dir, state);
  if (failed) {
    print(`${slug} v${manifest.version} is in the registry, but not everything went up: grain publish${o.flags} again finishes it`);
    return 1;
  }
  o.log.step("published", "ok", form);
  print(`${slug} v${manifest.version} is published${form === "sealed" ? ", its bundle in the network" : ""}; ${o.out} written. Saltix opens it from the Apps section (or salt:grain/${slug}).`);
  return 0;
}

/** What `readManifest` reads, without its signature: `grain publish` signs anew. */
function readManifestFile(path: string): { manifest: Manifest } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PublishError("manifest", "unreadable", `${path}: ${(e as Error).message}`);
  }
  const o = value as { manifest?: Manifest; signature?: string };
  return { manifest: o && typeof o === "object" && o.manifest && o.signature ? o.manifest : (value as Manifest) };
}

/** What an earlier run of the same version on the same network left (its uploads and the link), or nothing. */
function sameRun(state: PublishState | null, genesis: string, slug: string, version: number): Partial<PublishState> {
  if (!state || state.genesis !== genesis.slice(0, 16) || state.slug !== slug || state.version !== version) return {};
  const { uploaded_at, pending_until, link_shown_at, published_at, icon_uploaded_at } = state;
  return { uploaded_at, pending_until, link_shown_at, published_at, icon_uploaded_at };
}

/** Whether the registry's manifest is ours but for the owner (and a sealed one's relays' copies, which change with the
 *  relay list). */
function sameRegistered(registered: Manifest, ours: Manifest): boolean {
  const plain = (m: Manifest): Manifest => ({ ...m, ...UNOWNED, ...("sealed" in m.entry ? { entry: { sealed: { ...m.entry.sealed, sources: [] } } } : {}) });
  return JSON.stringify(plain(registered)) === JSON.stringify(plain(ours));
}

const VOUCH_WORDS: Record<string, string> = {
  unpaired: "no server key here: grain pair lets the bundle go up before the owner signs",
  other_network: "app.key is for another network",
  other_app: "app.key is another app's",
  unregistered: "the app is not registered yet, so no server key can vouch for its first version",
  retired: "the app is retired",
  revoked: "the registry names no server key for the app",
  replaced: "the registry no longer names this computer's key: grain pair --new",
  invalid: "app.key is not a developer key: grain pair --new",
};
const vouchWords = (why: string | null) => VOUCH_WORDS[why ?? ""] ?? why ?? "";

/** The bundle into the network, with progress; a refusal becomes a `PublishError` in words. */
async function upload(o: PublishOptions, print: (line: string) => void, made: Bundle, statement: ReturnType<typeof signBundleUpload> | null) {
  try {
    const put = await putBundle(o.node, made.zip, {
      upload: statement, onProgress: progressOf(o, print), pause: o.pause, now: o.now,
      namedGraceMs: statement ? 0 : NAMED_GRACE_MS,
      log: (_level, event, meta) => {
        if (event === "blob_resume") o.log.step("upload", "waiting", "offset");
        if (event === "blob_wait") o.log.step("upload", "waiting", String(meta?.reason ?? "wait"));
      },
    });
    o.log.step("upload", "ok", put.pending ? "pending" : "named");
    return put;
  } catch (e) {
    if (!(e instanceof BlobRefused)) throw e;
    o.log.step("upload", "refused", e.reason);
    throw new PublishError("upload", e.reason, refusalText(e, "the bundle"));
  }
}

/** The owner's key file signs and sends the call, and the command waits until it landed. Null when it did not in time. */
async function signWithKey(o: PublishOptions, print: (line: string) => void, manifest: Manifest, secret: Uint8Array): Promise<SignedManifest | null> {
  const owned: Manifest = { ...manifest, owner: toHex(accountId(fromHex(publicKeyOf(secret), 32))), owner_key: { ed25519: publicKeyOf(secret) } };
  const signed = signManifest(owned, secret);
  o.log.step("sign", "ok", "key_file");
  let landed: boolean | null;
  try {
    ({ landed } = await sendSettled(() => publishCall(signed, o.signing.node, secret), secret, o.signing, {
      wait: true,
      onSent: (sent) => {
        const deposit = sent.amount > 0n ? `, deposit ${salt(sent.amount)} SALT` : "";
        print(`${sent.call} ${manifest.slug} v${manifest.version}: transaction ${sent.id} (fee ${sent.fee}${deposit}); waiting for it to land…`);
      },
    }));
  } catch (e) {
    if (/base units of SALT; this needs/.test((e as Error).message)) {
      throw new PublishError("sign", "no_salt", `${(e as Error).message}: grain faucet --wait${o.flags} gives the key file's account test SALT, or --wallet asks the owner's Saltix`);
    }
    throw e;
  }
  if (landed === false) {
    o.log.step("registry", "timeout", "not_landed");
    print(`not in the registry yet: grain publish${o.flags} again finishes once it is (grain show --slug ${manifest.slug}${o.flags} says when)`);
    return null;
  }
  return signed;
}

/** The owner's Saltix signs from a QR code; the command waits for the registry (unless `--no-wait`). */
async function signInWallet(o: PublishOptions, print: (line: string) => void, manifest: Manifest, state: PublishState, fresh: boolean): Promise<SignedManifest | null | "no_wait"> {
  const link = await walletLink(manifest, o.node);
  if (fresh) {
    const { deposit } = await grainQuote(o.node, manifest.slug);
    print(`Registering ${manifest.slug} keeps a deposit of ${salt(deposit)} SALT until it retires (the slug's length sets it).`);
  }
  writeFileSync(join(o.dir, PUBLISH_PAGE_FILE), await publishPage(link, manifest.slug, manifest.version));
  print(await terminalQr(link, o.tty));
  print(`Publish ${manifest.slug} v${manifest.version}: scan the QR code with the app owner's Saltix (the phone's camera), check the app and confirm with the PIN.`);
  print(`  page  ${join(o.dir, PUBLISH_PAGE_FILE)} (the QR code for a browser)`);
  print(`  link  ${link}`);
  state.link_shown_at = new Date((o.now ?? Date.now)()).toISOString();
  writePublishState(o.dir, state);
  o.log.step("link", "waiting", "shown");
  if (!o.wait) {
    print(`Once the owner confirmed, grain publish${o.flags} again finishes it${state.pending_until ? "" : " (it puts the bundle into the network then)"}.`);
    o.log.step("registry", "waiting", "no_wait");
    return "no_wait";
  }
  print("Waiting for the owner's Saltix and the registry… (Ctrl-C stops; grain publish again goes on from here)");
  const signed = await waitForPublished(o.node, manifest, o.timeoutMs, o.pollMs);
  if (signed === null) {
    o.log.step("registry", "timeout", "not_signed");
    print(`not in the registry yet: once the owner confirms in Saltix, grain publish${o.flags} again finishes it${state.pending_until ? ` (the bundle stays pending until ${state.pending_until})` : ""}`);
    return null;
  }
  return signed;
}

/** The icon the manifest names into the network, unless it holds it. False when it did not go up. */
async function iconStep(o: PublishOptions, print: (line: string) => void, manifest: Manifest, state: PublishState): Promise<boolean> {
  if (manifest.icon === NO_ICON) {
    o.log.step("icon", "ok", "none");
    print("icon: none (wallets draw the app's monogram); grain icon <picture> --out icon.png makes one");
    return true;
  }
  const file = ICON_FILES.map((name) => join(o.dir, name)).find((path) => existsSync(path) && iconHash(new Uint8Array(readFileSync(path))) === manifest.icon);
  let held: "held" | "fetching" | "absent" = "absent";
  try {
    held = await blobHeld(o.node, "grain_icon", manifest.icon);
  } catch {
    // Asked again by the upload itself.
  }
  if (held === "held") {
    o.log.step("icon", "ok", "held");
    print("icon: the network holds it");
    return true;
  }
  if (!file) {
    o.log.step("icon", "refused", "file_missing");
    print(`icon: no ${ICON_FILES.join(" or ")} here is the icon grain.json names, and the network does not hold it: wallets draw the monogram until it goes up (grain icon <picture> --out icon.png, raise the version, grain publish)`);
    return false;
  }
  try {
    await putIcon(o.node, new Uint8Array(readFileSync(file)), { pause: o.pause, now: o.now, namedGraceMs: NAMED_GRACE_MS });
  } catch (e) {
    if (!(e instanceof BlobRefused)) throw e;
    o.log.step("icon", "refused", e.reason);
    print(refusalText(e, "icon"));
    return false;
  }
  state.icon_uploaded_at = new Date((o.now ?? Date.now)()).toISOString();
  o.log.step("icon", "ok", "uploaded");
  print("icon: in the network");
  return true;
}
