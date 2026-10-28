// `grain pair`: the computer that runs an app's program pairs its own server key with the owner's Saltix by a QR code
// (Saltix 24-app-studio §3a, version 2). The key is made here and never leaves this computer: it waits in
// `.grain/pair.key` (owner-only) until the registry names it, then becomes `app.key` (owner-only, which the server
// reads) beside `app.json` (the app, its owner, the network and the key's public half: nothing secret).
//
// 1. The three fields of the command the app's page shows — the app, its owner, the network — from the command line,
//    else from the project (`app.json`, `.grain/pair.json`, `grain.json`'s slug), else, for an app the registry holds,
//    the owner from its record; the genesis is the network's own. A new app needs `--app` and `--owner`.
// 2. The registry's record of the slug, read first: another account's or retired, it refuses before it shows anything;
//    naming the key already, it finishes.
// 3. A key (the one an earlier offer made, if it was never paired) and an offer of it with the key's proof for the app
//    and the owner: a QR code in the terminal, the link, `.grain/pair.html` and the offer's code.
// 4. It watches the registry (`grain_get` through the network's public relays' wallet interface, polled with a short
//    backoff: no relay session, no mailbox, no message from the phone) until the record names the key, renewing the
//    offer when it expires with nobody having scanned it, then writes `app.key` and `app.json`.
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import QRCode from "qrcode";
import {
  APP_JSON_FILE, APP_KEY_FILE, AppKey, MAX_PAIR_NAME, type NetworkName, type NodeLike, type PairTarget, type PairingOffer, PairingError, type RegisteredGrain,
  type SlugRecord, accountId, decodeOffer, encodeAddress, encodeOffer, fromHex, grainGet, judgeSlug, keyFingerprint, makeOffer, nodeCall,
  offerCodeText, offerLink, pairTarget, refusedChar, registeredKeyStatus, slugRecordOf, targetOwner, toHex,
} from "@saltix/grain-server";
import { type DevLog, GRAIN_DIR, grainDir } from "./devlog.js";
import { Waiting, elapsed } from "./wait.js";

/** Where a key not paired yet waits, owner-only. */
export const PAIR_KEY_FILE = join(GRAIN_DIR, "pair.key");
/** The offer being shown and the fields it was made for: nothing secret. */
export const PAIR_STATE_FILE = join(GRAIN_DIR, "pair.json");
/** A page with the offer's QR code: nothing secret. */
export const PAIR_PAGE_FILE = join(GRAIN_DIR, "pair.html");
export { APP_JSON_FILE };
/** What `.gitignore` keeps out of git, whatever else it holds. */
export const IGNORED = ["app.key", "*.key", ".grain/"];
/** The registry is read this often at first while waiting, ms, then less and less often, down to once in `POLL_MAX_MS`. */
const POLL_MS = 2_000;
const POLL_MAX_MS = 15_000;
/** An offer shown again keeps at least this long to live; a shorter one is made anew. */
const REUSE_MIN_MS = 10 * 60_000;
/** The kind symbol of a managed account's address (Saltix 13-accounts): what an owner that is no plain key's account has. */
const MANAGED_KIND = 5;

/** What `.grain/pair.json` holds. */
export interface PairState {
  version: 2;
  network: NetworkName;
  /** The genesis hash, hex. */
  genesis: string;
  /** The command's fields the offer was made for. */
  target: PairTarget;
  /** The offer being shown, its Borsh in hex. */
  offer: string;
}

/** What `app.json` holds. */
export interface AppJson {
  slug: string;
  network: NetworkName;
  /** The first 8 bytes of the genesis hash, hex. */
  genesis: string;
  /** The owner's address, as the command named it; absent in an `app.json` from before version 2. */
  owner?: string;
  /** The server key's public half. */
  key: string;
  fingerprint: string;
  paired_at: string;
}

