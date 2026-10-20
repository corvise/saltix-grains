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
//   4. sign     the owner's Saltix signs the manifest from a QR code; a key file only when `--key` names it, or when
//               the registry names its account as the app's owner already (`owner.ts`); the account that will own the
//               app is said first. A key file's `RegisterGrain` is followed at once, with the next nonce, by
//               `SetGrainAccess` private: a new app starts private, as one made in Saltix does, and since a shard's
//               registry calls reach the registry in their order the two land in the same block or one right after,
//               so the app is never public in between. Until the registry says private, `.grain/publish.json` keeps
//               `private_pending`: the next run sends the call again, and `grain doctor` says the app is public;
//   5. registry watched until it holds the version, the wait said as it goes (`wait.ts`); the bundle goes up now if
//               it did not before. A transaction an earlier run sent and did not see land is waited for, never sent
//               twice (`sent` in `.grain/publish.json`);
//   6. icon     the icon the manifest names goes up (`blob_put`), unless the network holds it.
// Run again, it goes on from where it stopped. What the registry holds already (the same content, compared in the
// manifest's canonical form) is never signed again: only its uploads are finished, and with nothing left to do the run
// says "nothing to publish" and sends nothing. A version is raised only when the content changed.
// A chat-only app, and a hosted page (`--hosted`), skip 1–3 and 5's upload.
//
// Every step goes to `.grain/log.jsonl` with a stable reason (docs/devex.md); where the publish stands goes to
// `.grain/publish.json` (nothing secret), which `grain doctor` reads. No key is ever printed or logged.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import QRCode from "qrcode";
import {
  AppKey, AppKeyError, BlobRefused, MAX_NETWORK_BUNDLE_BYTES, NAMED_REASONS, NO_ICON, PENDING_MS, UNOWNED, type GrainCall, type Manifest,
  type NodeLike, type RegisteredGrain, type SignedManifest, accountId, blobHeld, encodeManifest, fromHex, grainGet, grainQuote, iconHash,
  keyFingerprint, manifestProblem, minimumFee, nodeCall, putBundle, putIcon, registeredKeyStatus, signBundleUpload, signManifest, toHex,
} from "@saltix/grain-server";
import { makeBundle, sealed, type Bundle } from "./bundle.js";
import { TEMPLATE_NEXT, stillTemplate } from "./connect.js";
import { ICON_FILES } from "./icon.js";
import { type DevLog, GRAIN_DIR, grainDir } from "./devlog.js";
import { ensureGitignore, terminalQr } from "./pair.js";
import { type Signer, accountOf, keyFlag, ownerLine, signerFor } from "./owner.js";
import { lint, publicKeyOf, readKey } from "./project.js";
import { publishCall, salt, submit, walletLink, waitForPublished, type Sent, type Signing } from "./registry.js";
import { SETTLE_EVERY_MS, SETTLE_MS, STAGES, landed, sendSettled } from "./send.js";
import { protocolOf, sourcesFor } from "./sources.js";
import { APP_KEY_ENV, APP_KEY_FILE, privateCall, sameMembers } from "./studio.js";
import { LANDS_IN, type WaitOut, Waiting } from "./wait.js";

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
  /** When this computer saw the network take the bundle (its own upload, or a node that held it already), and until
   *  when it is held pending on the statement (ISO times). Null while nobody here saw it in the network: a relay's
   *  `fetching` alone never counts, as it says the relay looks for the bytes, not that anyone has them. */
  uploaded_at: string | null;
  pending_until: string | null;
  /** When the owner was shown the publishing link. */
  link_shown_at: string | null;
  published_at: string | null;
  icon: string | null;
  /** When this computer saw the network take the icon, as `uploaded_at` for the bundle. */
  icon_uploaded_at: string | null;
  /** Transactions a key file here sent for the app that no command has seen land yet: `grain publish`'s registration or
   *  update, which the next run waits for rather than sending it again; the call that makes a new app private; and the
   *  owner's own `grain access` and `grain profile`. `grain doctor` says where each stands until it landed. */
  sent?: SentRecord[];
  /** A key file here registered the app, and the registry has not been seen to make it private yet: the next
   *  `grain publish` sends `SetGrainAccess` private again until it does, and `grain doctor` says the app is public. */
  private_pending?: boolean;
}

/** A transaction a key file here sent for the app: what it does, its id, nonce and last slot, the version it is about,
 *  when it was sent, and what it makes the registry hold, so that its landing can be told from the registry alone.
 *  Nothing secret (the members are the registry's own, public on chain). */
export interface SentRecord {
  call: "register" | "update" | "access" | "profile";
  id: string;
  nonce: number;
  valid_until: number;
  /** The manifest version a registration or an update makes; for another call, the registry's version when it was sent. */
  version: number;
  at: string;
  /** What an access call makes the app: public or private, and its members. An older tool's record has none: it was
   *  the call that makes a new app private, with no members. */
  access?: { public: boolean; members: Array<{ account: string; roles: number }> };
  /** The Connect profile revision a profile call sets, or null for one that clears the profile. */
  revision?: number | null;
}

/** Whether a record is `grain publish`'s own registration or update (its version is what the registry holds). */
export const isPublishCall = (t: SentRecord): boolean => t.call === "register" || t.call === "update";

