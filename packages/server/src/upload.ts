// Files next to the relay (Saltix 09-relay §10.5): a server seals a file, reserves it on its relay connection
// (`file_new`), sends the ciphertext in pieces over the relay's own certificate and names it in a `FileRef` for a chat's
// `File` block. What the relay answers, and what follows (as Saltix's own uploads do):
// - `200 {received}`, or `409 {received}` (the piece was not where the relay stands): the next piece from there;
// - `404`: the relay dropped the reservation. The upload starts over once under a new one; a second 404 ends it;
// - `507`: the relay has no room for the rest now. The piece is tried again after waits that grow from 2 s to 60 s, ten
//   times in all, then the upload fails;
// - anything else, or no answer: tried again after a short wait, six times in a row without progress.
import { request } from "node:http";
import { connect } from "node:tls";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Socket } from "node:net";
import { type FileRef, fileRefProblem, openFile, relayOfEndpoint, sealFile } from "./file.js";
import type { RelayClient, RelayEndpoint } from "./relay.js";

/** The largest piece of one `PUT`. */
export const FILE_PIECE = 1024 * 1024;
const MAX_TRIES = 6;
const RETRY_MS = 500;
const FULL_FIRST_MS = 2_000;
const FULL_MAX_MS = 60_000;
const FULL_TRIES = 10;
const REQUEST_TIMEOUT_MS = 60_000;

export interface UploadOptions {
  /** The file's name for the reader: at most 255 bytes, no control characters, no `/` or `\`. */
  name: string;
  /** Its media type, e.g. `text/csv`. */
  mime: string;
  /** Events worth logging (never an id or a key). */
  log?: (level: "info" | "warn", event: string, meta?: Record<string, unknown>) => void;
  /** Waits between tries; tests pass one that does not wait. */
  pause?: (ms: number) => Promise<void>;
}

interface Answer {
  status: number;
  body: Buffer;
}

/**
 * One HTTP request to a relay's client port (the host and port of its WebSocket endpoint): over TLS that shows exactly
 * the certificate `cert_sha256` pins (checked before a byte of the request is sent), or one a CA vouches for without a
 * pin; plain HTTP only for a developer's `ws://` relay on loopback.
 */
