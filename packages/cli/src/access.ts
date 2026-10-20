// A computer's access to a test network whose relays require access grants (Saltix 33-gate). `grain pair` registers at
// the relays under a key the registry does not name yet (24-app-studio §3a), so there it needs a grant; so does a write
// through the relays (`grain faucet`, a key file's transaction). A computer cannot attest its key, so the grant is
// unattested: at most 24 hours of the code's access length (§4.3).
//
// The code comes from `--access-code`, `SALTIX_ACCESS_CODE` or a person at the terminal; the gate (`SALTIX_GATE`,
// https://api.saltix.io by default) answers with the grant. The grant and its P-256 key are kept in the project
// (`.grain/access.json` and `.grain/access.key`, owner-only, out of git) and reused while they last: never printed or
// logged. A paired server needs none: relays let a registered server key in.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  type AccessCredential, AccessKey, type AccessReason, AccessRefused, GATE_URL, GateRefused, type NodeLike, canonicalAccessCode,
  decodeSignedAccessGrant, encodeSignedAccessGrant, fromBase64Url, fromHex, grantSigner, nodeCall, redeemComputerAccess,
  statusGates, toBase64Url, toHex, usableGate,
} from "@saltix/grain-server";
import { type DevLog, GRAIN_DIR, grainDir, isProject } from "./devlog.js";
// pair.ts imports this module too; only functions cross, called after both are loaded.
import { ensureGitignore } from "./pair.js";

/** The access key, owner-only: its secret never leaves this computer. */
export const ACCESS_KEY_FILE = join(GRAIN_DIR, "access.key");
/** The grant the gate gave, owner-only: of no use without the key, and never printed. */
export const ACCESS_FILE = join(GRAIN_DIR, "access.json");
/** Where a coding agent (or a script) hands over a code. */
export const ACCESS_CODE_ENV = "SALTIX_ACCESS_CODE";
/** Another network's gate (saltix-api's interface, 33-gate §4.5). */
export const GATE_ENV = "SALTIX_GATE";
/** A kept grant with less left than this is not shown again: a new code is asked for. */
export const ACCESS_MARGIN_MS = 60_000;

/** Where an access code comes from, said in every message that asks for one. */
export const WHERE_CODES =
  "the test network's operator gives access codes, made in Saltix Pass or with the operator's bot; a computer's access " +
  "lasts at most 24 hours of a code's length";

/** A network that requires access: its kind, genesis hash (hex) and the gates its relays trust. */
export interface Gated {
  network: string;
  genesis: string;
  gates: Uint8Array[];
}

/** What `.grain/access.json` holds. */
interface AccessFile {
  network: string;
  genesis: string;
  /** The access key's public half, hex. */
  key: string;
  /** The signed grant, base64url of its Borsh. */
  grant: string;
  not_after: string;
  /** The code's access length as minted. */
  access: string;
}