/** Whether the registry `g` holds what the transaction recorded as `t` makes: it landed (or something later replaced
 *  what it made, which is as final for the developer). */
export function landedIn(t: SentRecord, g: RegisteredGrain | null | undefined): boolean {
  if (!g) return false;
  if (isPublishCall(t)) return g.version >= t.version;
  if (t.call === "access") {
    const wanted = t.access ?? { public: false, members: [] };
    return g.public === wanted.public && sameMembers(g.members ?? [], wanted.members);
  }
  if (t.revision === null || t.revision === undefined) return !g.profile;
  return Math.max(g.profile?.profile.revision ?? 0, g.profile_revision ?? 0) >= t.revision;
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

/** What an earlier run left for the same app on the same network, whatever its version: the transactions it sent that
 *  no run saw land, and whether the app is still to be made private. */
export function carried(state: PublishState | null, genesis: string, slug: string): { sent: SentRecord[]; private_pending: boolean } {
  if (!state || state.genesis !== genesis.slice(0, 16) || state.slug !== slug) return { sent: [], private_pending: false };
  return { sent: Array.isArray(state.sent) ? state.sent : [], private_pending: state.private_pending === true };
}

/** After the owner's own `grain access` in this project: whether the app is public or private is theirs now, so a
 *  registration's pending "make it private" is dropped, and so is any earlier access call's record; the call they just
 *  sent (`sent`, when it has not landed yet) is the one `grain doctor` follows. */
export function accessDecided(dir: string, slug: string, sent?: SentRecord): void {
  const state = readPublishState(dir);
  if (!state || state.slug !== slug) return;
  if (!state.private_pending && !(state.sent ?? []).some((t) => t.call === "access") && sent === undefined) return;
  writePublishState(dir, { ...state, private_pending: false, sent: [...(state.sent ?? []).filter((t) => t.call !== "access"), ...(sent ? [sent] : [])] });
}

/** Where a transaction is recorded: the app's slug, and the network that took it. */
export interface SentWhere {
  network: string;
  /** The genesis hash, hex (its first 8 bytes are kept). */
  genesis: string;
  slug: string;
}

/**
 * Keep `record`, a transaction the owner's key file here sent for the project's app (`grain access`, `grain profile`),
 * until a command sees it land: it replaces an earlier record of the same call, whose outcome it decides now. A project
 * whose publishing state is of another app or network (or none) gets one that holds only this.
 */
export function recordSent(dir: string, where: SentWhere, record: SentRecord): void {
  const genesis = where.genesis.slice(0, 16);
  const before = readPublishState(dir);
  const state: PublishState = before && before.genesis === genesis && before.slug === where.slug ? before : {
    network: where.network, genesis, slug: where.slug, version: 0, form: "sealed", bundle: null, size: null, uploaded_at: null,
    pending_until: null, link_shown_at: null, published_at: null, icon: null, icon_uploaded_at: null, sent: [], private_pending: false,
  };
  const others = (state.sent ?? []).filter((t) => t.call !== record.call || isPublishCall(t));
  writePublishState(dir, { ...state, sent: [...others, record] });
}

/** A recorded transaction seen landing: forgotten. */
export function forgetSent(dir: string, id: string): void {
  const state = readPublishState(dir);
  if (!state || !(state.sent ?? []).some((t) => t.id === id)) return;
  writePublishState(dir, { ...state, sent: (state.sent ?? []).filter((t) => t.id !== id) });
}

/** The version `grain publish` sends when the registry holds `held` and grain.json says `ours`: grain.json's, unless the
 *  registry holds it or one above already. */
export const nextVersion = (held: number, ours: number): number => (held >= ours ? held + 1 : ours);

/** A page changed since the version the registry holds, in the words `grain lint` and `grain doctor` both use. */
export const publicChanged = (held: number, next: number): string => `public/ changed since v${held}: grain publish seals v${next}`;

/**
 * What `grain lint` says of a manifest it finds no error in: where the last `grain publish` here left it (`state`: not
 * published yet, published as it is here, or changed since the version the registry took), and what is left, in the
 * words `grain doctor` uses: `public/` or grain.json changed since (`grain publish seals v2`), `connect.json` still
 * `grain init`'s words, a first publish. Never "ready" while something is left. The registry itself is `grain doctor`'s
 * to ask: a lint reads nothing from the network.
 */
export function readiness(m: Manifest, state: PublishState | null, dir: string): string {
  const took = state && state.slug === m.slug && state.published_at ? state : null;
  const left: string[] = [];
  let where: string;
  const bundle = "sealed" in m.entry ? m.entry.sealed.bundle : null;
  if (took === null) {
    where = "not published yet";
    left.push("grain publish (grain doctor says what registering the slug takes)");
  } else {
    const on = `${took.network} ${took.genesis}`;
    let built: string | null = bundle;
    if (bundle !== null && existsSync(join(dir, "public"))) {
      try {
        built = makeBundle(join(dir, "public")).hash;
      } catch {
        built = null;
      }
    }
    if (took.version === m.version && (bundle === null || (took.bundle === bundle && built === bundle))) {
      where = `published on ${on} as it is here (the registry took it at ${took.published_at}; grain doctor asks the registry now)`;
    } else {
      where = `the registry took v${took.version} on ${on} at the last grain publish`;
      const next = nextVersion(took.version, m.version);
      left.push(bundle !== null && built !== took.bundle ? publicChanged(took.version, next) : `grain.json changed since v${took.version}: grain publish sends v${next}`);
    }
  }
  if (stillTemplate(dir)) left.push(TEMPLATE_NEXT);
  const head = `${m.slug} v${m.version}: no errors; ${where}`;
  if (left.length > 0) return `${head}; left: ${left.join("; ")}`;
  return `${head}. A change to ${bundle !== null ? "public/ or " : ""}grain.json: grain publish makes v${m.version + 1}`;
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
  /** `--wallet`: the owner's Saltix signs, even for an app a key file here owns. */
  wallet: boolean;
  /** The owner's key file: `--key F`, or `owner.key` beside the manifest. */
  keyPath: string;
  /** Whether `--key` named it: only then does a key file register an app (`owner.ts`). */
  keyNamed: boolean;
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
  /** Tests: the clock, waits, how often the registry is read, and how long a transaction is waited for. */
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  pollMs?: number;
  settleMs?: number;
}

/** Where a wait is said: the command's own lines, rewritten in place on a terminal. */
const waitOut = (o: PublishOptions, print: (line: string) => void): WaitOut => ({ tty: o.tty, print, progress: o.progress, now: o.now });

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

/**
 * A sealed page's manifest as `grain publish` sends it to a network of `protocol`: `given` with the bundle `public/`
 * makes, and the sources that protocol asks for (`sourcesFor`: none from version 2; before it the network's own copy at
 * up to 3 relays; the developer's own hosts as grain.json names them). `grain doctor` estimates a first publish's fees
 * from the same manifest, sources and all.
 */
export async function sealedAsSent(node: NodeLike, protocol: number, given: Manifest, made: Bundle): Promise<{ manifest: Manifest; sources: string[]; from: "own" | "relays" | "network" }> {
  const current = "sealed" in given.entry ? given.entry.sealed.sources : [];
  const { sources, from } = await sourcesFor(node, protocol, made.hash, made.size, current);
  return { manifest: sealed(given, made, { sources }), sources, from };
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

  let before = await grainGet(o.node, slug);
  if (before?.retired != null) throw new PublishError("registry", "retired", `${slug}: retired at slot ${before.retired}; a retired slug is never used again`);
  // A registration or an update an earlier run sent and did not see land (a run cut short, or --no-wait): waited for
  // here, never sent a second time.
  const carry = carried(readPublishState(dir), status.genesis, slug);
  const earlier = await settleEarlier(o, print, slug, before, carry.sent, status.slot ?? 0);
  if (earlier === "waiting") return 1;
  before = earlier;

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
    const asSent = await sealedAsSent(o.node, protocol, given, made);
    const { sources, from } = asSent;
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
      : from === "relays" ? `sources: ${sources.length} relays' addresses for the network's own copy (protocol version ${protocol} asks a sealed manifest to name one; the network keeps the bundle either way, and wallets ask their own relay first)`
      : `sources: your own (${sources.length}), as grain.json names them`);
    manifest = asSent.manifest;
  }
  // What the registry holds already, with the same content (a run cut short after the owner signed, or nothing changed
  // since the last publish), is nothing new to sign, whatever version grain.json says: grain.json takes the registry's
  // version and its relays' copies, and only the uploads are left. Anything else at this version or below is a new
  // version, the next one (an app made in Saltix starts at 1, a project at 1 too), which grain.json says from now on.
  const same = before?.manifest && sameContent(before.manifest.manifest, manifest) ? before.manifest : null;
  if (same) {
    if (manifest.version !== same.manifest.version) {
      print(`version: nothing changed since ${slug} v${same.manifest.version} in the registry; grain.json says v${same.manifest.version} again`);
    }
    manifest = { ...manifest, version: same.manifest.version };
    if ("sealed" in same.manifest.entry && "sealed" in manifest.entry) {
      manifest = { ...manifest, entry: { sealed: { ...manifest.entry.sealed, sources: same.manifest.entry.sealed.sources } } };
    }
  } else if (before && before.version >= manifest.version) {
    print(`version: the registry holds ${slug} v${before.version}; this one is v${before.version + 1} (grain.json says so now)`);
    o.log.step("version", "ok", "raised");
    manifest = { ...manifest, version: before.version + 1 };
  }
  const state: PublishState = {
    network: status.network, genesis: status.genesis.slice(0, 16), slug, version: manifest.version, form, bundle: made?.hash ?? null,
    size: made?.size ?? null, uploaded_at: null, pending_until: null, link_shown_at: null, published_at: null, icon: null, icon_uploaded_at: null,
    ...sameRun(readPublishState(dir), status.genesis, slug, manifest.version, made?.hash ?? null),
    // The registration or update is settled above; the other calls stay recorded until the registry shows them landed.
    sent: carry.sent.filter((t) => !isPublishCall(t) && !landedIn(t, before)), private_pending: carry.private_pending,
  };
  if (JSON.stringify(manifest) !== JSON.stringify(given)) writeFileSync(o.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (made) writeFileSync(join(dir, "bundle.zip"), made.zip);
  // What the network takes: the manifest's bounds at its protocol version, and a transaction it fits in.
  const problem = manifestProblem({ ...manifest, ...UNOWNED }, false, protocol);
  const { errors } = lint({ ...manifest, ...UNOWNED });
  if (problem || errors.length > 0) {
    throw new PublishError("lint", problem ?? "lint", `grain.json is not ready to register: ${problem ? `${problem}: out of bounds (12-grains §2)` : errors.join("; ")} (grain lint says more)`);
  }
  state.icon = manifest.icon === NO_ICON ? null : manifest.icon;

  // Who signs a new version, and which account owns the app: said before anything is signed.
  const published = same;
  let signer: Signer | null = null;
  if (!published) {
    signer = signerFor({ wallet: o.wallet, keyPath: o.keyPath, named: o.keyNamed, owner: before?.owner ?? null, what: slug });
    o.log.step("signer", "ok", signer.by === "key" ? `key_${signer.why}` : `wallet_${signer.why}`);
    print(ownerLine(signer, status.network, before?.owner ?? null, o.keyPath));
  }

  // A version the registry holds already: only its uploads are left, if any.
  let uploaded = false;
  if (published) {
    print(`${slug} v${manifest.version}: the registry holds it as grain.json describes it, so there is nothing to sign`);
    o.log.step("registry", "ok", "published_before");
    // Taken by the registry, though the run that sent it returned before it landed (--no-wait, a run cut short): seen
    // now, so that grain lint knows this version from a change made after it.
    state.published_at ??= new Date(now()).toISOString();
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
      // A key file signs here and now: no owner to wait for, and nothing a paired key would change but the order. With
      // --no-wait this run returns before either, and the next one uploads.
      print(signer?.by === "key"
        ? `upload: once the registry names the bundle, after the transaction lands; ${o.wait ? "this command waits for it"
          : `--no-wait returns before that, so grain publish${o.flags} again puts it up once grain doctor${o.flags} says the transaction landed`}`
        : `upload: once the registry names the bundle (${vouchWords(why)}); ${o.wait ? "keep this command running until the owner has signed"
          : `--no-wait returns before that, so grain publish${o.flags} again puts it up once the owner has signed`}`);
    }
  }

  // 4–5. The owner's signature, and the registry. `fresh`: the transactions this run sent, waited for as they are.
  let signed: SignedManifest;
  let failed = false;
  const fresh = new Set<string>();
  if (published) {
    signed = published;
  } else if (signer!.by === "key") {
    const result = await signWithKey(o, print, manifest, signer!.secret, state, before === null, fresh);
    if (result === "no_wait") return 0;
    if (result === null) return 1;
    signed = result.signed;
    o.log.step("registry", "ok", "published");
    state.published_at = new Date(now()).toISOString();
    writePublishState(dir, state);
  } else {
    const result = await signInWallet(o, print, manifest, state, before === null);
    if (result === "no_wait") return 0;
    if (result === null) return 1;
    signed = result;
    o.log.step("registry", "ok", "published");
    state.published_at = new Date(now()).toISOString();
    writePublishState(dir, state);
    if (before === null) {
      // The publishing link registers a free slug (12-grains §10); whether the app is then public is the owner's choice on
      // Saltix's sheet: Saltix 0.1.61 and later make it private (one more transaction, sent by Saltix once the
      // registration landed) unless the owner switched on Public in the Marketplace; older ones leave it public.
      o.log.step("access", "ok", "wallet");
      print(walletAccessWords(slug, o.flags));
    }
  }
  writeFileSync(o.out, JSON.stringify(signed, null, 2) + "\n");

  // A new app a key file registered starts private (24-app-studio §2a, §4), as one made in Saltix does: the call went
  // right behind the registration, and until the registry says private it is sent again, by this run or the next.
  let madePrivate = false;
  if (state.private_pending) {
    const secret = signer?.by === "key" ? signer.secret : ownerKeyFile(o, print, slug, before?.owner ?? null);
    const outcome = secret === null ? false : await ensurePrivate(o, print, slug, secret, state, fresh);
    if (outcome === false) failed = true;
    madePrivate = outcome === "sent";
  }

  // The bundle, now that the registry names it, when it did not go up before (or the network lost it).
  let sentNow = uploaded || madePrivate;
  if (made && made.size <= MAX_NETWORK_BUNDLE_BYTES && !uploaded) {
    try {
      const held = await blobHeld(o.node, "grain_bundle", made.hash).catch(() => "absent" as const);
      if (held === "held") {
        o.log.step("upload", "ok", "held");
        print("the network holds the bundle");
        // Seen in the network from here: grain doctor counts it, even when the relay it asks is still fetching a copy.
        if (state.uploaded_at === null) {
          state.uploaded_at = new Date(now()).toISOString();
          writePublishState(dir, state);
        }
      } else {
        print("upload: the registry names the bundle; putting it into the network");
        await upload(o, print, made, null);
        sentNow = true;
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
  const icon = await iconStep(o, print, manifest, state);
  if (icon === "failed") failed = true;
  if (icon === "uploaded") sentNow = true;
  writePublishState(dir, state);
  if (failed) {
    print(`${slug} v${manifest.version} is in the registry, but not everything is done: grain publish${o.flags} again finishes it`);
    return 1;
  }
  if (published && !sentNow) {
    // Nothing was signed, sent or uploaded: say so, and what makes the next version.
    o.log.step("published", "ok", "unchanged");
    print(`nothing to publish: the registry holds ${slug} v${manifest.version} as grain.json describes it` +
      `${form === "sealed" ? ", and the network holds its bundle" : ""}${manifest.icon === NO_ICON ? "" : " and its icon"}. ` +
      `A change to ${form === "sealed" ? "public/ or " : ""}grain.json publishes v${manifest.version + 1}.`);
    return 0;
  }
  o.log.step("published", "ok", form);
  print(`${slug} v${manifest.version} is published${form === "sealed" ? ", its bundle in the network" : ""}; ${o.out} written.`);
  const after = await grainGet(o.node, slug).catch(() => null);
  // A first version the owner's Saltix registered: public for now may be private a block or two later (its own call),
  // so the line above says how it goes rather than "anyone opens it".
  if (!(before === null && signer?.by === "wallet" && after?.public !== false)) print(whoOpens(slug, after, o.keyPath, o.flags, form, o.dir));
  return 0;
}

/** What a first version registered from a publishing link becomes, in words: private unless the owner switched on
 *  Public in the Marketplace on Saltix's sheet; an older Saltix's, public, and the command that makes it private. */
export const walletAccessWords = (slug: string, flags = ""): string =>
  `${slug}: Saltix registers it private unless you switched on Public in the Marketplace on the sheet (Saltix 0.1.61 and later, ` +
  `which sends that call itself once the registration landed, a minute or two later: grain doctor${flags} says which it is). An older ` +
  `Saltix registers it public: then grain access --slug ${slug} --private${flags} (or My apps → ${slug} → Access → Private)`;

/**
 * Who can open the app now, and how to try it: anyone, from Saltix's Apps section, when it is public; its owner and
 * members in Saltix when it is private; and a private app whose owner is a key file here, which no phone holds, is
 * nobody's to open until a member is named: then the way to name one (the tester's own Saltix address), and the
 * simulator, which runs the page sealed as Saltix will.
 */
export function whoOpens(slug: string, g: RegisteredGrain | null, keyPath: string, flags: string, form: PublishForm, dir: string): string {
  const simulator = form === "sealed" ? " Without a phone, grain dev runs this page sealed in the simulator, as Saltix will (grain dev --check tries it headless)." : "";
  if (!g || g.public !== false) return `Anyone opens it in Saltix: the Apps section, or salt:grain/${slug}.${simulator}`;
  return `It is ${whoOpensNow(slug, g, keyPath, flags, dir)}.${simulator}`;
}

/**
 * Who opens the app in Saltix as the registry `g` holds it, and how to change that, in the same words `grain publish`
 * ends with and `grain doctor` says: public, anyone; private with a phone's owner, its owner and members; private with
 * this computer's key file as its owner, which no phone holds, nobody until a member is named, and the command that
 * names one.
 */
export function whoOpensNow(slug: string, g: RegisteredGrain, keyPath: string, flags: string, dir: string): string {
  const open = `salt:grain/${slug}`;
  if (g.public !== false) return `public: anyone opens it in Saltix (the Apps section, or ${open})`;
  let keyAccount: string | null = null;
  try {
    keyAccount = existsSync(keyPath) ? accountOf(readKey(keyPath)) : null;
  } catch {
    keyAccount = null;
  }
  const file = basename(keyPath);
  const members = g.members?.length ?? 0;
  if (keyAccount !== null && keyAccount === g.owner) {
    return `private, and its owner is ${file}'s account, which no phone holds: ${members === 0 ? "nobody opens it in Saltix yet" : `its ${members} member${members === 1 ? "" : "s"} open it in Saltix (${open})`}. ` +
      `To open it in your own Saltix: grain access --slug ${slug} --private --member <your Saltix address>:user${keyFlag(keyPath, dir)}${flags} ` +
      `(the address: Saltix → Receive), or --public for anyone`;
  }
  const who = members > 0 ? `its owner and its ${members} member${members === 1 ? "" : "s"} open it` : "its owner alone opens it";
  return `private: ${who} in Saltix (My apps → ${slug}, or ${open}); My apps → ${slug} → Access adds members or makes it public`;
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

/** What an earlier run of the same version and bundle on the same network left (its uploads and the link), or
 *  nothing. */
function sameRun(state: PublishState | null, genesis: string, slug: string, version: number, bundle: string | null): Partial<PublishState> {
  if (!state || state.genesis !== genesis.slice(0, 16) || state.slug !== slug || state.version !== version || state.bundle !== bundle) return {};
  const { uploaded_at, pending_until, link_shown_at, published_at, icon_uploaded_at } = state;
  return { uploaded_at, pending_until, link_shown_at, published_at, icon_uploaded_at };
}

/**
 * Whether the registry's manifest says what ours says: the same content but for the owner (a wallet fills in its own),
 * the version (grain.json's may lag behind the registry's) and a sealed one's relays' copies (they follow the relay
 * list). Compared in the manifest's canonical form (its Borsh bytes, 12-grains §2), never as JSON text: a node answers
 * with its objects' keys sorted, so the same manifest reads as other JSON than grain.json's.
 */
export function sameContent(registered: Manifest, ours: Manifest): boolean {
  const plain = (m: Manifest): Manifest => ({
    ...m, ...UNOWNED, version: 1, ...("sealed" in m.entry ? { entry: { sealed: { ...m.entry.sealed, sources: [] } } } : {}),
  });
  try {
    return toHex(encodeManifest(plain(registered))) === toHex(encodeManifest(plain(ours)));
  } catch {
    // A manifest that does not encode is not one the registry holds.
    return false;
  }
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

/** A transaction sent here, as `.grain/publish.json` keeps it. */
export const recordOf = (sent: Sent, version: number, at: number, makes: Pick<SentRecord, "access" | "revision"> = {}): SentRecord => ({
  call: sent.call === "register" ? "register" : sent.call === "access" ? "access" : sent.call === "profile" ? "profile" : "update", id: sent.id,
  nonce: sent.nonce, valid_until: sent.validUntil, version, at: new Date(at).toISOString(), ...makes,
});

/** What the call that makes a new app private makes it: private, with no members. */
const PRIVATE: Pick<SentRecord, "access"> = { access: { public: false, members: [] } };

/** Where a transaction stands at the node: `pending`, `included`, `unknown`, or null when the node cannot say. */
export async function txStatus(node: NodeLike, id: string): Promise<string | null> {
  try {
    const status = (await nodeCall<{ status?: unknown } | undefined>(node, "transaction_get", { id }))?.status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

/** How long a transaction recorded here stays worth waiting for once it left the pool without the registry showing what
 *  it makes: a block, then the beacon chain, take about 2 minutes; past 10 it is gone, or the registry refused it. */
export const STALE_MS = 600_000;

/**
 * A registration or update an earlier run sent (`sent`) and did not see land: when the registry holds its version, it
 * landed; when it can still land (in the pool, or sent within its last slot), it is waited for here — never sent again,
 * which would take the same nonce and be refused, or register twice — and the registry's record after it is returned;
 * when it is gone (its last slot past and unknown to the node), it is forgotten and this run sends anew. "waiting" when it
 * had not landed by the end of the wait.
 */
async function settleEarlier(o: PublishOptions, print: (line: string) => void, slug: string, before: RegisteredGrain | null,
  sent: SentRecord[], slot: number): Promise<RegisteredGrain | null | "waiting"> {
  const tx = sent.find(isPublishCall);
  if (!tx || (before !== null && before.version >= tx.version)) return before;
  const at = await txStatus(o.node, tx.id);
  if (at !== "pending" && at !== "included" && slot > tx.valid_until) return before;
  print(`${tx.call} ${slug} v${tx.version}: an earlier grain publish sent it at ${tx.at} (transaction ${tx.id}), and the registry does not hold it yet: ` +
    `waiting for it rather than sending it again (${LANDS_IN})`);
  o.log.step("registry", "waiting", "earlier");
  const limit = o.settleMs ?? SETTLE_MS;
  const w = new Waiting(waitOut(o, print), `${tx.call} ${slug} v${tx.version}`, limit);
  const end = Date.now() + limit;
  for (;;) {
    const g = await grainGet(o.node, slug);
    if (g !== null && g.version >= tx.version) {
      w.done();
      return g;
    }
    if (Date.now() >= end) break;
    w.at((await txStatus(o.node, tx.id)) === "included" ? STAGES.block : STAGES.pool);
    await sleep(o.pollMs ?? SETTLE_EVERY_MS);
  }
  w.done();
  o.log.step("registry", "timeout", "not_landed");
  print(`not in the registry yet: grain doctor${o.flags} says when it is; then grain publish${o.flags} again finishes (the bundle and the icon)`);
  return "waiting";
}

const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));

/**
 * The owner's key file signs the version and sends it; a registration is followed at once by the call that makes the
 * app private, with the next nonce, so that the chain applies the two in order: in the same block, or the access call
 * one right after. Both go to `.grain/publish.json` before the wait, so that a run cut short is resumed, never sent again.
 * With `wait`, the command then waits until the registry holds the version, saying where it stands as it goes: the
 * signed manifest and whether it registered the app; null when it did not land in time; "no_wait" without the wait.
 */
async function signWithKey(o: PublishOptions, print: (line: string) => void, manifest: Manifest, secret: Uint8Array, state: PublishState,
  registering: boolean, fresh: Set<string>): Promise<{ signed: SignedManifest; registered: boolean } | null | "no_wait"> {
  const owned: Manifest = { ...manifest, owner: toHex(accountId(fromHex(publicKeyOf(secret), 32))), owner_key: { ed25519: publicKeyOf(secret) } };
  const signed = signManifest(owned, secret);
  o.log.step("sign", "ok", "key_file");
  const now = o.now ?? Date.now;
  const every = o.pollMs ?? SETTLE_EVERY_MS;
  const end = Date.now() + (o.settleMs ?? SETTLE_MS);
  const privacy = privateCall(manifest.slug);
  let call: GrainCall | null = null;
  let sent: Sent;
  try {
    ({ sent } = await sendSettled(async () => (call = await publishCall(signed, o.signing.node, secret)), secret, o.signing, {
      wait: false, every, ms: end - Date.now(),
      // The access call's fee, which goes right behind a registration, is in the account too.
      reserve: registering ? (o.signing.fee ?? minimumFee(privacy)) : 0n,
      onSent: (s) => {
        const deposit = s.amount > 0n ? `, deposit ${salt(s.amount)} SALT` : "";
        print(`${s.call} ${manifest.slug} v${manifest.version}: transaction ${s.id} (fee ${salt(s.fee)} SALT${deposit})`);
      },
    }));
  } catch (e) {
    if (/base units of SALT; this needs/.test((e as Error).message)) {
      throw new PublishError("sign", "no_salt", `${(e as Error).message}: grain faucet --wait${keyFlag(o.keyPath, o.dir)}${o.flags} gives the key file's account test SALT; or, without --key, the owner's Saltix signs and pays (a QR code)`);
    }
    throw e;
  }
  const registered = sent.call === "register";
  state.sent = [...(state.sent ?? []).filter((t) => !isPublishCall(t)), recordOf(sent, manifest.version, now())];
  if (registered) {
    state.private_pending = true;
    const access = await sendPrivateBehind(o, print, privacy, secret, sent);
    if (access) {
      state.sent = [...state.sent.filter((t) => t.call !== "access"), recordOf(access, manifest.version, now(), PRIVATE)];
      fresh.add(access.id);
    }
  }
  writePublishState(o.dir, state);
  if (!o.wait) {
    o.log.step("registry", "waiting", "no_wait");
    print(`sent: it lands in the registry in a few minutes (${LANDS_IN}). grain doctor${o.flags} says when; then grain publish${o.flags} ` +
      "again finishes it (the bundle and the icon go up once the registry names them), and waits for this transaction rather than sending it again");
    return "no_wait";
  }
  print(`waiting for it to land: ${LANDS_IN}; Ctrl-C stops waiting, and grain publish${o.flags} again goes on from here`);
  const w = new Waiting(waitOut(o, print), `${sent.call} ${manifest.slug} v${manifest.version}`, Math.max(0, end - Date.now()));
  const ok = await landed(o.signing.node, call!, sent.id, end, every, (stage) => w.at(stage));
  w.done();
  if (ok === false) {
    o.log.step("registry", "timeout", "not_landed");
    print(`not in the registry yet after ${Math.round((o.settleMs ?? SETTLE_MS) / 60_000)} minutes: grain doctor${o.flags} says when it is; ` +
      `then grain publish${o.flags} again finishes it, waiting for this transaction rather than sending it again`);
    return null;
  }
  state.sent = state.sent.filter((t) => t.id !== sent.id);
  writePublishState(o.dir, state);
  return { signed, registered };
}

/** `SetGrainAccess` private sent right behind `first` (a registration still in the pool), with the next nonce: the pool
 *  takes a transaction ahead of the account's nonce, and the chain applies an account's calls in order. Null when the pool
 *  would not take it: then it goes once the registration landed (`ensurePrivate`). */
async function sendPrivateBehind(o: PublishOptions, print: (line: string) => void, call: GrainCall, secret: Uint8Array, first: Sent): Promise<Sent | null> {
  const slug = "access" in call ? call.access.slug : "";
  try {
    const sent = await submit(call, secret, o.signing, { nonce: first.nonce + 1 });
    o.log.step("access", "waiting", "sent");
    print(`access ${slug}: private, sent right behind it with the next nonce (transaction ${sent.id}, fee ${salt(sent.fee)} SALT): ` +
      "the chain applies an account's calls in order, so the app is private from the block that registers it, or the one after");
    return sent;
  } catch (e) {
    o.log.step("access", "waiting", "after_registry");
    print(`access ${slug}: private once the registration landed (the pool did not take it ahead of it: ${(e as Error).message})`);
    return null;
  }
}

/**
 * Until the registry says the app is private: the access call this run sent (`fresh`) is waited for; one an earlier run
 * sent only while it can still land (in the pool, or in a block within the last 10 minutes, which the registry applies a
 * block or two later), else it is sent again — twice is harmless, both make the app private. A send that fails is tried
 * again until the wait ends. "already" when no call of this run's own making was needed, "sent" when this run sent one,
 * false when the app is still public at the end (`private_pending` stays: the next `grain publish` goes on, and
 * `grain doctor` says so).
 */
async function ensurePrivate(o: PublishOptions, print: (line: string) => void, slug: string, secret: Uint8Array, state: PublishState,
  fresh: Set<string>): Promise<"already" | "sent" | false> {
  const node = o.signing.node;
  const now = o.now ?? Date.now;
  const every = o.pollMs ?? SETTLE_EVERY_MS;
  const end = Date.now() + (o.settleMs ?? SETTLE_MS);
  const next = `grain access --slug ${slug} --private${keyFlag(o.keyPath, o.dir)}${o.flags}`;
  const w = new Waiting(waitOut(o, print), `access ${slug}: private`, o.settleMs ?? SETTLE_MS);
  const done = (outcome: "already" | "sent") => {
    w.done();
    state.private_pending = false;
    state.sent = (state.sent ?? []).filter((t) => t.call !== "access");
    writePublishState(o.dir, state);
    o.log.step("access", "ok", "private");
    // Who opens it (with a key file's owner, nobody until a member is named) is said once, at the end.
    print(`${slug} is private, as an app made in Saltix starts`);
    return outcome;
  };
  let tx: SentRecord | null = (state.sent ?? []).find((t) => t.call === "access") ?? null;
  if (tx !== null && !fresh.has(tx.id)) {
    const at = await txStatus(node, tx.id);
    if (!(at === "pending" || (at === "included" && now() - Date.parse(tx.at) < STALE_MS))) tx = null;
  }
  let sentHere = false;
  for (;;) {
    const g = await grainGet(node, slug);
    if (g?.public === false) return done(sentHere ? "sent" : "already");
    if (g === null || g.retired !== null) break;
    if (Date.now() >= end) break;
    if (tx === null) {
      try {
        const { sent } = await sendSettled(async () => privateCall(slug), secret, o.signing, { wait: false, every, ms: end - Date.now() });
        tx = recordOf(sent, g.version, now(), PRIVATE);
        sentHere = true;
        state.sent = [...(state.sent ?? []).filter((t) => t.call !== "access"), tx];
        writePublishState(o.dir, state);
        o.log.step("access", "waiting", "sent");
        print(`access ${slug}: private (transaction ${sent.id}, fee ${salt(sent.fee)} SALT)`);
      } catch (e) {
        // Not sent (the network, the pool): tried again until the wait ends.
        w.at(`not sent (${(e as Error).message}): trying again`);
        await sleep(every);
        continue;
      }
    }
    const ok = await landed(node, privateCall(slug), tx.id, end, every, (stage) => w.at(stage));
    if (ok === false) break;
    if (ok === null) {
      // The node cannot say where the transaction is: the registry's word alone, until the wait ends.
      w.at(STAGES.block);
      await sleep(every);
    }
  }
  w.done();
  o.log.step("access", "timeout", "not_landed");
  print(`${slug} is registered but still public: the call that makes it private has not landed yet. grain doctor${o.flags} says when it has; ` +
    `grain publish${o.flags} again sends it again if it is needed (or: ${next})`);
  return false;
}

/** The secret of the key file here when its account owns the app (the one that registered it); null, said, otherwise. */
function ownerKeyFile(o: PublishOptions, print: (line: string) => void, slug: string, owner: string | null): Uint8Array | null {
  try {
    const secret = readKey(o.keyPath);
    if (owner !== null && accountOf(secret) === owner) return secret;
  } catch {
    // Said below.
  }
  print(`${slug} is to be made private, and ${basename(o.keyPath)} here is not its owner's key: the owner makes it private (grain access --slug ${slug} --private --key <its key file>)`);
  return null;
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
  print(`Waiting for the owner's Saltix and the registry: once they confirm, ${LANDS_IN} (Ctrl-C stops; grain publish again goes on from here)`);
  const w = new Waiting(waitOut(o, print), `publish ${manifest.slug} v${manifest.version}`, o.timeoutMs);
  const signed = await waitForPublished(o.node, manifest, o.timeoutMs, o.pollMs, () => w.at("waiting for the owner's Saltix, then the registry"));
  w.done();
  if (signed === null) {
    o.log.step("registry", "timeout", "not_signed");
    print(`not in the registry yet: once the owner confirms in Saltix, grain publish${o.flags} again finishes it${state.pending_until ? ` (the bundle stays pending until ${state.pending_until})` : ""}`);
    return null;
  }
  return signed;
}

/** The icon the manifest names into the network, unless it holds it: what became of it. */
async function iconStep(o: PublishOptions, print: (line: string) => void, manifest: Manifest, state: PublishState): Promise<"none" | "held" | "uploaded" | "failed"> {
  if (manifest.icon === NO_ICON) {
    o.log.step("icon", "ok", "none");
    print("icon: none (wallets draw the app's monogram); grain icon <picture> --out icon.png, or grain icon --monogram <letter>, makes one");
    return "none";
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
    state.icon_uploaded_at ??= new Date((o.now ?? Date.now)()).toISOString();
    return "held";
  }
  if (!file) {
    o.log.step("icon", "refused", "file_missing");
    print(`icon: no ${ICON_FILES.join(" or ")} here is the icon grain.json names, and the network does not hold it: wallets draw the monogram until it goes up (grain icon <picture> --out icon.png, then grain publish)`);
    return "failed";
  }
  try {
    await putIcon(o.node, new Uint8Array(readFileSync(file)), { pause: o.pause, now: o.now, namedGraceMs: NAMED_GRACE_MS });
  } catch (e) {
    if (!(e instanceof BlobRefused)) throw e;
    o.log.step("icon", "refused", e.reason);
    print(refusalText(e, "icon"));
    return "failed";
  }
  state.icon_uploaded_at = new Date((o.now ?? Date.now)()).toISOString();
  o.log.step("icon", "ok", "uploaded");
  print("icon: in the network");
  return "uploaded";
}
