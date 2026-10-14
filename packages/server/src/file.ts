// A file kept next to a relay, as a message points at it (Saltix 09-relay §10.5.2): the endpoint, the id, the
// AES-256-GCM key and nonce, and what the plaintext is. Borsh inside signed structures (a chat's `File` block, a
// `File` argument), JSON in Saltix's own chat messages. Byte for byte vectors/grain-chats-v1.json.
//
// No Node APIs here: the simulator runs it in a browser. Sealing and opening use WebCrypto, which Node has too.
import { sha256 } from "@noble/hashes/sha256";
import { Reader, Writer, fromBase64, fromHex, toBase64, toHex } from "./bytes.js";

/** Plaintext bytes a file may have (09-relay §10.5). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** The AEAD tag at the end of the ciphertext. */
export const FILE_TAG_BYTES = 16;

export interface FileRef {
  /** `wss://…` with `#<cert_sha256 hex>` when the endpoint pins a certificate; null: the reader's own relay. */
  relay: string | null;
  /** The relay's id of the file: 22 characters of base64url. */
  id: string;
  /** The AES-256-GCM key, 32 bytes of hex. */
  key: string;
  /** Its nonce, 12 bytes of hex. */
  iv: string;
  /** SHA-256 of the plaintext, 32 bytes of hex. */
  hash: string;
  /** Plaintext bytes, at most `MAX_FILE_BYTES`. */
  size: number;
  /** At most 255 bytes, no control characters, no `/` or `\`. */
  name: string;
  /** A media type, at most 127 bytes. */
  mime: string;
}

export type FileRefProblem = "relay" | "id" | "size" | "name" | "mime";

const utf8 = (text: string) => new TextEncoder().encode(text).length;
const MIME_TOKEN = /^[A-Za-z0-9!#$&\-^_.+]+$/;

/** What is out of bounds in `f` (09-relay §10.5.2), or null. */
export function fileRefProblem(f: FileRef): FileRefProblem | null {
  if (f.relay !== null) {
    const hash = f.relay.indexOf("#");
    const url = hash < 0 ? f.relay : f.relay.slice(0, hash);
    const pin = hash < 0 ? null : f.relay.slice(hash + 1);
    const pinOk = pin === null || /^[0-9a-f]{64}$/.test(pin);
    const urlOk = url.length > "wss://".length && utf8(url) <= 512 && url.startsWith("wss://") && !/[\p{Cc}\p{White_Space}]/u.test(url);
    if (!(urlOk && pinOk)) return "relay";
  }
  if (!/^[A-Za-z0-9_-]{22}$/.test(f.id)) return "id";
  if (!Number.isSafeInteger(f.size) || f.size < 1 || f.size > MAX_FILE_BYTES) return "size";
  if (f.name.length === 0 || utf8(f.name) > 255 || /[\p{Cc}/\\]/u.test(f.name)) return "name";
  const slash = f.mime.indexOf("/");
  const mimeOk = utf8(f.mime) <= 127 && slash >= 0 && MIME_TOKEN.test(f.mime.slice(0, slash)) && MIME_TOKEN.test(f.mime.slice(slash + 1));
  return mimeOk ? null : "mime";
}

export function writeFileRef(w: Writer, f: FileRef): Writer {
  return w
    .option(f.relay, (w, relay) => w.string(relay))
    .string(f.id)
    .fixed(fromHex(f.key, 32), 32)
    .fixed(fromHex(f.iv, 12), 12)
    .fixed(fromHex(f.hash, 32), 32)
    .u64(f.size)
    .string(f.name)
    .string(f.mime);
}

export function readFileRef(r: Reader): FileRef {
  return {
    relay: r.option((r) => r.string()),
    id: r.string(),
    key: toHex(r.fixed(32)),
    iv: toHex(r.fixed(12)),
    hash: toHex(r.fixed(32)),
    size: r.u64n(),
    name: r.string(),
    mime: r.string(),
  };
}

export const encodeFileRef = (f: FileRef): Uint8Array => writeFileRef(new Writer(), f).done();

export function decodeFileRef(bytes: Uint8Array): FileRef {
  const r = new Reader(bytes);
  const f = readFileRef(r);
  r.end();
  return f;
}

/** The JSON form a Saltix chat message carries: `{"cmd": "file_ref", …}`, key and iv in standard base64. */
export function fileRefToJson(f: FileRef): Record<string, string | number> {
  const json: Record<string, string | number> = {
    cmd: "file_ref", id: f.id, key: toBase64(fromHex(f.key, 32)), iv: toBase64(fromHex(f.iv, 12)), hash: f.hash, size: f.size,
    name: f.name, mime: f.mime,
  };
  if (f.relay !== null) json.relay = f.relay;
  return json;
}

/** The JSON form read back and checked; throws a `TypeError` naming the field or the bound it breaks. */
export function fileRefFromJson(value: unknown): FileRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("file_ref: an object expected");
  const o = value as Record<string, unknown>;
  const text = (name: string) => {
    if (typeof o[name] !== "string") throw new TypeError(`file_ref: ${name}`);
    return o[name] as string;
  };
  const bytes = (name: string, size: number) => {
    let b: Uint8Array;
    try {
      b = fromBase64(text(name));
    } catch {
      throw new TypeError(`file_ref: ${name}`);
    }
    if (b.length !== size) throw new TypeError(`file_ref: ${name}`);
    return toHex(b);
  };
  if (text("cmd") !== "file_ref") throw new TypeError("file_ref: cmd");
  if (o.relay !== undefined && o.relay !== null && typeof o.relay !== "string") throw new TypeError("file_ref: relay");
  if (!/^[0-9a-fA-F]{64}$/.test(text("hash"))) throw new TypeError("file_ref: hash");
  if (typeof o.size !== "number" || !Number.isSafeInteger(o.size) || o.size < 0) throw new TypeError("file_ref: size");
  const f: FileRef = {
    relay: (o.relay as string | null | undefined) ?? null,
    id: text("id"),
    key: bytes("key", 32),
    iv: bytes("iv", 12),
    hash: text("hash").toLowerCase(),
    size: o.size,
    name: text("name"),
    mime: text("mime"),
  };
  const problem = fileRefProblem(f);
  if (problem) throw new TypeError(`file_ref: ${problem}`);
  return f;
}

