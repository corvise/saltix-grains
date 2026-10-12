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
  u8(): number {
    return this.take(1)[0]!;
  }
  u32(): number {
    return new DataView(this.take(4).buffer).getUint32(0, true);
  }
  u64(): bigint {
    return new DataView(this.take(8).buffer).getBigUint64(0, true);
  }
  fixed(size: number): Uint8Array {
    return this.take(size);
  }
  string(max: number): string {
    const n = this.u32();
    if (n > max) throw new TypeError("borsh: string too long");
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(n));
  }
  end(): void {
    if (this.at !== this.data.length) throw new TypeError("borsh: bytes left over");
  }
}
