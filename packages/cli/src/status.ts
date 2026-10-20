// `grain status` and `grain doctor`: where a project's server stands, read from its files and the registry, and the
// exact next step. `status` answers one question, whether the server is paired with its app (Saltix 24-app-studio §3a);
// a page alone has no server, so for it pairing is `not_needed`. `doctor` checks the rest of the path to an app that runs
// or a page that is published, and stops at the first thing to do: before a page's first publish, what registering it
// takes (the deposit, and on the test network without a phone the faucet and `--key owner.key`); a transaction a key
// file here sent, until it landed; and an outcome its exit status tells: nothing to do (0), something to do (1), or
// nothing but waiting for the network (75). Neither writes anything but the steps' log, and neither prints a secret:
// keys appear by their fingerprint.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, APP_KEY_FILE, type Manifest, type NodeLike, type RegisteredGrain, NO_ICON, UNOWNED, blobHeld, decodeOffer, encodeManifest, fromHex, grainGet,
  grainQuote, iconHash, keyFingerprint, minimumFee, nodeCall, registeredKeyStatus, statusGates, toHex,
} from "@saltix/grain-server";
import { WHERE_CODES, keptAccess } from "./access.js";
import { type Bundle, makeBundle } from "./bundle.js";
import { CONNECT_FILE, TEMPLATE_NEXT, lintConnect, readConnectFile, stillTemplate, templateTexts } from "./connect.js";
import { EXIT_WAITING, GRAIN_DIR } from "./devlog.js";
import { saltOf } from "./faucet.js";
import { ICON_FILES, checkIcon } from "./icon.js";
import { accountOf, addressOf } from "./owner.js";
import { PAIR_KEY_FILE, gitignoreOk, namedFor, pendingKey, readPairState } from "./pair.js";
import { KEY_FILE, readKey } from "./project.js";
import {
  type PublishState, type SentRecord, STALE_MS, isPublishCall, landedIn, nextVersion, publicChanged, readPublishState, sameContent, sealedAsSent,
  txStatus, whoOpensNow,
} from "./publish-flow.js";
import { salt } from "./registry.js";
import { STAGES } from "./send.js";
import { protocolOf } from "./sources.js";
import { privateCall } from "./studio.js";
import { LANDS_IN } from "./wait.js";

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
  let status: { network: string; genesis: string; access?: unknown };
  try {
    status = await nodeCall(node, "node_status");
  } catch (e) {
    return {
      status: "unknown", detail: `the network did not answer (${(e as Error).message})`,
      next: `grain status${flags} again once the network answers (or pass --relay or --node)`,
    };
  }
  // Where the relays require access (33-gate), a key not paired yet needs this computer's grant: a code, unless one is
  // kept here that still lasts.
  const gates = statusGates(status.access);
  const needsCode = gates !== null && !("credential" in keptAccess(dir, { network: status.network, genesis: status.genesis, gates }, Date.now()));
  const pairing = (command: string) =>
    needsCode ? `${command} --access-code XXXXX-XXXXX (this test network requires an access code to pair: ${WHERE_CODES})` : command;
  if (existsSync(appKeyPath)) {
    let key: AppKey;
    try {
      key = AppKey.parse(readFileSync(appKeyPath, "utf8"));
    } catch (e) {
      return { status: "invalid", detail: `app.key is not a developer key (${(e as Error).message})`, next: pairing(`grain pair --new${flags}`) };
    }
    const base = { slug: key.slug, network: key.network, fingerprint: keyFingerprint(key.publicKey) };
    if (!key.isFor(status.network, status.genesis)) {
      return {
        ...base, status: "other_network",
        detail: `app.key is for ${key.network} ${key.genesis}, but the network answering is ${status.network} ${status.genesis.slice(0, 16)} (a reset?)`,
        next: pairing(`grain pair --new${flags}`),
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
    return { ...base, status: why, grain, detail: `app.key: ${words[why]}`, next: pairing(`grain pair --new${flags}`) };
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
      next: pairing(`grain pair${flags}`),
    };
  }
  const env = process.env.SALTIX_APP_KEY?.trim() ? " (SALTIX_APP_KEY is set in this shell: the server would use it, this command does not read it)" : "";
  return { status: "unpaired", detail: `no app.key and no key waiting in ${GRAIN_DIR}/${env}`, next: pairing(`grain pair${flags}`) };
}

