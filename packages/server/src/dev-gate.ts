// `createDevGate` (`@saltix/grain-server/dev`): a test network's gate on this computer, speaking saltix-api's interface
// (Saltix 33-gate §4.5) for development and tests. Codes are redeemed once for a grant it signs with its own key; it
// judges no attestation, so it gives unattested grants only (at most a day of the code's length, §4.3) and refuses a
// certificate chain. Every refusal of §4.5 can be played (`refuse`). Development keys only.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ATTESTATION, type AccessGrant, UNATTESTED_MAX_MS, accessCodeId, canonicalAccessCode, encodeSignedAccessGrant, grantSigningMessage,
  redeemMessage,
} from "./access.js";
import { fromBase64, fromHex, toBase64, toHex } from "./bytes.js";
import { verifyByDeviceKey } from "./keys.js";

/** The access lengths a code is minted for (§4.1), by the names the gate answers with. */
const LENGTHS: Readonly<Record<string, number>> = {
  "1m": 60_000, "10m": 600_000, "30m": 1_800_000, "1h": 3_600_000, "1d": 86_400_000, "3d": 3 * 86_400_000, "7d": 7 * 86_400_000,
  "1mo": 30 * 86_400_000, "6mo": 182 * 86_400_000, "1y": 365 * 86_400_000,
};
const CHALLENGE_LIFE_MS = 10 * 60_000;
const UNATTESTED = new Set(["keystore", "software", "refused", "computer"]);

/** A refusal the gate answers with instead (§4.5). */
export interface DevGateRefusal {
  status: number;
  error: string;
  detail?: string;
  retry_after?: number;
}

export interface DevGateOptions {
  /** The network's genesis hash (hex): the one network it serves. */
  genesis: string;
  /** The codes it takes, as typed (`XXXXX-XXXXX`), each with its access length (`"1d"`, `"10m"`…, or ms). */
  codes: Record<string, string | number>;
  /** Whether it gives unattested grants (a computer's, §4.3): true by default. */
  unattested?: boolean;
  /** The gate key's Ed25519 secret: random by default. */
  secret?: Uint8Array;
  /** Answer a redemption with this refusal instead (the code stays unspent), or let it through (undefined). */
  refuse?: (body: Record<string, unknown>) => DevGateRefusal | undefined;
  now?: () => number;
}

export interface DevGate {
  /** The base URL to redeem at (`http://127.0.0.1:<port>`), what `SALTIX_GATE` names. */
  readonly url: string;
  /** The gate key: what relays trust (`--access-grants`, `hello.access`, `node_status.access`). */
  readonly key: Uint8Array;
  /** Every redemption asked, in order: its body as sent, and the answer's status. */
  readonly redemptions: Array<{ body: Record<string, unknown>; status: number }>;
  /** The codes spent, canonical. */
  readonly spent: Set<string>;
  close(): Promise<void>;
}

