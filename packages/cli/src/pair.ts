// `grain pair`: the computer that runs an app's program pairs its own server key with the owner's Saltix by a QR code
// (Saltix 24-app-studio §3a). The key is made here and never leaves this computer: it waits in `.grain/pair.key`
// (owner-only) until the registry names it, then becomes `app.key` (owner-only, the developer key's form, which the
// server reads) beside `app.json` (the app, the network and the key's public half: nothing secret).
//
// 1. A key (the one an earlier offer made, if it was never paired) and an offer of it: a QR code in the terminal, the
//    link, `.grain/pair.html` and the offer's code.
// 2. Registered at the network's relays under the key's address, it answers the owner's Saltix: one app and one owner
//    per offer, with the key's proof for them (`judgePair`, `answerPair`), and says in the terminal who asked.
// 3. It watches the registry until it names the key for that app, then writes `app.key` and `app.json`.
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import QRCode from "qrcode";
import {
  AppKey, type NetworkName, type NodeLike, type PairRequest, type PairingOffer, type RelayFrame, MAX_PAIR_NAME, PairingError, RelayClient, RelayGateways, answerPair, decodePairFrame, encodePairFrame, grainGet,
  judgePair, keyFingerprint, makeOffer, nodeCall, offerCodeText, offerLink, refusedChar, registeredKeyStatus, relaysOf, toHex,
  fromHex, decodeOffer, encodeOffer, APP_KEY_FILE,
} from "@saltix/grain-server";
import { type DevLog, GRAIN_DIR, grainDir } from "./devlog.js";

/** Where a key not paired yet waits, owner-only. */
export const PAIR_KEY_FILE = join(GRAIN_DIR, "pair.key");
/** The offer being shown and what was answered: nothing secret. */
export const PAIR_STATE_FILE = join(GRAIN_DIR, "pair.json");
/** A page with the offer's QR code: nothing secret. */
export const PAIR_PAGE_FILE = join(GRAIN_DIR, "pair.html");
/** The app the server is paired with, its network and its key's public half: nothing secret. */
export const APP_JSON_FILE = "app.json";
/** What `.gitignore` keeps out of git, whatever else it holds. */
export const IGNORED = ["app.key", "*.key", ".grain/"];
/** How often the registry is read while waiting, ms. */
const POLL_MS = 3_000;
/** An offer shown again keeps at least this long to live; a shorter one is made anew. */
const REUSE_MIN_MS = 10 * 60_000;

/** What `.grain/pair.json` holds. */
export interface PairState {
  network: NetworkName;
  /** The genesis hash, hex. */
  genesis: string;
  /** The offer being shown, its Borsh in hex. */
  offer: string;
  /** Each offer's answer (its nonce, the app and the owner account, hex), newest last. */
  answered: Array<{ offer: string; slug: string; owner: string; at: string }>;
}

/** What `app.json` holds. */
export interface AppJson {
  slug: string;
  network: NetworkName;
  /** The first 8 bytes of the genesis hash, hex. */
  genesis: string;
  /** The server key's public half. */
  key: string;
  fingerprint: string;
  paired_at: string;
}

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