/** The slug's form (`grainCallProblem`'s), for the fields a developer types. */
const slugOk = (slug: string): boolean => /^[a-z0-9][a-z0-9-]{2,31}$/.test(slug);

/** A file only its owner may read, or an error that says so. */
function ownerOnly(path: string): void {
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path}: readable by others; chmod 600 it (it holds a server key)`);
  }
}

/** The key `grain pair` made and has not paired yet, or null. */
export function pendingKey(dir: string): Uint8Array | null {
  const path = join(dir, PAIR_KEY_FILE);
  if (!existsSync(path)) return null;
  ownerOnly(path);
  return fromHex(readFileSync(path, "utf8").trim(), 32);
}

/** A new key, written owner-only to `.grain/pair.key`: never printed. */
export function makePendingKey(dir: string): Uint8Array {
  grainDir(dir);
  const secret = ed25519.utils.randomPrivateKey();
  writeFileSync(join(dir, PAIR_KEY_FILE), toHex(secret) + "\n", { mode: 0o600, flag: "wx" });
  return secret;
}

/** The state of version 2, or null: an unreadable one, or version 1's (which kept answers to the phone), counts for
 *  nothing. */
export function readPairState(dir: string): PairState | null {
  const path = join(dir, PAIR_STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<PairState>;
    if (state.version !== 2 || typeof state.offer !== "string" || typeof state.target?.slug !== "string") return null;
    return state as PairState;
  } catch {
    return null;
  }
}

export function writePairState(dir: string, state: PairState): void {
  grainDir(dir);
  writeFileSync(join(dir, PAIR_STATE_FILE), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function readAppJson(dir: string): AppJson | null {
  const path = join(dir, APP_JSON_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AppJson;
  } catch {
    return null;
  }
}

/** Make `.gitignore` keep the keys and `.grain/` out of git; true when it changed. */
export function ensureGitignore(dir: string): boolean {
  const path = join(dir, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORED.filter((entry) => !lines.has(entry) && !(entry === ".grain/" && lines.has(".grain")));
  if (missing.length === 0) return false;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${text}${sep}# Server keys and grain pair's state: never in git.\n${missing.join("\n")}\n`);
  return true;
}

/** Whether `.gitignore` keeps the keys and `.grain/` out of git. */
export function gitignoreOk(dir: string): boolean {
  const path = join(dir, ".gitignore");
  if (!existsSync(path)) return false;
  const lines = new Set(readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()));
  return IGNORED.every((entry) => lines.has(entry) || (entry === ".grain/" && lines.has(".grain")));
}

/** A server's name for an offer: the text without characters an offer refuses, at most 32 characters. */
export function nameForOffer(text: string): string {
  return [...text].filter((c) => !refusedChar(c.codePointAt(0)!)).slice(0, MAX_PAIR_NAME).join("").trim();
}

/**
 * The owner's address of a registry record: its id is the record's `owner`; its kind is a plain key's (0) when the
 * manifest's owner key is that account's, else a managed account's. The id is what pairing binds; the kind only says how
 * the owner's address reads.
 */
export function ownerAddressOf(network: NetworkName, grain: RegisteredGrain): string {
  const owner = fromHex(grain.owner, 32);
  const ownerKey = grain.manifest?.manifest.owner_key;
  const plain = ownerKey === undefined || ("ed25519" in ownerKey && toHex(accountId(fromHex(ownerKey.ed25519, 32))) === grain.owner);
  return encodeAddress(network, owner, plain ? 0 : MANAGED_KIND);
}

/**
 * The QR code of `text` for a terminal. On a terminal (`tty`) with the colours set, so it scans on a light or a dark
 * theme; otherwise (an agent's output, a pipe, a log) Unicode half blocks with no escape codes, light modules drawn as
 * blocks: right on a dark background, the usual one. `.grain/pair.html` shows it on any screen.
 */