/** One of `doctor`'s findings: ok; something to do, which `next` says; or nothing to do but wait for the network. */
export interface Finding {
  ok: boolean;
  what: string;
  detail: string;
  next?: string;
  /** Not done yet, with nothing to do about it but wait: a transaction on its way to the registry. */
  waiting?: boolean;
}

/** Where the project stands as a whole: nothing left to do, only waiting for the network, or something to do. */
export type DoctorOutcome = "done" | "waiting" | "fix";

/**
 * `grain doctor`'s exit statuses: 0, nothing left to do; 1, something to do or fix (`next` says what); 75, nothing to
 * do but wait for the network (a transaction on its way: ask again in a minute). 75 is sysexits' EX_TEMPFAIL, "try again
 * later", as a server that cannot work exits with 78 (EX_CONFIG); never 2, the command line's exit for a misuse.
 */
export const DOCTOR_EXIT: Readonly<Record<DoctorOutcome, number>> = { done: 0, fix: 1, waiting: EXIT_WAITING };

/** The project's outcome from its findings: something to do outweighs waiting, since it can be done meanwhile. */
export function outcomeOf(findings: readonly Finding[]): DoctorOutcome {
  if (findings.some((f) => !f.ok && !f.waiting)) return "fix";
  return findings.some((f) => !f.ok) ? "waiting" : "done";
}

/** Where a page's publish stands (Saltix 32-images §7.3): its bundle not uploaded, held pending on a server key's word,
 *  waiting for the owner's signature (the link shown), its day over, or published (the registry names it and the
 *  network holds its bundle). */
export type PublishStatus = "not_uploaded" | "pending" | "waiting_for_owner" | "pending_expired" | "published";

/** What a test network's key file needs beyond a slug's deposit: two registry calls' fees (registering, then making it
 *  private), with room to spare: 0.001 SALT. */
const FEES_MARGIN = 1_000_000n;

/** The fees of a first publish signed with a key file, in base units of SALT: `RegisterGrain` with `manifest` as
 *  `grain publish` sends it (`sealedAsSent`: its bundle and the sources the network's protocol asks for), and
 *  `SetGrainAccess` private right behind it; null when it cannot be read as a manifest. */
export function firstPublishFees(manifest: unknown, deposit: bigint): bigint | null {
  try {
    const m = manifest as Manifest;
    return minimumFee({ register: { manifest: m, signature: "00".repeat(64) }, deposit }) + minimumFee(privateCall(m.slug));
  } catch {
    return null;
  }
}

/** `manifest` as `grain publish` would send it to `node`'s network: sealed with the bundle `built` and the sources its
 *  protocol asks for; as it is when that cannot be told (no bundle, the network silent). */
async function asSent(node: NodeLike, manifest: unknown, built: Bundle | null): Promise<unknown> {
  if (built === null) return manifest;
  try {
    const status = await nodeCall<{ protocol?: { version?: unknown } }>(node, "node_status");
    return (await sealedAsSent(node, protocolOf(status), manifest as Manifest, built)).manifest;
  } catch {
    return manifest;
  }
}

/**
 * Before a page's first publish (its slug free): what registering it takes, and the way there. The owner's Saltix
 * registers it from `grain publish`'s QR code and pays the deposit; on a test network without a phone, `owner.key`
 * does with `--key`, once the faucet gave its account the deposit and the fees.
 */