export function readPairState(dir: string): PairState | null {
  const path = join(dir, PAIR_STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PairState;
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

/** A new app's name for an offer: the text without characters an offer refuses, at most 32 characters. */
export function nameForOffer(text: string): string {
  return [...text].filter((c) => !refusedChar(c.codePointAt(0)!)).slice(0, MAX_PAIR_NAME).join("").trim();
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

/** `.grain/pair.html`: the offer's QR code, its code and what to do, with no script. Nothing secret. */
export async function pairPage(offer: PairingOffer): Promise<string> {
  const link = offerLink(offer);
  const svg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  const app = offer.slug ? `the app <b>${escapeHtml(offer.slug)}</b>` : offer.name ? `an app (a new one would be “${escapeHtml(offer.name)}”)` : "an app";
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
  <p>Scan with the app owner's Saltix (the phone's camera, or My apps → Pair a server) to pair this computer with ${app}.</p>
  <div class="qr">${svg}</div>
  <div class="code">${offerCodeText(offer)}</div>
  <p>Saltix shows this code too: pair only if it is the same.</p>
  <p>Server key ${keyFingerprint(offer.key)} · valid until ${new Date(offer.expiresAt).toISOString()}</p>
  <p>The key stays on this computer. Nothing on this page is secret.</p>
  <p><code>${escapeHtml(link)}</code></p>
</main>
</body>
</html>
`;
}

/** The registry's word on `key` (hex) for each app an offer was answered for: the first that names it, or null. */
export async function namedFor(node: NodeLike, key: string, answered: PairState["answered"]): Promise<{ slug: string; owner: string } | null> {
  const seen = new Set<string>();
  for (const a of [...answered].reverse()) {
    if (seen.has(a.slug)) continue;
    seen.add(a.slug);
    const grain = await grainGet(node, a.slug);
    if (grain && grain.owner === a.owner && registeredKeyStatus(grain, key) === null) return { slug: a.slug, owner: a.owner };
  }
  return null;
}

/**
 * The key is paired with `slug`: `app.key` (owner-only, the developer key's form) and `app.json`, an older `app.key`
 * kept as `.grain/replaced-<fingerprint>.key`, and the pending key and offer gone.
 */
export function finishPairing(dir: string, network: NetworkName, genesis: string, slug: string, secret: Uint8Array): AppJson {
  const key = AppKey.of(network, genesis, slug, secret);
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
    slug, network, genesis: key.genesis, key: key.publicKey, fingerprint: keyFingerprint(key.publicKey), paired_at: new Date().toISOString(),
  };
  writeFileSync(join(dir, APP_JSON_FILE), JSON.stringify(app, null, 2) + "\n");
  rmSync(join(dir, PAIR_KEY_FILE), { force: true });
  rmSync(join(dir, PAIR_STATE_FILE), { force: true });
  rmSync(join(dir, PAIR_PAGE_FILE), { force: true });
  ensureGitignore(dir);
  return app;
}

/** How the relay connection reaches the network: a node's `relay_list`, or the gateways' relays and the ones they name. */
function relayReach(node: NodeLike): { node?: string; endpoints?: RelayGateways["endpoints"]; discover?: () => ReturnType<typeof relaysOf> } {
  if (typeof node === "string") return { node };
  if (node instanceof RelayGateways) return { endpoints: node.endpoints, discover: () => relaysOf(node) };
  return { discover: () => relaysOf(node) };
}

export interface PairOptions {
  dir: string;
  node: NodeLike;
  /** The words that reach the same network in a command the tool suggests (` --network …`). */
  flags: string;
  slug?: string;
  name?: string;
  /** Pair a new key even though `app.key` is still named. */
  fresh: boolean;
  /** Show the offer and return: a later `grain pair` waits for Saltix. */
  wait: boolean;
  timeoutMs: number;
  tty: boolean;
  log: DevLog;
  out?: (line: string) => void;
  now?: () => number;
  /** Tests: a relay connection of their own, and how often the registry is read (ms). */
  connect?: typeof RelayClient.connect;
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
  o.log.onNetwork(network);
  grainDir(dir);
  ensureGitignore(dir);

  // A key the registry still names stays: pairing another one is asked for (--new).
  const appKeyPath = join(dir, APP_KEY_FILE);
  let rotating: string | null | undefined;
  if (existsSync(appKeyPath)) {
    ownerOnly(appKeyPath);
    const current = AppKey.parse(readFileSync(appKeyPath, "utf8"));
    const grain = current.isFor(network, genesis) ? await grainGet(o.node, current.slug) : null;
    const why = current.isFor(network, genesis) ? registeredKeyStatus(grain, current.publicKey) : "other_network";
    if (why === null && !o.fresh) {
      out(`This server is paired with ${current.slug} on ${network} (key ${keyFingerprint(current.publicKey)}): nothing to do.`);
      out(`To pair a new key (to rotate it, or for another app): grain pair --new${o.flags}`);
      o.log.step("paired_already", "ok");
      return 0;
    }
    if (why !== null) out(`app.key no longer works (${why}): pairing a new key; app.key moves to ${GRAIN_DIR}/ once it is done.`);
    // The same app again, unless it is retired: a retired slug is never used again.
    rotating = why === "retired" ? null : current.slug;
    o.log.step("rotate", "ok", why ?? "asked");
  }

  // The key: the one an earlier offer made, never paired, or a new one.
  let secret = pendingKey(dir);
  const state0 = readPairState(dir);
  if (secret === null) {
    secret = makePendingKey(dir);
    o.log.step("key_made", "ok");
  } else {
    o.log.step("key_reused", "ok");
  }
  const key = toHex(ed25519.getPublicKey(secret));
  const answered = state0 && state0.network === network && state0.genesis === genesis ? state0.answered : [];

  // Saltix may have named it already (a wait cut short, a managed owner's delay that passed).
  const named = answered.length > 0 ? await namedFor(o.node, key, answered) : null;
  if (named) return finished(o, dir, network, genesis, named.slug, secret, out);

  // The offer: shown again while it has time to live, else a new one.
  const manifest = readManifestSlugAndName(dir);
  const slug = o.slug ?? (rotating === null ? manifest.slug ?? null : rotating ?? readAppJson(dir)?.slug ?? manifest.slug ?? null);
  const name = nameForOffer(o.name ?? manifest.name ?? basename(dir));
  let offer: PairingOffer | null = null;
  if (state0 && state0.network === network && state0.genesis === genesis) {
    try {
      const kept = decodeOffer(fromHex(state0.offer));
      if (kept.key === key && kept.slug === slug && kept.name === name && kept.expiresAt - now() >= REUSE_MIN_MS) offer = kept;
    } catch {
      offer = null;
    }
  }
  if (offer === null) {
    offer = makeOffer({ network, genesis, key, nonce: randomBytes(16).toString("hex"), slug, name, createdAt: now() });
    o.log.step("offer_made", "ok");
  } else {
    o.log.step("offer_shown_again", "ok");
  }
  const state: PairState = { network, genesis, offer: toHex(encodeOffer(offer)), answered };
  writePairState(dir, state);
  writeFileSync(join(dir, PAIR_PAGE_FILE), await pairPage(offer));

  const link = offerLink(offer);
  out(await terminalQr(link, o.tty));
  out(`Pair this server with Saltix: scan the QR code with the app owner's Saltix (the phone's camera, or My apps → Pair a server).`);
  out(`  code         ${offerCodeText(offer)}   (Saltix shows it too: pair only if it is the same)`);
  out(`  app          ${slug ?? `any of the owner's, or a new one named "${name}"`}`);
  out(`  network      ${network} ${genesis.slice(0, 16)}`);
  out(`  server key   ${keyFingerprint(key)} (its secret stays in ${PAIR_KEY_FILE} on this computer)`);
  out(`  valid until  ${new Date(offer.expiresAt).toISOString()}`);
  out(`  page         ${join(dir, PAIR_PAGE_FILE)} (the QR code for a browser)`);
  out(`  link         ${link}`);
  if (!o.wait) {
    out(`Run grain pair${o.flags} to wait for Saltix: it answers the phone and writes app.key once the registry names the key.`);
    o.log.step("offer", "waiting", "no_wait");
    return 0;
  }

  // Answer Saltix, then watch the registry.
  const connect = o.connect ?? RelayClient.connect.bind(RelayClient);
  let relay: RelayClient;
  try {
    relay = await connect({ ...relayReach(o.node), secret, network, ackKept: "by_handler", timeoutMs: 20_000 });
  } catch (e) {
    o.log.step("relay", "failed", "network_unreachable");
    throw new Error(`no relay took this server's registration (${(e as Error).message}): check the connection, or pass --relay or --node`);
  }
  o.log.step("relay", "ok");
  out("Waiting for Saltix… (Ctrl-C stops; grain pair again shows the same offer while it lives)");
  let queue = Promise.resolve();
  const onFrame = (frame: RelayFrame) => {
    queue = queue.then(() => answer(o, frame, relay, offer!, secret!, genesis, state, dir, out, now)).catch(() => {});
  };
  relay.on("frame", onFrame);
  const stop = () => {
    relay.close();
    process.exitCode = 130;
    process.exit();
  };
  process.once("SIGINT", stop);
  try {
    const deadline = now() + o.timeoutMs;
    for (;;) {
      if (state.answered.length > 0) {
        const done = await namedFor(o.node, key, state.answered).catch(() => null);
        if (done) return finished(o, dir, network, genesis, done.slug, secret, out);
      }
      if (now() >= deadline) {
        o.log.step("registry", "timeout", state.answered.some((a) => a.offer === offer!.nonce) ? "answered_not_named" : "not_asked");
        out(state.answered.some((a) => a.offer === offer!.nonce)
          ? `Saltix was answered, but the registry does not name the key yet (a managed account's call may wait its delay). ` +
            `grain pair${o.flags} again finishes once it does; grain status says where it stands.`
          : `Saltix did not ask in time. grain pair${o.flags} again shows the offer (or a new one).`);
        return 1;
      }
      if (now() >= offer.expiresAt && !state.answered.some((a) => a.offer === offer!.nonce)) {
        o.log.step("offer", "timeout", "offer_expired");
        out(`The offer expired before Saltix asked: grain pair${o.flags} makes a new one.`);
        return 1;
      }
      await new Promise((r) => setTimeout(r, o.pollMs ?? POLL_MS));
    }
  } finally {
    process.removeListener("SIGINT", stop);
    relay.off("frame", onFrame);
    relay.close();
  }
}