export async function relayRequest(endpoint: RelayEndpoint, method: string, path: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Answer> {
  const url = new URL(endpoint.url);
  const secure = url.protocol === "wss:";
  if (!secure && url.protocol !== "ws:") throw new Error("a relay endpoint is wss:// (or ws:// on loopback)");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (secure ? 443 : 80);
  let socket: Socket | undefined;
  if (secure) {
    const pin = endpoint.cert_sha256?.toLowerCase() ?? null;
    const tls = connect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: pin === null, ALPNProtocols: ["http/1.1"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the relay did not answer in time")), REQUEST_TIMEOUT_MS);
      tls.once("secureConnect", () => { clearTimeout(timer); resolve(); });
      tls.once("error", (e) => { clearTimeout(timer); reject(e); });
    }).catch((e) => {
      tls.destroy();
      throw e;
    });
    const raw = tls.getPeerCertificate()?.raw;
    if (pin !== null && (!raw || createHash("sha256").update(raw).digest("hex") !== pin)) {
      tls.destroy();
      throw new Error("certificate does not match the relay record");
    }
    socket = tls;
  }
  return new Promise<Answer>((resolve, reject) => {
    const req = request({
      host, port, method, path, timeout: REQUEST_TIMEOUT_MS,
      headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
      ...(socket ? { createConnection: () => socket! } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the relay did not answer in time")));
    req.on("error", reject);
    req.end(body ? Buffer.from(body.buffer, body.byteOffset, body.length) : undefined);
  });
}

const received = (a: Answer | null): number | null => {
  if (!a || (a.status !== 200 && a.status !== 409)) return null;
  try {
    const n = (JSON.parse(a.body.toString("utf8")) as { received?: unknown }).received;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
};

const fullWait = (n: number) => Math.min(FULL_MAX_MS, FULL_FIRST_MS * 2 ** (n - 1));

/** The pieces of `ciphertext` from where the relay stands, then `done`: `"done"`, or `"gone"` when the relay dropped
 *  the reservation. Throws when it gives up. */
async function send(slot: { id: string; endpoint: RelayEndpoint }, ciphertext: Uint8Array, options: UploadOptions): Promise<"done" | "gone"> {
  const pause = options.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const size = ciphertext.length;
  const path = `/_file/${slot.id}`;
  let off = 0;
  let tries = 0;
  let full = 0;
  const call = (method: string, at: string, headers?: Record<string, string>, body?: Uint8Array) =>
    relayRequest(slot.endpoint, method, at, headers, body).catch(() => null);
  for (;;) {
    while (off < size) {
      const piece = ciphertext.subarray(off, Math.min(off + FILE_PIECE, size));
      const answer = await call("PUT", path, { "x-offset": String(off), "content-type": "application/octet-stream" }, piece);
      if (answer?.status === 404) return "gone";
      if (answer?.status === 413) throw new Error("the relay took the file as smaller than it was reserved");
      if (answer?.status === 507) {
        if (full === 0) options.log?.("warn", "file_wait", { reason: "full", done_pct: Math.floor((100 * off) / size) });
        if (++full >= FULL_TRIES) throw new Error("the relay has no room for the file now (full)");
        await pause(fullWait(full));
        continue;
      }
      // Where the relay stands: ahead after a piece, or back where a 409 says. A 409 that names no offset: ask.
      let at = received(answer);
      if (at === null && answer?.status === 409) {
        const status = await call("GET", `${path}/status`);
        at = status?.status === 200 ? received({ status: 200, body: status.body }) : null;
      }
      if (at !== null && at !== off && at <= size) {
        off = at;
        tries = 0;
        full = 0;
        continue;
      }
      if (++tries > MAX_TRIES) throw new Error(`the relay did not take the file (${answer?.status ?? "no answer"})`);
      await pause(RETRY_MS * tries);
    }
    const done = await call("POST", `${path}/done`, { "content-type": "application/json" }, new TextEncoder().encode("{}"));
    if (done && done.status >= 200 && done.status < 300) return "done";
    if (done?.status === 404) return "gone";
    const at = received(done);
    if (done?.status === 409 && at !== null && at < size) {
      off = at; // the relay lost bytes: send them again
      continue;
    }
    if (++tries > MAX_TRIES) throw new Error(`the relay did not finish the file (${done?.status ?? "no answer"})`);
    await pause(RETRY_MS * tries);
  }
}

/**
 * Seal `plaintext` (1 byte to 50 MiB) under a fresh AES-256-GCM key, upload it next to the relay `relay` is registered
 * at, and return its reference: what a chat's `File` block names (09-relay §10.5.2). The relay keeps it 30 days.
 */
export async function uploadFile(relay: RelayClient, plaintext: Uint8Array, options: UploadOptions): Promise<FileRef> {
  const sealed = await sealFile(plaintext);
  const named = (id: string, endpoint: RelayEndpoint | null): FileRef => ({
    relay: endpoint ? relayOfEndpoint(endpoint) : null, id, key: sealed.key, iv: sealed.iv, hash: sealed.hash, size: sealed.size,
    name: options.name, mime: options.mime,
  });
  const problem = fileRefProblem(named("A".repeat(22), null));
  if (problem) throw new TypeError(`file: ${problem}`);
  for (let attempt = 0; ; attempt++) {
    const slot = await relay.reserveFile(sealed.ciphertext.length);
    const outcome = await send(slot, sealed.ciphertext, options);
    if (outcome === "done") {
      options.log?.("info", "file_uploaded", { bytes: sealed.size, restarted: attempt > 0 });
      return named(slot.id, slot.endpoint);
    }
    if (attempt > 0) throw new Error("the relay dropped the upload again");
    options.log?.("warn", "file_restart", { reason: "gone" });
  }
}

/**
 * The plaintext of the file `ref` names, fetched from its relay (or `own`, the reader's own relay, when it names none)
 * and checked against its hash: what a wallet does before it shows a file. For tests and TypeScript clients.
 */
export async function downloadFile(ref: FileRef, own: RelayEndpoint | null): Promise<Uint8Array> {
  const named = ref.relay === null ? null : { url: ref.relay.split("#")[0]!, cert_sha256: ref.relay.includes("#") ? ref.relay.split("#")[1]! : null };
  const endpoint = named ?? own;
  if (!endpoint) throw new Error("the reference names no relay, and no own relay was given");
  const answer = await relayRequest(endpoint, "GET", `/_file/${ref.id}`);
  if (answer.status === 404) throw new Error("the file is gone");
  if (answer.status !== 200) throw new Error(`the relay answered ${answer.status}`);
  return openFile(new Uint8Array(answer.body), ref);
}