/** The endpoint a reference names, as `relay_list` gives it, or null for the reader's own relay. */
export function fileRefEndpoint(f: FileRef): { url: string; cert_sha256: string | null } | null {
  if (f.relay === null) return null;
  const hash = f.relay.indexOf("#");
  return hash < 0 ? { url: f.relay, cert_sha256: null } : { url: f.relay.slice(0, hash), cert_sha256: f.relay.slice(hash + 1) };
}

/** What a reference names a relay endpoint by: its URL, then `#` and the pinned certificate's SHA-256. Only `wss://`
 *  endpoints are named; a plain `ws://` one (a developer's relay on loopback) gives null, the reader's own relay. */
export function relayOfEndpoint(endpoint: { url: string; cert_sha256: string | null }): string | null {
  if (!endpoint.url.startsWith("wss://")) return null;
  return endpoint.cert_sha256 ? `${endpoint.url}#${endpoint.cert_sha256.toLowerCase()}` : endpoint.url;
}

function subtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available");
  return s;
}

/** A copy WebCrypto takes (it wants bytes over a plain `ArrayBuffer`). */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

function random(size: number): Uint8Array {
  return (globalThis as { crypto: Crypto }).crypto.getRandomValues(new Uint8Array(size));
}

/** A file sealed for a relay: AES-256-GCM under a fresh key and nonce, the tag at the end. */
export interface SealedFile {
  ciphertext: Uint8Array;
  key: string;
  iv: string;
  hash: string;
  size: number;
}

/** Seal `plaintext` (1 byte to 50 MiB) under a fresh key: the ciphertext a relay keeps, and what its reference names. */
export async function sealFile(plaintext: Uint8Array): Promise<SealedFile> {
  if (plaintext.length < 1 || plaintext.length > MAX_FILE_BYTES) throw new RangeError("a file is 1 byte to 50 MiB");
  const key = random(32);
  const iv = random(12);
  const aes = await subtle().importKey("raw", own(key), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: own(iv) }, aes, own(plaintext)));
  return { ciphertext, key: toHex(key), iv: toHex(iv), hash: toHex(sha256(plaintext)), size: plaintext.length };
}

/** The plaintext of `ciphertext` that `f` names, checked against its size and hash; throws when it is not that file. */
export async function openFile(ciphertext: Uint8Array, f: FileRef): Promise<Uint8Array> {
  if (ciphertext.length !== f.size + FILE_TAG_BYTES) throw new Error("the file is not the size its reference names");
  const aes = await subtle().importKey("raw", own(fromHex(f.key, 32)), "AES-GCM", false, ["decrypt"]);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: own(fromHex(f.iv, 12)) }, aes, own(ciphertext)));
  } catch {
    throw new Error("the file does not open under its reference's key");
  }
  if (toHex(sha256(plaintext)) !== f.hash) throw new Error("the file's hash is not the one its reference names");
  return plaintext;
}