/** Judge one frame and answer it; an accepted request is kept as the offer's answer. */
async function answer(o: PairOptions, frame: RelayFrame, relay: RelayClient, offer: PairingOffer, secret: Uint8Array, genesis: string,
  state: PairState, dir: string, out: (line: string) => void, now: () => number): Promise<void> {
  let request: PairRequest;
  try {
    const read = decodePairFrame(frame.payload);
    if (!("request" in read)) throw new PairingError("not_pairing");
    request = read.request;
  } catch (e) {
    // Not a pairing request (a chat frame for an earlier app of this key, say): nothing to answer.
    o.log.step("request", "refused", e instanceof PairingError ? `frame_${e.problem}` : "frame_unread");
    frame.ack();
    return;
  }
  const grain = await grainGet(o.node, request.slug);
  const record = grain === null ? null : { owner: grain.owner, retired: grain.retired !== null };
  const prior = state.answered.find((a) => a.offer === offer.nonce) ?? null;
  const result = judgePair(offer, prior, record, request, now());
  await relay.send(frame.from, encodePairFrame({ answer: answerPair(secret, genesis, request, result) }), { keep: true });
  frame.ack();
  o.log.step("request", result === "accepted" ? "ok" : "refused", result);
  if (result === "accepted") {
    if (prior === null) {
      state.answered.push({ offer: offer.nonce, slug: request.slug, owner: request.owner, at: new Date(now()).toISOString() });
      writePairState(dir, state);
    }
    out(`Saltix asked to pair this server with ${request.slug}${grain === null ? " (a new app)" : ""}, owner account ` +
      `${request.owner.slice(0, 8)}…: answered. Waiting for the owner's transaction to name the key…`);
  } else {
    out(`Saltix asked for ${request.slug} and was refused: ${result} (${REFUSALS[result]}).`);
  }
}