async function firstPublish(dir: string, node: NodeLike, slug: string, flags: string, manifest: unknown): Promise<Finding> {
  const { deposit } = await grainQuote(node, slug);
  const { network } = await nodeCall<{ network: string }>(node, "node_status");
  const fees = firstPublishFees(manifest, deposit);
  let detail = `${slug} is free: its first grain publish registers it, keeping a deposit of ${salt(deposit)} SALT until it retires` +
    (fees === null ? "" : `, and fees of about ${salt(fees)} SALT (registering, then making it private)`);
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

/**
 * Whether a blob is in the network, by the `blob_get` of the relay asked (`blobHeld`) and when this computer saw the
 * network take it (`.grain/publish.json`): held by that relay; or seen taken from here, the relay still fetching a copy
 * of its own. `fetching` alone is no proof: a relay knows a bundle's or an icon's hash from the manifest the registry
 * holds, and looks for the bytes whether or not anyone has them (32-images §8).
 */
export const inNetwork = (answer: "held" | "fetching" | "absent", seenAt: string | null | undefined): boolean =>
  answer === "held" || (answer === "fetching" && typeof seenAt === "string" && seenAt !== "");

/** Where a transaction a key file here sent stands: landed (the registry shows what it makes); on its way (in the pool,
 *  in a shard block, or not seen yet by the relay asked while it may still land); or gone, never to land. */
export type Stage = "landed" | "pool" | "block" | "unseen" | "gone";

/** A recorded transaction and where it stands. */
export interface Flight {
  record: SentRecord;
  stage: Stage;
}

/**
 * Where `t` stands, by the registry `g`, the node's word on the transaction and its slot (null when unknown). Gone, as
 * the command that would send it again judges: a registration or an update once its last slot passed and the node knows
 * it not (`grain publish` waits for it until then, since one sent twice would be refused, and then sends it anew); an
 * access or profile call once the node knows it not, or it reached a block 10 minutes ago and the registry still does
 * not show it (refused there), as sending such a call again is harmless.
 */
export async function stageOf(node: NodeLike, t: SentRecord, g: RegisteredGrain | null, slot: number | null, now: number): Promise<Stage> {
  if (landedIn(t, g)) return "landed";
  const at = await txStatus(node, t.id);
  if (at === "pending") return "pool";
  if (isPublishCall(t)) return at === "included" ? "block" : slot !== null && slot > t.valid_until ? "gone" : "unseen";
  return at === "included" && now - Date.parse(t.at) < STALE_MS ? "block" : "gone";
}

/** What each stage of a wait is, in words. */
const STAGE_WORDS: Readonly<Record<"pool" | "block" | "unseen", string>> = {
  pool: STAGES.pool, block: STAGES.block, unseen: "not seen yet by the relay asked, and it may still land",
};

/** A recorded call in words. */
function callWords(t: SentRecord, slug: string): string {
  if (t.call === "register") return `the registration of ${slug} v${t.version}`;
  if (t.call === "update") return `the update of ${slug} to v${t.version}`;
  if (t.call === "access") {
    const a = t.access ?? { public: false, members: [] };
    const n = a.members.length;
    return `the access call (${a.public ? "public" : "private"}, ${n === 0 ? "no members" : `${n} member${n === 1 ? "" : "s"}`})`;
  }
  return t.revision === null || t.revision === undefined ? "the call that clears the Connect profile" : `Connect profile revision ${t.revision}`;
}

/** The transaction and when it was sent, for people. */
const sentAt = (t: SentRecord) => `transaction ${t.id}, sent at ${t.at}`;

/** The command that sends a recorded call again. */
function sendAgain(t: SentRecord, slug: string, flags: string): string {
  if (isPublishCall(t)) return `grain publish${flags} (it sends it anew)`;
  if (t.call === "profile") return `grain profile${t.revision === null ? " --clear" : ""}${flags}`;
  const a = t.access ?? { public: false, members: [] };
  return `grain access --slug ${slug} ${a.public ? "--public" : "--private"}${a.members.map((m) => ` --member ${m.account}:${m.roles}`).join("")}${flags}`;
}

/** A recorded call that has not landed: waiting while it is on its way, something to do once it is gone. */
function flightFinding(f: Flight, what: string, slug: string, flags: string, meanwhile = ""): Finding {
  if (f.stage === "gone") {
    return {
      ok: false, what,
      detail: `${callWords(f.record, slug)} (${sentAt(f.record)}) can no longer land: ` +
        (isPublishCall(f.record) ? "its last slot passed and the network does not know it"
          : "the network does not know it, or it reached a block over 10 minutes ago and the registry does not show it (refused there)") +
        meanwhile,
      next: sendAgain(f.record, slug, flags),
    };
  }
  return {
    ok: false, waiting: true, what,
    detail: `${callWords(f.record, slug)} (${sentAt(f.record)}) has not landed yet: ${STAGE_WORDS[f.stage as "pool" | "block" | "unseen"]}; ` +
      `a registry call takes ${LANDS_IN}${meanwhile}`,
    next: isPublishCall(f.record)
      ? `grain doctor${flags} again in a minute (it exits ${EXIT_WAITING} while it only waits); grain publish${flags} waits for it, never sending it again, then puts the bundle and the icon up`
      : `grain doctor${flags} again in a minute (it exits ${EXIT_WAITING} while it only waits)`,
  };
}

/** Who may open the app, as the registry holds it (`whoOpensNow`, the words `grain publish` ends with); a key file's
 *  registration still public is to fix, and an access call on its way is waited for. */
function accessFinding(g: RegisteredGrain, run: PublishState | null, flight: Flight | undefined, slug: string, dir: string, flags: string): Finding {
  const words = whoOpensNow(slug, g, join(dir, KEY_FILE), flags, dir);
  const onItsWay = flight !== undefined && flight.stage !== "landed" && flight.stage !== "gone";
  if (g.public !== false && run?.private_pending) {
    if (onItsWay) {
      return {
        ok: false, waiting: true, what: "access",
        detail: `public until the call that makes it private lands: ${KEY_FILE} registered it here, and that call (${sentAt(flight.record)}) is ` +
          `${STAGE_WORDS[flight.stage as "pool" | "block" | "unseen"]}`,
        next: `grain doctor${flags} again in a minute (it exits ${EXIT_WAITING} while it only waits)`,
      };
    }
    return {
      ok: false, what: "access",
      detail: `public, but should be private: ${KEY_FILE} registered it here, and the call that makes it private has not landed (anyone may open it meanwhile)`,
      next: `grain access --slug ${slug} --private${flags} (${KEY_FILE} signs it by itself, as the app's owner; or grain publish${flags}, which sends it again)`,
    };
  }
  if (flight !== undefined && flight.stage !== "landed") return flightFinding(flight, "access", slug, flags, `; until then ${words}`);
  return { ok: true, what: "access", detail: `${words}${flight?.stage === "landed" ? ` (${callWords(flight.record, slug)} sent at ${flight.record.at} landed)` : ""}` };
}

/** Before the app is registered: `connect.json` as `grain lint` checks it, and whether it still says what grain init
 *  wrote; the registry takes it once the app is registered (`grain profile`). */
function localProfile(dir: string, manifest: unknown): Finding {
  if (!existsSync(join(dir, CONNECT_FILE))) {
    return { ok: false, what: "connect profile", detail: "no connect.json: every app ships a Connect profile", next: "grain lint says what it holds (grain init writes one)" };
  }
  try {
    const { errors } = lintConnect(dir, manifest as Manifest);
    if (errors.length > 0) return { ok: false, what: "connect profile", detail: `connect.json: ${errors.length} error(s)`, next: "grain lint says which" };
    const template = templateTexts(readConnectFile(join(dir, CONNECT_FILE)));
    if (template.length > 0) {
      return { ok: false, what: "connect profile", detail: `connect.json is grain init's template (${template[0]})`, next: TEMPLATE_NEXT };
    }
  } catch (e) {
    return { ok: false, what: "connect profile", detail: `connect.json: ${(e as Error).message}`, next: "grain lint says more" };
  }
  return { ok: true, what: "connect profile", detail: "connect.json checks; the registry takes it once the app is registered (grain profile)" };
}

/** The registry's Connect profile, and a profile call of a key file here on its way; none yet, with `connect.json` still
 *  `grain init`'s words: rewriting it comes first, as `grain profile` refuses them. */
function profileFinding(g: RegisteredGrain, flight: Flight | undefined, slug: string, flags: string, dir: string): Finding {
  const holds = g.profile ? `revision ${g.profile.profile.revision}` : "none";
  if (flight !== undefined && flight.stage !== "landed") return flightFinding(flight, "connect profile", slug, flags, `; the registry holds ${holds}`);
  if (g.profile) {
    return {
      ok: true, what: "connect profile",
      detail: `revision ${g.profile.profile.revision} in the registry${flight ? ` (${callWords(flight.record, slug)} sent at ${flight.record.at} landed)` : ""}`,
    };
  }
  return {
    ok: false, what: "connect profile", detail: "the registry holds no Connect profile: users see only the description",
    next: stillTemplate(dir) ? `${TEMPLATE_NEXT}; then grain profile${flags}` : `grain profile${flags}`,
  };
}

/** Whether grain.json says the same as the registry's manifest, but for what `grain publish` fills in (`sameContent`);
 *  true when grain.json cannot be read as one (`grain lint` says why). */
function sameAsRegistry(registered: Manifest, ours: unknown): boolean {
  try {
    encodeManifest({ ...(ours as Manifest), ...UNOWNED });
  } catch {
    return true;
  }
  return sameContent(registered, ours as Manifest);
}

/** Every check of `grain doctor`, in the order of the path to an app that runs; the next step, or what to say when
 *  there is none; and the outcome its exit status tells (`DOCTOR_EXIT`). */
export async function doctor(dir: string, node: NodeLike, flags = "", now = Date.now()): Promise<{
  state: KeyState; findings: Finding[]; publish: PublishStatus | null; next: string; outcome: DoctorOutcome;
}> {
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
  const slug = manifest?.slug ?? grain?.slug ?? "";
  const page = manifest?.entry !== undefined && !chatOnly && !("chat" in manifest.entry);
  const placeholder = (manifest?.entry?.hosted?.origins ?? []).length > 0 && manifest!.entry!.hosted!.origins!.every((o) => /\.example(:\d+)?$/.test(o));
  const sealed = manifest?.entry?.sealed;
  const version = manifest?.version ?? 0;

  // What a key file here sent and no command saw land (`.grain/publish.json`), each where it stands now.
  const run = readPublishState(dir);
  let ours = run && manifest?.slug && run.slug === manifest.slug ? run : null;
  const flights: Flight[] = [];
  if (ours && (ours.sent ?? []).length > 0 && grain !== undefined) {
    const status = await nodeCall<{ genesis?: string; slot?: number }>(node, "node_status").catch(() => null);
    if (status?.genesis && !status.genesis.startsWith(ours.genesis)) {
      ours = null;
    } else {
      for (const record of ours.sent ?? []) flights.push({ record, stage: await stageOf(node, record, grain, typeof status?.slot === "number" ? status.slot : null, now) });
    }
  }
  const publishing = flights.find((f) => isPublishCall(f.record) && f.stage !== "landed");
  const published = flights.find((f) => isPublishCall(f.record) && f.stage === "landed");
  const latest = (call: SentRecord["call"]) => flights.filter((f) => f.record.call === call).at(-1);

  // The bundle public/ makes now.
  let built: Bundle | null = null;
  let bundleFinding: Finding | null = null;
  if (page && (sealed || placeholder)) {
    try {
      built = existsSync(join(dir, "public")) ? makeBundle(join(dir, "public")) : null;
    } catch (e) {
      bundleFinding = { ok: false, what: "bundle", detail: `public/ does not make a bundle (${(e as Error).message})`, next: "fix public/ (names, size), then grain publish" };
    }
    if (bundleFinding === null) {
      if (!sealed) {
        bundleFinding = { ok: true, what: "bundle", detail: "public/ is not sealed yet: grain publish seals it and puts it into the network" };
      } else if (built !== null && built.hash !== sealed.bundle) {
        // A change not published yet is the next thing to do, never "nothing left"; in grain lint's words once the
        // registry holds a version.
        bundleFinding = {
          ok: false, what: "bundle",
          detail: grain ? publicChanged(grain.version, nextVersion(grain.version, version)) : "public/ changed since grain.json's bundle: grain publish seals it again",
          next: `grain publish${flags}`,
        };
      } else {
        bundleFinding = { ok: true, what: "bundle", detail: "grain.json names the bundle public/ makes" };
      }
    }
  }

  // Where the publish stands: published (the registry names this bundle and the network holds it), held pending (waiting
  // for the owner, or not shown yet), its day over, on its way with a transaction, or not uploaded.
  let publish: PublishStatus | null = null;
  let uploadFinding: Finding | null = null;
  if (page && (sealed || placeholder)) {
    const held = grain?.manifest && "sealed" in grain.manifest.manifest.entry ? grain.manifest.manifest.entry.sealed.bundle : null;
    const same = ours && sealed && ours.bundle === sealed.bundle && ours.version === version ? ours : null;
    const until = same?.pending_until ? Date.parse(same.pending_until) : null;
    if (sealed && grain && grain.version === version && held === sealed.bundle) {
      const answer = await blobHeld(node, "grain_bundle", sealed.bundle).catch(() => "absent" as const);
      // Any run here that saw the network take these bytes counts, whatever version named them.
      const seen = ours && ours.bundle === sealed.bundle ? ours.uploaded_at : null;
      if (inNetwork(answer, seen)) {
        publish = "published";
        uploadFinding = {
          ok: true, what: "upload",
          detail: answer === "held" ? "published: the network holds its bundle" : `published: uploaded from here at ${seen}; the relay asked is still fetching a copy of its own`,
        };
      } else {
        publish = "not_uploaded";
        uploadFinding = {
          ok: false, what: "upload",
          detail: answer === "fetching"
            ? "the registry names the bundle, but nobody may hold it yet: the relay asked knows its hash from the manifest and is still looking for the bytes (fetching), and no upload from here is recorded"
            : "the registry names the bundle, but the relay asked neither holds it nor knows where it is",
          next: `grain publish${flags} (it uploads the bundle, then the icon)`,
        };
      }
    } else if (same?.uploaded_at && until !== null && until > now) {
      publish = same.link_shown_at ? "waiting_for_owner" : "pending";
      uploadFinding = {
        ok: false, what: "upload",
        detail: `the network holds the bundle pending until ${same.pending_until}${same.link_shown_at ? ": waiting for the owner to sign the publishing link" : ""}`,
        next: same.link_shown_at ? `the owner scans the QR code in Saltix (grain publish${flags} shows it again, and finishes once they did)` : `grain publish${flags}`,
      };
    } else if (same?.uploaded_at && until !== null) {
      publish = "pending_expired";
      uploadFinding = { ok: false, what: "upload", detail: `the bundle's day in the network ended at ${same.pending_until} before the owner signed`, next: `grain publish${flags} (it puts it up again)` };
    } else if (same?.link_shown_at) {
      publish = "waiting_for_owner";
      uploadFinding = { ok: false, what: "upload", detail: "waiting for the owner to sign the publishing link; the bundle goes up once the registry names it", next: `the owner scans the QR code in Saltix, while grain publish${flags} runs` };
    } else if (publishing && publishing.stage !== "gone" && publishing.record.version === version) {
      publish = "not_uploaded";
      uploadFinding = {
        ok: false, waiting: true, what: "upload",
        detail: "the bundle goes up once the registry names it, after the transaction lands",
        next: `grain publish${flags} once grain doctor says it landed (or now: it waits for it)`,
      };
    } else {
      publish = "not_uploaded";
      uploadFinding = { ok: false, what: "upload", detail: "the bundle is not in the network yet", next: `grain publish${flags}` };
    }
  }

  // The icon: the file grain.json names, to the standard, and in the network once published.
  let iconFinding: Finding | null = null;
  /** The registry names the icon and the network does not hold it: an upload left for grain publish. */
  let iconLeft = false;
  if (manifest && !chatOnly) {
    const icon = manifest.icon ?? NO_ICON;
    const file = ICON_FILES.find((f) => existsSync(join(dir, f)));
    if (icon === NO_ICON) {
      iconFinding = { ok: true, what: "icon", detail: "none: wallets draw the app's monogram (grain icon <picture> --out icon.png makes one)" };
    } else if (!file || iconHash(new Uint8Array(readFileSync(join(dir, file)))) !== icon) {
      iconFinding = { ok: false, what: "icon", detail: `no ${ICON_FILES.join(" or ")} here is the icon grain.json names`, next: "grain icon <picture> --out icon.png (it names the new one)" };
    } else {
      const lint = checkIcon(new Uint8Array(readFileSync(join(dir, file))), icon);
      const named = grain && grain.manifest && grain.manifest.manifest.icon === icon;
      const answer = named ? await blobHeld(node, "grain_icon", icon).catch(() => "absent" as const) : null;
      const seen = ours?.icon === icon ? ours.icon_uploaded_at : null;
      if (lint.errors.length > 0) {
        iconFinding = { ok: false, what: "icon", detail: lint.errors[0]!, next: `grain icon ${file} --out ${file}` };
      } else if (answer !== null && !inNetwork(answer, seen)) {
        iconLeft = true;
        iconFinding = {
          ok: false, what: "icon",
          detail: answer === "fetching"
            ? "the registry names it, but nobody may hold it yet (the relay asked is still looking for it, and no upload from here is recorded): wallets draw the monogram meanwhile"
            : "the registry names it, but the network does not hold it: wallets draw the monogram",
          next: `grain publish${flags} (it uploads the icon)`,
        };
      } else {
        iconFinding = {
          ok: true, what: "icon",
          detail: `${file}${lint.warnings.length > 0 ? `; ${lint.warnings.length} warning(s): grain icon ${file} says them` : ""}` +
            `${answer === "held" ? "; in the network" : answer === "fetching" ? `; uploaded from here at ${seen}` : ""}`,
        };
      }
    }
  }

  // The registry: a registration or an update on its way (or gone), the slug still free, or the version it holds, said
  // to have landed once it has, and whether grain.json still says what it holds.
  if (publishing && grain !== undefined) {
    findings.push(flightFinding(publishing, "registry", slug, flags));
  } else if (page && manifest?.slug && grain === null) {
    // A page whose slug is free: what its first publish takes, before anything else of the publish.
    try {
      findings.push(await firstPublish(dir, node, manifest.slug, flags, await asSent(node, manifest, built)));
    } catch {
      // The network did not answer: the key's finding says so.
    }
  } else if (page && grain && (sealed || placeholder)) {
    const how = published ? `${published.record.call === "register" ? "registered" : "in the registry"} (the transaction sent at ${published.record.at} landed)` : "in the registry";
    if (grain.manifest && grain.version >= version && !sameAsRegistry(grain.manifest.manifest, manifest)) {
      findings.push({
        ok: false, what: "registry",
        detail: `v${grain.version} ${how}, but grain.json says something else (its name, icon, permissions or page): grain publish makes v${grain.version + 1}`,
        next: `grain publish${flags}`,
      });
    } else {
      const done = publish === "published" && iconFinding?.ok !== false;
      const left = grain.version === version && (publish === "not_uploaded" || iconLeft);
      findings.push({ ok: true, what: "registry", detail: `v${grain.version} ${how}${done ? "; published" : left ? `; grain publish${flags} finishes the upload` : ""}` });
    }
  }
  if (bundleFinding) findings.push(bundleFinding);
  if (uploadFinding) findings.push(uploadFinding);

  if (grain && manifest?.version !== undefined && !chatOnly && publish === null) {
    const held = grain.version;
    const registryChat = grain.manifest ? "chat" in grain.manifest.manifest.entry : false;
    if (registryChat || held < manifest.version) {
      findings.push({
        ok: false, what: "published", detail: `the registry holds version ${held}${registryChat ? " (a chat-only app)" : ""}, grain.json is ${manifest.version}`,
        // grain publish raises the version itself when the registry holds this one or above.
        next: `grain publish${flags}`,
      });
    } else findings.push({ ok: true, what: "published", detail: `the registry holds version ${held}${published ? ` (the transaction sent at ${published.record.at} landed)` : ""}` });
  }
  if (iconFinding) findings.push(iconFinding);

  // Who may open it: public or private (the words grain publish ends with), a key file's registration still to be made
  // private, and an access call of a key file here on its way.
  if (grain && grain.retired === null && grain.public !== undefined) {
    findings.push(accessFinding(grain, ours, latest("access"), slug, dir, flags));
  }
  if (grain && state.status !== "unknown") {
    findings.push(profileFinding(grain, latest("profile"), slug, flags, dir));
  } else if (manifest && grain === null) {
    // Before the app is registered the registry has no profile to hold: connect.json is checked here instead, and set
    // once it is (grain profile).
    findings.push(localProfile(dir, manifest));
  }
  const outcome = outcomeOf(findings);
  // Something to do comes first, even while a transaction is on its way: it can be done meanwhile.
  const first = findings.find((f) => !f.ok && !f.waiting) ?? findings.find((f) => !f.ok);
  const done = kind === "page"
    ? publish === "published"
      ? "nothing: the page is published and the project is in order (a change to public/ or grain.json: grain publish makes the next version)"
      : "nothing: the project is in order"
    : "nothing: the server is paired and the project is in order (npm start runs it)";
  return { state, findings, publish, next: first?.next ?? done, outcome };
}