/** No code was given where one is needed, and nobody is at a terminal to type one. */
export class AccessCodeNeeded extends Error {
  readonly code = "access_code_needed";
  constructor(again: string) {
    super(`this test network lets in only people with an access code, and this computer's key is not paired yet, so it ` +
      `needs one. ${capital(WHERE_CODES)}. Run ${again} --access-code XXXXX-XXXXX (or set ${ACCESS_CODE_ENV}); a paired ` +
      `server needs none`);
    this.name = "AccessCodeNeeded";
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Whether the network answering requires access (`node_status.access`): its gates, or null. */
export async function gatedOf(node: NodeLike): Promise<Gated | null> {
  const status = await nodeCall<{ network: string; genesis: string; access?: unknown }>(node, "node_status");
  const gates = statusGates(status.access);
  return gates === null ? null : { network: status.network, genesis: status.genesis, gates };
}

/** `ms` for people: `23 h 59 min`, `9 min`, `40 s`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** The grant kept in `dir` for this network, while it lasts and the network's gates trust it; else why not. */
export function keptAccess(dir: string, gated: Gated, now: number):
  { credential: AccessCredential; notAfter: number } | { why: "none" | "unreadable" | "other_network" | "other_gate" | "ended" } {
  const keyPath = join(dir, ACCESS_KEY_FILE);
  const statePath = join(dir, ACCESS_FILE);
  if (!existsSync(statePath) || !existsSync(keyPath)) return { why: "none" };
  try {
    if (process.platform !== "win32" && (statSync(keyPath).mode & 0o077) !== 0) return { why: "unreadable" };
    const state = JSON.parse(readFileSync(statePath, "utf8")) as AccessFile;
    if (state.network !== gated.network || state.genesis !== gated.genesis) return { why: "other_network" };
    const key = AccessKey.fromSecret(fromHex(readFileSync(keyPath, "utf8").trim(), 32));
    const grant = decodeSignedAccessGrant(fromBase64Url(state.grant));
    if (toHex(key.publicKey) !== state.key || toHex(grant.grant.key) !== state.key || toHex(grant.grant.network) !== gated.genesis) {
      return { why: "unreadable" };
    }
    if (grantSigner(grant, gated.gates) === null) return { why: "other_gate" };
    if (grant.grant.notAfter - now < ACCESS_MARGIN_MS) return { why: "ended" };
    return { credential: { grant, key }, notAfter: grant.grant.notAfter };
  } catch {
    return { why: "unreadable" };
  }
}

/** Forget the kept grant: the relays refused it, or it ended. */
export function forgetAccess(dir: string): void {
  rmSync(join(dir, ACCESS_FILE), { force: true });
  rmSync(join(dir, ACCESS_KEY_FILE), { force: true });
}

function keep(dir: string, gated: Gated, credential: AccessCredential, access: string): void {
  grainDir(dir);
  ensureGitignore(dir);
  forgetAccess(dir);
  writeFileSync(join(dir, ACCESS_KEY_FILE), toHex(credential.key.reveal()) + "\n", { mode: 0o600, flag: "wx" });
  const state: AccessFile = {
    network: gated.network, genesis: gated.genesis, key: toHex(credential.key.publicKey),
    grant: toBase64Url(encodeSignedAccessGrant(credential.grant)), not_after: new Date(credential.grant.grant.notAfter).toISOString(), access,
  };
  writeFileSync(join(dir, ACCESS_FILE), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** What `obtainAccess` needs. */
export interface AccessAsk {
  /** The project: where the grant is kept (only in a project; elsewhere it lasts for this run). */
  dir: string;
  /** `--access-code`. */
  code?: string;
  env: Record<string, string | undefined>;
  /** Ask a person at the terminal; absent where nobody is (an agent, a pipe). */
  prompt?: (question: string) => Promise<string>;
  out: (line: string) => void;
  log: DevLog;
  /** The command that asks again, for the words: `grain pair`. */
  again: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const KEPT_WORDS = {
  other_network: "the access kept here is for another network (was the test network reset?)",
  other_gate: "the access kept here is from a gate this network no longer trusts",
  ended: "the access kept here has ended",
  unreadable: "the access kept here does not read",
} as const;

/**
 * This computer's access to a network that requires it: the grant kept in the project while it lasts, else one the gate
 * gives for a code (`--access-code`, `SALTIX_ACCESS_CODE`, or typed at the terminal), kept for the next run. Says when
 * it ends. Throws `AccessCodeNeeded` without a code, a `GateRefused` in plain words when the gate refuses one.
 */
export async function obtainAccess(a: AccessAsk, gated: Gated): Promise<AccessCredential> {
  const now = a.now ?? Date.now;
  const kept = keptAccess(a.dir, gated, now());
  if ("credential" in kept) {
    a.log.step("gate", "ok", "kept");
    a.out(`Access to the test network: this computer's grant, until ${new Date(kept.notAfter).toISOString()} ` +
      `(${duration(kept.notAfter - now())} left).`);
    return kept.credential;
  }
  if (kept.why !== "none") {
    a.out(`${capital(KEPT_WORDS[kept.why])}: a new access code is needed.`);
    forgetAccess(a.dir);
  }
  const gate = a.env[GATE_ENV] || GATE_URL;
  if (!usableGate(gate)) throw new Error(`${GATE_ENV}=${gate}: a gate's https:// address (http:// only on this computer)`);
  let typed = a.code ?? a.env[ACCESS_CODE_ENV]?.trim() ?? "";
  if (typed === "" && a.prompt) {
    a.out(`This test network lets in only people with an access code, and this computer's key is not paired yet. ${capital(WHERE_CODES)}.`);
    typed = (await a.prompt("Access code (XXXXX-XXXXX): ")).trim();
  }
  if (typed === "") {
    a.log.step("gate", "refused", "code_needed");
    throw new AccessCodeNeeded(a.again);
  }
  const canonical = canonicalAccessCode(typed);
  if ("problem" in canonical) {
    a.log.step("gate", "refused", `code_${canonical.problem}`);
    throw new Error(canonical.problem === "length"
      ? "that is not an access code: one has 10 letters and digits, XXXXX-XXXXX"
      : "that is not an access code: one has the digits 0 to 9 and the letters A to Z but I, L, O and U (each is a 1 or a 0 misread)");
  }
  let redeemed;
  try {
    redeemed = await redeemComputerAccess({ gate, code: canonical.code, genesis: gated.genesis, gates: gated.gates, fetch: a.fetch, now: a.now });
  } catch (e) {
    a.log.step("gate", "refused", e instanceof GateRefused ? e.error : "error");
    throw e;
  }
  const notAfter = redeemed.grant.grant.notAfter;
  const project = isProject(a.dir);
  if (project) keep(a.dir, gated, redeemed, redeemed.access);
  a.log.step("gate", "ok", "redeemed");
  const capped = (lengthMs(redeemed.access) ?? 0) > 24 * 3_600_000;
  a.out(`Access to the test network granted to this computer until ${new Date(notAfter).toISOString()} (${duration(notAfter - now())}` +
    `${redeemed.access ? `; the code gives ${redeemed.access}${capped ? ", a computer at most 24 hours" : ""}` : ""}).` +
    (project ? ` Kept in ${ACCESS_FILE} (out of git) for the commands after this one.` : " Not kept: this is no app's project."));
  return redeemed;
}

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, mo: 30 * 86_400_000, y: 365 * 86_400_000 };

/** A code's access length as the gate names it (`10m`, `1d`, `6mo`), in ms; null for a name it does not read. */
export function lengthMs(name: string): number | null {
  const m = /^(\d+)(m|h|d|mo|y)$/.exec(name);
  return m ? Number(m[1]) * UNITS[m[2]!]! : null;
}

/** What to do about a relay's refusal of this computer's access, in plain words; `forget`: the kept grant is no good. */
export function accessRefusalWords(reason: AccessReason, again: string): { words: string; forget: boolean } {
  const fresh = `get a new access code (${WHERE_CODES}) and run ${again} --access-code XXXXX-XXXXX`;
  switch (reason) {
    case "expired":
      return { words: `This computer's access to the test network has ended: ${fresh}.`, forget: true };
    case "gate":
    case "network":
    case "lifetime":
      return { words: `The relays do not take this computer's access (${reason}: ${REASON[reason]}): ${fresh}.`, forget: true };
    case "time":
      return { words: "The relays refused the access for its time: this computer's clock, or the gate's, is more than 10 minutes off. " +
        `Set the clock right (automatic time) and run ${again} again.`, forget: false };
    case "required":
      return { words: "A relay requires an access grant, but the node that answered requires none, so none was asked for. " +
        `Run ${again} again (another relay may answer), or pass --relay or --node to reach the network through one that requires access.`, forget: false };
    default:
      return { words: `The relays refused this computer's access (${reason}: ${REASON[reason]}): the SDK made a token they do not take. ` +
        `Update the SDK (git pull, then npm run build in saltix-grains), then ${fresh}.`, forget: true };
  }
}

const REASON: Record<AccessReason, string> = {
  required: "none shown", malformed: "unreadable", relay: "for another relay", time: "clock", network: "another network's",
  gate: "a gate this network no longer trusts", expired: "ended", lifetime: "too long", delegation: "a delegation", proof: "another key's",
};

/** The relays refused this computer's access: what to do, in words; `code` is the steps' log's reason. */
export class AccessProblem extends Error {
  readonly code: string;
  constructor(readonly reason: AccessReason, words: string) {
    super(words);
    this.name = "AccessProblem";
    this.code = `access_${reason}`;
  }
}

/** A refusal of access as `grain` ends with it: the words, and the kept grant forgotten when it is no good. */
export function accessRefused(e: AccessRefused, dir: string, again: string): AccessProblem {
  const { words, forget } = accessRefusalWords(e.reason, again);
  if (forget) forgetAccess(dir);
  return new AccessProblem(e.reason, words);
}

/** Whether `e` is about access (no code, the gate's refusal, the relays'): a command stops on it, never tries again. */
export const aboutAccess = (e: unknown): boolean =>
  e instanceof AccessRefused || e instanceof AccessCodeNeeded || e instanceof AccessProblem || e instanceof GateRefused;

/** A line typed at the terminal, or null where nobody is at one. */
export function terminalPrompt(): ((question: string) => Promise<string>) | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