const REFUSALS: Record<string, string> = {
  used: "this offer was answered for another app or owner",
  expired: "the offer expired",
  unknown: "a request for another offer",
  other_app: "this project is set up for another app",
  not_owner: "the registry holds that app for another account, or retired",
};

function finished(o: PairOptions, dir: string, network: NetworkName, genesis: string, slug: string, secret: Uint8Array, out: (line: string) => void): number {
  const app = finishPairing(dir, network, genesis, slug, secret);
  o.log.step("paired", "ok");
  out(`Paired: this server speaks for ${slug} on ${network} (key ${app.fingerprint}).`);
  out(`app.key (owner-only) and app.json are written; .gitignore keeps the keys and ${GRAIN_DIR}/ out of git.`);
  out(`Next: npm start (a chat-only app), or grain doctor for what is left.`);
  return 0;
}

/** The slug and the English name `grain.json` gives, if it is there. */
function readManifestSlugAndName(dir: string): { slug?: string; name?: string } {
  const path = join(dir, "grain.json");
  if (!existsSync(path)) return {};
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as { slug?: unknown; name?: { en?: unknown } };
    return {
      slug: typeof m.slug === "string" ? m.slug : undefined,
      name: typeof m.name?.en === "string" ? m.name.en : undefined,
    };
  } catch {
    return {};
  }
}
