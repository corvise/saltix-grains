import { blake3 } from "@noble/hashes/blake3";

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `text` as bytes: lowercase hex of exactly `size` bytes when given. */
export function fromHex(text: string, size?: number): Uint8Array {
  if (!/^([0-9a-f]{2})*$/.test(text) || (size !== undefined && text.length !== 2 * size)) {
    throw new TypeError(size === undefined ? "lowercase hex expected" : `${size} bytes of lowercase hex expected`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Saltix's domain-separated hash: BLAKE3 derive_key with `context` over the parts (01-foundation). */
export function derive(context: string, ...parts: Uint8Array[]): Uint8Array {
  return blake3(concat(...parts), { context: new TextEncoder().encode(context) });
}

/** Borsh as the Saltix node writes it. */
export class Writer {
  private chunks: Uint8Array[] = [];
  u8(n: number): this {
    this.chunks.push(Uint8Array.of(n & 0xff));
    return this;
  }
  u16(n: number): this {
    this.chunks.push(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff));
    return this;
  }
  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.chunks.push(b);
    return this;
  }
  u64(n: bigint | number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    this.chunks.push(b);
    return this;
  }
  fixed(bytes: Uint8Array, size: number): this {
    if (bytes.length !== size) throw new TypeError(`${size} bytes expected`);
    this.chunks.push(bytes);
    return this;
  }
  bytes(bytes: Uint8Array): this {
    return this.u32(bytes.length).raw(bytes);
  }
  string(text: string): this {
    return this.bytes(new TextEncoder().encode(text));
  }
  raw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }
  i64(n: bigint): this {
    if (n < -(2n ** 63n) || n >= 2n ** 63n) throw new TypeError("an i64 is out of range");
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, n, true);
    this.chunks.push(b);
    return this;
  }
  bool(b: boolean): this {
    return this.u8(b ? 1 : 0);
  }
  /** `Option<T>`: 0, or 1 and the value. */
  option<T>(value: T | null | undefined, write: (w: this, v: T) => unknown): this {
    if (value === null || value === undefined) return this.u8(0);
    this.u8(1);
    write(this, value);
    return this;
  }
  done(): Uint8Array {
    return concat(...this.chunks);
  }
}

export class Reader {
  private at = 0;
  constructor(private readonly data: Uint8Array) {}
  private take(n: number): Uint8Array {
    if (this.at + n > this.data.length) throw new TypeError("borsh: short input");
    return this.data.slice(this.at, (this.at += n));
  }
  /** Where the next read starts. */
  get position(): number {
    return this.at;
  }
  /** The bytes from `start` to the current position: what was read since. */
  since(start: number): Uint8Array {
    return this.data.slice(start, this.at);
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u16(): number {
    return new DataView(this.take(2).buffer).getUint16(0, true);
  }
  u32(): number {
    return new DataView(this.take(4).buffer).getUint32(0, true);
  }
  u64(): bigint {
    return new DataView(this.take(8).buffer).getBigUint64(0, true);
  }
  i64(): bigint {
    return new DataView(this.take(8).buffer).getBigInt64(0, true);
  }
  /** A u64 that is a time, a size or seconds, as a number: refused above 2^53 - 1, where numbers stop being exact. */
  u64n(): number {
    const n = this.u64();
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("borsh: a u64 beyond 2^53");
    return Number(n);
  }
  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new TypeError("borsh: bad bool");
    return b === 1;
  }
  /** `Option<T>`: null for 0, the value for 1, refused otherwise. */
  option<T>(read: (r: this) => T): T | null {
    const tag = this.u8();
    if (tag > 1) throw new TypeError("borsh: bad option");
    return tag === 1 ? read(this) : null;
  }
  /** A `Vec<T>` of at most `max` items. */
  vec<T>(read: (r: this) => T, max = Number.MAX_SAFE_INTEGER): T[] {
    const n = this.u32();
    if (n > max) throw new TypeError("borsh: too many items");
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(read(this));
    return out;
  }
  fixed(size: number): Uint8Array {
    return this.take(size);
  }
  /** A UTF-8 string of at most `max` bytes (by default, what is left). */
  string(max = this.data.length - this.at): string {
    const n = this.u32();
    if (n > max) throw new TypeError("borsh: string too long");
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(n));
  }
  end(): void {
    if (this.at !== this.data.length) throw new TypeError("borsh: bytes left over");
  }
}

/** Rust's order of strings: their UTF-8 bytes compared (JavaScript's `<` compares UTF-16 units, which differs above
 *  U+FFFF). Negative, zero or positive. */
export function compareUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding, or (`url`) base64url without it. Works without Node's `Buffer`. */
export function toBase64(bytes: Uint8Array, url = false): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [n >>> 18, (n >>> 12) & 63, (n >>> 6) & 63, n & 63].map((c) => B64[c]!);
    const left = bytes.length - i;
    out += chars.slice(0, left === 1 ? 2 : left === 2 ? 3 : 4).join("") + (url ? "" : left === 1 ? "==" : left === 2 ? "=" : "");
  }
  return url ? out.replace(/\+/g, "-").replace(/\//g, "_") : out;
}

/**
 * Base64 back to bytes: standard with its padding (`url` false: exactly the canonical form, as Rust's `STANDARD`
 * takes it), or base64url with or without padding (as relays send it).
 */
export function fromBase64(text: string, url = false): Uint8Array {
  const ok = url ? /^[A-Za-z0-9_-]*={0,2}$/.test(text) : /^[A-Za-z0-9+/]*={0,2}$/.test(text) && text.length % 4 === 0;
  if (!ok) throw new TypeError(url ? "base64url expected" : "base64 expected");
  const body = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (body.length % 4 === 1) throw new TypeError("base64: bad length");
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (const c of body) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >>> bits) & 0xff;
    }
  }
  // Canonical only: no stray bits after the last byte, and standard base64 written back the same.
  if ((acc & ((1 << bits) - 1)) !== 0 || (!url && toBase64(out) !== text)) throw new TypeError("base64: not canonical");
  return out;
}