/** A gate on 127.0.0.1 (a free port). */
export async function createDevGate(o: DevGateOptions): Promise<DevGate> {
  const secret = o.secret ?? randomBytes(32);
  const key = ed25519.getPublicKey(secret);
  const now = o.now ?? Date.now;
  const challenges = new Map<string, number>();
  const spent = new Set<string>();
  const redemptions: DevGate["redemptions"] = [];
  const codes = new Map<string, { label: string; ms: number }>();
  for (const [typed, length] of Object.entries(o.codes)) {
    const c = canonicalAccessCode(typed);
    if ("problem" in c) throw new TypeError(`${typed}: not an access code (${c.problem})`);
    const ms = typeof length === "number" ? length : LENGTHS[length];
    if (ms === undefined || !(ms > 0)) throw new TypeError(`${typed}: an access length (${Object.keys(LENGTHS).join(", ")}) or ms`);
    codes.set(c.code, { label: typeof length === "number" ? `${length}ms` : length, ms });
  }

  const answer = (res: ServerResponse, status: number, body: object) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  function redeem(body: Record<string, unknown>): { status: number; body: object } {
    const refuse = (status: number, error: string, detail?: string) => ({ status, body: detail ? { error, detail } : { error } });
    const bytes = (field: string, size: number): Uint8Array | null => {
      try {
        const b = fromBase64(String(body[field]), true);
        return b.length === size ? b : null;
      } catch {
        return null;
      }
    };
    const challenge = bytes("challenge", 32);
    const accessKey = bytes("key", 33);
    const proof = bytes("proof", 64);
    for (const [field, value] of [["challenge", challenge], ["key", accessKey], ["proof", proof]] as const) {
      if (value === null) return refuse(400, "malformed", field);
    }
    if (typeof body.code !== "string") return refuse(400, "malformed", "code");
    if (typeof body.network !== "string" || !/^[0-9a-f]{64}$/.test(body.network)) return refuse(400, "malformed", "network");
    if ((body.chain === undefined) === (body.unattested === undefined)) return refuse(400, "malformed", "unattested");
    if (body.network !== o.genesis) return refuse(400, "network");
    const hold = o.refuse?.(body);
    if (hold && hold.error !== "rate_limited" && hold.error !== "locked") challenges.delete(toHex(challenge!));
    if (hold) return { status: hold.status, body: { error: hold.error, ...(hold.detail ? { detail: hold.detail } : {}), ...(hold.retry_after !== undefined ? { retry_after: hold.retry_after } : {}) } };
    // The challenge is spent by any answer from here on.
    const issued = challenges.get(toHex(challenge!));
    challenges.delete(toHex(challenge!));
    if (issued === undefined || now() - issued > CHALLENGE_LIFE_MS) return refuse(400, "challenge");
    const network = fromHex(o.genesis, 32);
    if (!verifyByDeviceKey({ p256: toHex(accessKey!) }, redeemMessage(challenge!, network, accessKey!), toHex(proof!))) {
      return refuse(400, "malformed", "proof");
    }
    if (body.chain !== undefined) return refuse(403, "attestation", "root");
    if (typeof body.unattested !== "string" || !UNATTESTED.has(body.unattested)) return refuse(400, "malformed", "unattested");
    if (o.unattested === false) return refuse(403, "unattested_off");
    const canonical = canonicalAccessCode(body.code);
    const code = "code" in canonical ? codes.get(canonical.code) : undefined;
    if (!code || !("code" in canonical) || spent.has(canonical.code)) return refuse(401, "rejected");
    spent.add(canonical.code);
    const issuedAt = now();
    const grant: AccessGrant = {
      version: 1, network, key: accessKey!, attestation: ATTESTATION.none, boot: 255, code: accessCodeId(canonical.code),
      issuedAt, notAfter: issuedAt + Math.min(code.ms, UNATTESTED_MAX_MS),
    };
    const signed = { grant, signature: ed25519.sign(grantSigningMessage(grant), secret) };
    return {
      status: 200,
      body: {
        grant: toBase64(encodeSignedAccessGrant(signed), true), issued_at: grant.issuedAt, not_after: grant.notAfter, access: code.label,
        attestation: "none", boot: "unknown", code_id: toHex(grant.code),
      },
    };
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST") return answer(res, 405, { error: "malformed" });
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      } catch {
        return answer(res, 400, { error: "malformed", detail: "json" });
      }
      if (req.url === "/v1/access/challenge") {
        const challenge = randomBytes(32);
        challenges.set(toHex(challenge), now());
        return answer(res, 200, { challenge: toBase64(challenge, true), expires_at: now() + CHALLENGE_LIFE_MS });
      }
      if (req.url === "/v1/access/redeem") {
        const out = redeem(body);
        redemptions.push({ body, status: out.status });
        return answer(res, out.status, out.body);
      }
      answer(res, 404, { error: "malformed", detail: "path" });
    });
  }

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`, key, redemptions, spent,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      // A client's kept-alive connection would hold the server open.
      server.closeAllConnections();
    }),
  };
}