export async function terminalQr(text: string, tty: boolean): Promise<string> {
  if (tty) return QRCode.toString(text, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "L" });
  const quiet = 2;
  const light = (row: number, col: number) =>
    row < 0 || col < 0 || row >= modules.size || col >= modules.size || modules.get(row, col) === 0;
  const lines: string[] = [];
  for (let row = -quiet; row < modules.size + quiet; row += 2) {
    let line = "";
    for (let col = -quiet; col < modules.size + quiet; col++) {
      const top = light(row, col);
      const bottom = light(row + 1, col);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `.grain/pair.html`: the offer's QR code, its code, the app, the owner and what to do, with no script. Nothing secret. */
export async function pairPage(offer: PairingOffer, target: PairTarget): Promise<string> {
  const link = offerLink(offer);
  const svg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Pair this server with Saltix</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f4f6fb; color: #0b1020; }
  main { max-width: 420px; margin: 0 auto; text-align: center; }
  .qr { background: #fff; padding: 12px; border-radius: 16px; }
  .qr svg { width: 100%; height: auto; display: block; }
  .code { font-size: 40px; font-weight: 700; letter-spacing: 4px; margin: 16px 0 4px; font-variant-numeric: tabular-nums; }
  p { line-height: 1.45; }
  code { word-break: break-all; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Pair this server with Saltix</h1>
  <p>Scan with the app owner's Saltix (the phone's camera, or My apps → Pair a server) to pair this computer with the app
  <b>${escapeHtml(target.slug)}</b> of <code>${escapeHtml(target.owner)}</code>.</p>
  <div class="qr">${svg}</div>
  <div class="code">${offerCodeText(offer)}</div>
  <p>Saltix shows this code too: pair only if it is the same.</p>
  <p>Server ${offer.name === "" ? "" : `<b>${escapeHtml(offer.name)}</b> · `}key ${keyFingerprint(offer.key)} · valid until ${new Date(offer.expiresAt).toISOString()}</p>
  <p>The key stays on this computer. Nothing on this page is secret.</p>
  <p><code>${escapeHtml(link)}</code></p>
</main>
</body>
</html>
`;
}

/**
 * The key is paired with `target`'s app: `app.key` (owner-only, the form the server reads) and `app.json`, an older
 * `app.key` kept as `.grain/replaced-<fingerprint>-<time>.key`, and the pending key, the offer and its page gone.
 */
export function finishPairing(dir: string, network: NetworkName, genesis: string, target: PairTarget, secret: Uint8Array): AppJson {
  const key = AppKey.of(network, genesis, target.slug, secret);
  const appKey = join(dir, APP_KEY_FILE);
  if (existsSync(appKey)) {
    let old = "unreadable";
    try {
      old = keyFingerprint(AppKey.parse(readFileSync(appKey, "utf8")).publicKey);
    } catch {
      // Kept all the same: it is the owner's file.
    }
    renameSync(appKey, join(grainDir(dir), `replaced-${old}-${Date.now()}.key`));
  }
  writeFileSync(appKey, key.reveal() + "\n", { mode: 0o600, flag: "wx" });
  const app: AppJson = {
    slug: target.slug, network, genesis: key.genesis, owner: target.owner, key: key.publicKey, fingerprint: keyFingerprint(key.publicKey),
    paired_at: new Date().toISOString(),
  };
  writeFileSync(join(dir, APP_JSON_FILE), JSON.stringify(app, null, 2) + "\n");
  rmSync(join(dir, PAIR_KEY_FILE), { force: true });
  rmSync(join(dir, PAIR_STATE_FILE), { force: true });
  rmSync(join(dir, PAIR_PAGE_FILE), { force: true });
  ensureGitignore(dir);
  return app;
}

/** The slug `grain.json` gives, if it is there. */
export function readManifestSlug(dir: string): string | null {
  const path = join(dir, "grain.json");
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as { slug?: unknown };
    return typeof m.slug === "string" ? m.slug : null;
  } catch {
    return null;
  }
}

/** The command the app's page shows, as the tool says it when a field is missing. */
export const PAIR_COMMAND_FORM = "grain pair --app <slug> --owner <address> --genesis <16 hex>";

/** The slug the project's files name, in the order `grain pair` takes them: `app.json` (an app paired here on this
 *  network), the offer being shown, `grain.json`. */
export function projectSlug(dir: string, network: NetworkName, genesis: string): string | null {
  const app = readAppJson(dir);
  if (app && app.network === network && app.genesis === genesis.slice(0, 16)) return app.slug;
  const state = readPairState(dir);
  if (state && state.network === network && state.genesis === genesis) return state.target.slug;
  return readManifestSlug(dir);
}

export interface PairOptions {
  dir: string;
  node: NodeLike;
  /** The words that reach the same network in a command the tool suggests (` --network …`). */
  flags: string;
  /** `--app`, `--owner`, `--genesis`: the command's fields from the app's page in Saltix. */
  app?: string;
  owner?: string;
  genesis?: string;
  /** `--name`: what to call this server on the owner's screen; the computer's host name unless told. */
  name?: string;
  /** Pair a new key even though `app.key` (or a key waiting) is still named. */
  fresh: boolean;
  /** Show the offer and return: a later `grain pair` waits for the registry. */
  wait: boolean;
  /** Stop waiting after this long, ms; unless told, it waits until the registry names the key. */
  timeoutMs?: number;
  tty: boolean;
  log: DevLog;
  out?: (line: string) => void;
  /** A terminal's line rewritten in place while waiting (`rewriteLine`). */
  progress?: (line: string) => void;
  now?: () => number;
  /** Tests: how often the registry is read (ms), with no backoff. */
  pollMs?: number;
}

/** The whole of `grain pair`: its exit status. */
export async function pair(o: PairOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.log(line));
  const now = o.now ?? Date.now;
  const dir = resolve(o.dir);
  const status = await nodeCall<{ network: string; genesis: string }>(o.node, "node_status");
  if (!["mainnet", "testnet", "devnet"].includes(status.network)) throw new Error(`the node answers for ${status.network}, a network the SDK does not know`);
  const network = status.network as NetworkName;
  const genesis = status.genesis;
  const genesis16 = genesis.slice(0, 16);
  o.log.onNetwork(network);
  grainDir(dir);
  ensureGitignore(dir);

  // --genesis names the network the command is for: the one answering, or the command is for another.
  if (o.genesis !== undefined) {
    if (!/^[0-9a-f]{16}$/.test(o.genesis)) {
      throw new Error(`--genesis ${o.genesis}: the first 8 bytes of the genesis hash, 16 lower-case hex digits, as the app's page shows it`);
    }
    if (o.genesis !== genesis16) {
      o.log.step("fields", "refused", "other_network");
      throw new Error(`this computer is set up for another network: the command names the genesis ${o.genesis}, but the network answering is ` +
        `${network} ${genesis16}. Pass --network, --relay or --node for the network the app is on.`);
    }
  }

  // A key the registry still names stays: pairing another one is asked for (--new).
  const appKeyPath = join(dir, APP_KEY_FILE);
  const appJson = readAppJson(dir);
  const pairedHere = appJson && appJson.network === network && appJson.genesis === genesis16 ? appJson : null;
  let rotating: { slug: string; owner: string | null } | null = null;
  if (existsSync(appKeyPath)) {
    ownerOnly(appKeyPath);
    const current = AppKey.parse(readFileSync(appKeyPath, "utf8"));
    const grain = current.isFor(network, genesis) ? await grainGet(o.node, current.slug) : null;
    const why = current.isFor(network, genesis) ? registeredKeyStatus(grain, current.publicKey) : "other_network";
    if (why === null && !o.fresh) {
      if (o.app === undefined || o.app === current.slug) {
        out(`This server is paired with ${current.slug} on ${network} (key ${keyFingerprint(current.publicKey)}): nothing to do.`);
        out(`To pair a new key (to rotate it, or for another app): grain pair --new${o.flags}`);
        o.log.step("paired_already", "ok");
        return 0;
      }
      // The registry names a key for one live app only (ServerKeyTaken): another app takes a key of its own.
      out(`This server's key is paired with ${current.slug} (key ${keyFingerprint(current.publicKey)}), and the registry names a key for one live app only. ` +
        `To pair this computer with ${o.app}: grain pair --new --app ${o.app}${o.flags} (a new key; the old one serves ${current.slug} until the owner removes it).`);
      o.log.step("paired_already", "refused", "server_key_taken");
      return 1;
    }
    if (why !== null) out(`app.key no longer works (${why}): pairing a new key; app.key moves to ${GRAIN_DIR}/ once it is done.`);
    // The same app again, with its owner, unless it is retired: a retired slug is never used again.
    rotating = why === "retired" ? null : { slug: current.slug, owner: pairedHere && pairedHere.slug === current.slug ? pairedHere.owner ?? null : grain ? ownerAddressOf(network, grain) : null };
    o.log.step("rotate", "ok", why ?? "asked");
  }

  // The app: from the command line, else the project's files, else nothing to pair.
  const state0 = readPairState(dir);
  const kept = state0 && state0.network === network && state0.genesis === genesis ? state0 : null;
  // A retired app's app.json names the retired slug: it counts for nothing.
  const retiredHere = rotating === null && existsSync(appKeyPath);
  const slug = o.app ?? rotating?.slug ?? (retiredHere ? null : pairedHere?.slug ?? null) ?? kept?.target.slug ?? readManifestSlug(dir);
  if (slug === null) {
    o.log.step("fields", "refused", "no_app");
    throw new Error(`which app? ${PAIR_COMMAND_FORM}${o.flags}: copy the command from the app's page in Saltix (My apps → the app → Servers, or New app's last step). ` +
      "A project paired once keeps the fields.");
  }
  if (!slugOk(slug)) throw new Error(`--app ${slug}: a slug is 3 to 32 of [a-z0-9-], starting with a letter or a digit`);

  // The registry's record of the slug, read before anything is shown; and the owner: from the command line, else the
  // project's files, else the record's.
  const grain = await grainGet(o.node, slug);
  const record = slugRecordOf(grain);
  const ownerGiven: string | null = o.owner ?? (rotating && rotating.slug === slug ? rotating.owner : null) ?? (pairedHere && pairedHere.slug === slug ? pairedHere.owner ?? null : null)
    ?? (kept && kept.target.slug === slug ? kept.target.owner : null) ?? (grain ? ownerAddressOf(network, grain) : null);
  if (ownerGiven === null) {
    o.log.step("fields", "refused", "no_owner");
    throw new Error(`${slug} is not in the registry yet (a new app), so its owner is not known here: grain pair --app ${slug} --owner <the owner's address> ` +
      `--genesis ${genesis16}${o.flags}. The whole command is on the app's page in Saltix (New app's last step shows it for a new app).`);
  }
  let target: PairTarget;
  try {
    target = pairTarget(network, genesis, slug, ownerGiven);
  } catch (e) {
    o.log.step("fields", "refused", e instanceof PairingError ? `owner_${e.problem}` : "owner");
    if (e instanceof PairingError && e.problem === "other_network") {
      throw new Error(`the owner's address ${ownerGiven} is of another network, but the network answering is ${network} ${genesis16}: ` +
        "pass --network, --relay or --node for the network the app is on");
    }
    throw new Error(`--owner ${ownerGiven}: not an address of this network (its prefix: ${network === "mainnet" ? "salt1" : network === "testnet" ? "tsalt1" : "dsalt1"}…): ` +
      "copy it from the app's page in Saltix");
  }
  const ownerId = targetOwner(target);

  // The key: the one an earlier offer made, never paired, or a new one (--new: a new one even then).
  if (o.fresh) rmSync(join(dir, PAIR_KEY_FILE), { force: true });
  let secret = pendingKey(dir);
  if (secret === null) {
    secret = makePendingKey(dir);
    o.log.step("key_made", "ok");
  } else {
    o.log.step("key_reused", "ok");
  }
  const key = toHex(ed25519.getPublicKey(secret));

  // What the slug is to this owner, before anything is shown.
  const verdict = judgeSlug({ key, owner: ownerId }, record);
  if (verdict === "another_account") {
    const named = record!.servers.includes(key);
    out(`${slug} belongs to another account (${ownerAddressOf(network, grain!)}), not ${target.owner}` +
      (named ? ", and names this server's key already: grain pair --new makes a key of its own." : ": check the command on the app's page in Saltix (--app, --owner)."));
    o.log.step("record", "refused", named ? "server_key_taken" : "another_account");
    return 1;
  }
  if (verdict === "retired") {
    out(`${slug} is retired, and a retired slug is never used again: make a new app in Saltix and run the command from its page here.`);
    o.log.step("record", "refused", "retired");
    return 1;
  }
  if (verdict === "paired_already") {
    // Named already (a wait cut short, a managed owner's delay that passed): nothing to show.
    return finished(o, dir, network, genesis, target, secret, out);
  }
  // The key offered before for another app, and paired there meanwhile: the registry would refuse it for this one too
  // (ServerKeyTaken), so a key of its own is the way.
  if (kept && kept.target.slug !== slug && !o.fresh) {
    const before = slugRecordOf(await grainGet(o.node, kept.target.slug));
    if (before && before.servers.includes(key)) {
      out(`This server's key is paired with ${kept.target.slug} already (the registry names it), and the registry names a key for one live app only: ` +
        `to pair ${slug}, grain pair --new --app ${slug}${o.flags} makes a key of its own.`);
      o.log.step("record", "refused", "server_key_taken");
      return 1;
    }
  }

  // The offer: shown again while it has time to live and says the same, else a new one.
  let keptOffer: PairingOffer | null = null;
  if (kept) {
    try {
      keptOffer = decodeOffer(fromHex(kept.offer));
    } catch {
      keptOffer = null;
    }
  }
  const name = nameForOffer(o.name ?? keptOffer?.name ?? hostname());
  const fresh = (): PairingOffer => makeOffer({ network, genesis, secret: secret!, target, nonce: randomBytes(16).toString("hex"), name, createdAt: now() });
  let offer: PairingOffer;
  if (keptOffer && keptOffer.key === key && keptOffer.slug === slug && keptOffer.owner === ownerId && keptOffer.name === name && keptOffer.expiresAt - now() >= REUSE_MIN_MS) {
    offer = keptOffer;
    o.log.step("offer_shown_again", "ok");
  } else {
    offer = fresh();
    o.log.step("offer_made", "ok");
  }
  const keep = async (shown: PairingOffer): Promise<void> => {
    writePairState(dir, { version: 2, network, genesis, target, offer: toHex(encodeOffer(shown)) });
    writeFileSync(join(dir, PAIR_PAGE_FILE), await pairPage(shown, target));
  };
  const show = async (shown: PairingOffer, renewed: boolean): Promise<void> => {
    out(await terminalQr(offerLink(shown), o.tty));
    out(renewed
      ? "The offer expired with nobody having scanned it: a new one, the same key. Scan it with the app owner's Saltix, compare the code, confirm with the PIN."
      : "Pair this server with Saltix: scan the QR code with the app owner's Saltix (the phone's camera, or My apps → Pair a server), compare the code, confirm with the PIN.");
    out(`  app          ${slug}${record === null ? " (a new app: Saltix registers it when the owner confirms)" : ""}`);
    out(`  owner        ${target.owner}`);
    out(`  server       ${shown.name === "" ? "(unnamed)" : shown.name} · key ${keyFingerprint(key)} (its secret stays in ${PAIR_KEY_FILE} on this computer)`);
    out(`  network      ${network} ${genesis16}`);
    out(`  code         ${offerCodeText(shown)}   (Saltix shows it too: pair only if it is the same)`);
    out(`  valid until  ${new Date(shown.expiresAt).toISOString()}`);
    out(`  page         ${join(dir, PAIR_PAGE_FILE)} (the QR code for a browser)`);
    out(`  link         ${offerLink(shown)}`);
  };
  await keep(offer);
  await show(offer, false);
  if (!o.wait) {
    out(`Run grain pair${o.flags} to wait: it watches the registry and writes app.key once the record names the key.`);
    o.log.step("offer", "waiting", "no_wait");
    return 0;
  }

  // Watch the registry: the record of the slug, until it names the key. No relay session, no mailbox: the owner's
  // transaction is the only word, read through the wallet interface.
  out("Waiting for the owner's Saltix to name the key in the registry… (Ctrl-C stops; grain pair again shows the same offer while it lives)");
  const waiting = new Waiting({ tty: o.tty, print: out, now, ...(o.progress ? { progress: o.progress } : {}) }, "waiting", o.timeoutMs);
  const started = now();
  const max = o.pollMs ?? POLL_MAX_MS;
  let delay = o.pollMs ?? POLL_MS;
  let silent = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.5), max);
    let current: RegisteredGrain | null;
    try {
      current = await grainGet(o.node, slug);
      silent = 0;
    } catch (e) {
      // The network not answering is waited out, said once in a while: the registry's word comes when it comes.
      if (++silent % 5 === 1) {
        waiting.done();
        out(`the network did not answer (${(e as Error).message}): still waiting`);
        o.log.step("registry", "waiting", "network_unreachable");
      }
      continue;
    }
    const now_ = now();
    const record_: SlugRecord | null = slugRecordOf(current);
    const verdict_ = judgeSlug({ key, owner: ownerId }, record_);
    if (verdict_ === "paired_already") {
      waiting.done();
      return finished(o, dir, network, genesis, target, secret, out);
    }
    if (verdict_ === "another_account" || verdict_ === "retired") {
      waiting.done();
      out(verdict_ === "retired"
        ? `${slug} was retired meanwhile: nothing is written. Make a new app in Saltix and run the command from its page here.`
        : `${slug} belongs to another account now (${ownerAddressOf(network, current!)}): nothing is written. Check the command on the app's page in Saltix.`);
      o.log.step("registry", "refused", verdict_);
      return 1;
    }
    if (o.timeoutMs !== undefined && now_ - started >= o.timeoutMs) {
      waiting.done();
      o.log.step("registry", "timeout", "not_named");
      out(`The registry does not name the key yet after ${elapsed(now_ - started)} (a managed account's call may wait its delay). ` +
        `grain pair${o.flags} again shows the offer (the same key) and waits; grain status says where it stands.`);
      return 1;
    }
    if (now_ >= offer.expiresAt) {
      offer = fresh();
      await keep(offer);
      o.log.step("offer_renewed", "ok");
      waiting.done();
      await show(offer, true);
    }
    waiting.at("the registry does not name the key yet (the owner scans the QR code, compares the code and confirms with the PIN)");
  }
}

function finished(o: PairOptions, dir: string, network: NetworkName, genesis: string, target: PairTarget, secret: Uint8Array, out: (line: string) => void): number {
  const app = finishPairing(dir, network, genesis, target, secret);
  o.log.step("paired", "ok");
  out(`Paired: key ${app.fingerprint} is named for ${target.slug} (owner ${target.owner}) on ${network}.`);
  out(`app.key (owner-only) and app.json are written; .gitignore keeps the keys and ${GRAIN_DIR}/ out of git.`);
  out("Next: npm start (a chat-only app), or grain doctor for what is left.");
  return 0;
}
