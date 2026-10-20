// The reference gate's interface (Saltix 33-gate §4.5): saltix-api at https://api.saltix.io, which Saltix, the web
// wallet and `grain pair` ask for an access grant with a one-time code. JSON, binary values base64url without padding,
// the network in hex, times Unix ms. This is saltix-api's interface, not the relays' protocol: another network's gate
// may differ (`SALTIX_GATE` names it to the command line).
//
// A computer cannot attest its key (§4.3), so it redeems an unattested grant (`unattested: "computer"`): at most 24 hours
// of the code's access length, and the code is spent.
import { type AccessCredential, AccessKey, canonicalAccessCode, decodeSignedAccessGrant, grantSigner, redeemMessage } from "./access.js";
import { fromBase64, fromHex, toBase64, toHex } from "./bytes.js";

/** The gate of Saltix's test network. */
export const GATE_URL = "https://api.saltix.io";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const GATE_TIMEOUT_MS = 20_000;

/** Every word the gate refuses with (§4.5), and the SDK's own for a gate that does not answer as one (`unreachable`,
 *  `answer`). */
export type GateError =
  | "malformed" | "network" | "challenge" | "rejected" | "attestation" | "unattested_off" | "rate_limited" | "locked"
  | "unavailable" | "storage" | "unreachable" | "answer";

/** What each refusal means, and what to do about it, in plain words. */
export const GATE_WORDS: Readonly<Record<GateError, string>> = {
  malformed: "the gate could not read the request: update the SDK (git pull, then npm run build in saltix-grains) and try again",
  network: "this gate does not serve the network the relays are on: its operator gives access elsewhere (set SALTIX_GATE to " +
    "that network's gate)",
  challenge: "the gate's challenge ended or was used before the code reached it: try again",
  rejected: "the gate does not take this code: it is unknown, used already, revoked, or older than 7 days (a code opens " +
    "one grant, within 7 days of being made). Get a new code",
  attestation: "the gate refused the key's attestation",
  unattested_off: "the gate gives no access to computers now (its operator turned off grants without a phone's hardware " +
    "attestation): ask the network's operator",
  rate_limited: "too many attempts from this address",
  locked: "too many wrong codes from this address: the gate locked it for a while (check the code before the next try)",
  unavailable: "the gate cannot give access right now: try again in a few minutes",
  storage: "the gate had an internal error: try again in a few minutes, and tell the network's operator if it goes on",
  unreachable: "the gate did not answer: check this computer's connection",
  answer: "the gate's answer is not one the SDK reads: update the SDK (git pull, then npm run build in saltix-grains)",
};

const KNOWN = new Set(Object.keys(GATE_WORDS));

/** The gate refused, or did not answer as a gate does: `error` is its word, `retryAfter` seconds when it gave some. */
export class GateRefused extends Error {
  constructor(readonly error: GateError, readonly detail: string | null = null, readonly retryAfter: number | null = null) {
    super(`${GATE_WORDS[error]}${detail ? ` (${detail})` : ""}${retryAfter !== null ? `: try again in ${retryAfter} s` : ""}`);
    this.name = "GateRefused";
  }
}

/** Whether the command line may ask `url`: `https://`, or plain `http://` on loopback (a development gate). */
export function usableGate(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/** What `redeemComputerAccess` needs. */
export interface ComputerRedemption {
  /** The gate's base URL (`GATE_URL` for Saltix's test network). */
  gate: string;
  /** The code as typed: `XXXXX-XXXXX`, any case. */
  code: string;
  /** The network's genesis hash, hex. */
  genesis: string;
  /** The gates the network's relays trust (`node_status.access`): the grant must be one of theirs. */
  gates: readonly Uint8Array[];
  /** Tests: another `fetch`, another clock. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** A computer's grant from the gate, with the key it is bound to and what the gate said of it. */
export interface RedeemedAccess extends AccessCredential {
  /** The code's access length as minted (`10m`, `1d`…): a computer's grant is at most a day of it. */
  access: string;
}

async function post<T>(o: ComputerRedemption, path: string, body: object): Promise<T> {
  const doFetch = o.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(new URL(path, o.gate.endsWith("/") ? o.gate : `${o.gate}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GateRefused("unreachable", (e as Error).message);
  }
  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new GateRefused(response.ok ? "answer" : response.status >= 500 ? "unavailable" : "answer", `HTTP ${response.status}`);
  }
  if (response.ok) return json as T;
  const word = typeof json.error === "string" && KNOWN.has(json.error) ? (json.error as GateError) : response.status >= 500 ? "unavailable" : "answer";
  const retry = typeof json.retry_after === "number" && Number.isFinite(json.retry_after) ? Math.max(0, Math.ceil(json.retry_after)) : null;
  throw new GateRefused(word, typeof json.detail === "string" ? json.detail : word === "answer" ? `HTTP ${response.status}` : null, retry);
}

const b64url = (bytes: Uint8Array): string => toBase64(bytes, true);

/**
 * Redeem `code` for this computer (33-gate §4.3, §4.5): a new P-256 access key, a challenge, the key's proof of
 * possession, `unattested: "computer"`. The answer is checked before it is taken: a grant for this key and this network,
 * unattested, signed by a gate the network trusts, not ended. A challenge spent before the code reached the gate is
 * asked again once. Throws a `GateRefused` in plain words.
 */
export async function redeemComputerAccess(o: ComputerRedemption): Promise<RedeemedAccess> {
  if (!usableGate(o.gate)) throw new TypeError(`the gate ${o.gate}: https://, or http:// on this computer only`);
  const canonical = canonicalAccessCode(o.code);
  if ("problem" in canonical) throw new TypeError("not an access code");
  if (!/^[0-9a-f]{64}$/.test(o.genesis)) throw new TypeError("genesis: the network's genesis hash in lowercase hex");
  const network = fromHex(o.genesis, 32);
  for (let attempt = 0; ; attempt++) {
    const key = AccessKey.generate();
    const { challenge: c } = await post<{ challenge?: unknown }>(o, "v1/access/challenge", {});
    let challenge: Uint8Array;
    try {
      challenge = fromBase64(String(c), true);
    } catch {
      throw new GateRefused("answer", "challenge");
    }
    if (challenge.length !== 32) throw new GateRefused("answer", "challenge");
    let answer: { grant?: unknown; access?: unknown };
    try {
      answer = await post(o, "v1/access/redeem", {
        code: canonical.code, network: o.genesis, challenge: b64url(challenge), key: b64url(key.publicKey),
        proof: b64url(key.sign(redeemMessage(challenge, network, key.publicKey))), unattested: "computer",
      });
    } catch (e) {
      if (e instanceof GateRefused && e.error === "challenge" && attempt === 0) continue;
      throw e;
    }
    let grant;
    try {
      grant = decodeSignedAccessGrant(fromBase64(String(answer.grant), true));
    } catch {
      throw new GateRefused("answer", "grant");
    }
    const g = grant.grant;
    if (toHex(g.key) !== toHex(key.publicKey)) throw new GateRefused("answer", "a grant for another key");
    if (toHex(g.network) !== o.genesis) throw new GateRefused("network", "the grant is for another network");
    if (grantSigner(grant, o.gates) === null) {
      throw new GateRefused("network", "the grant is signed by a gate this network's relays do not trust");
    }
    if (g.notAfter <= (o.now ?? Date.now)()) throw new GateRefused("answer", "a grant that has ended");
    return { grant, key, access: typeof answer.access === "string" ? answer.access : "" };
  }
}
