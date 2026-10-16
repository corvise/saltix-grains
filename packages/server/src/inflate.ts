// Raw DEFLATE (RFC 1951) decoding in plain TypeScript, for any runtime: what a publishing link's manifest needs
// (Saltix 12-grains §10), in a server and in the simulator alike. A port of zlib's puff.c by Mark Adler: small and
// strict rather than fast, for the few kilobytes a manifest is. Writing goes through Node's zlib (`publish-link.ts`).

const MAXBITS = 15;
const MAXLCODES = 286;
const MAXDCODES = 30;
const FIXLCODES = 288;

/** Lengths and distances: a base and the extra bits that follow (§3.2.5). */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
  12289, 16385, 24577,
];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order the code lengths' code lengths come in (§3.2.7). */
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

const huffman = (symbols: number): Huffman => ({ count: new Uint16Array(MAXBITS + 1), symbol: new Uint16Array(symbols) });

/** Why a stream does not inflate: never thrown out of `inflateRaw`. */
class Malformed extends Error {}

class Stream {
  readonly out: Uint8Array;
  outAt = 0;
  inAt = 0;
  private bitBuf = 0;
  private bitCount = 0;
  constructor(readonly input: Uint8Array, max: number) {
    this.out = new Uint8Array(max);
  }

  /** `need` bits (at most 16), the first in the lowest bit. */
  bits(need: number): number {
    let value = this.bitBuf;
    while (this.bitCount < need) {
      if (this.inAt >= this.input.length) throw new Malformed("the stream ends early");
      value |= this.input[this.inAt++]! << this.bitCount;
      this.bitCount += 8;
    }
    this.bitBuf = value >>> need;
    this.bitCount -= need;
    return value & ((1 << need) - 1);
  }

  /** Drop what is left of the current byte: a stored block starts at a byte. */
  align(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  put(byte: number): void {
    if (this.outAt >= this.out.length) throw new Malformed("past the limit");
    this.out[this.outAt++] = byte;
  }
}

/** The symbol of the next code: bit by bit, as puff decodes. */
function decode(s: Stream, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAXBITS; len++) {
    code |= s.bits(1);
    const count = h.count[len]!;
    if (code - count < first) return h.symbol[index + (code - first)]!;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Malformed("no such code");
}

/** Make `h` from the code lengths of `n` symbols: 0 for a complete code, more for an incomplete one, less for one
 *  over-subscribed. */
function construct(h: Huffman, lengths: ArrayLike<number>, n: number): number {
  h.count.fill(0);
  for (let sym = 0; sym < n; sym++) h.count[lengths[sym]!]!++;
  if (h.count[0] === n) return 0;
  let left = 1;
  for (let len = 1; len <= MAXBITS; len++) {
    left = (left << 1) - h.count[len]!;
    if (left < 0) return left;
  }
  const offsets = new Uint16Array(MAXBITS + 1);
  for (let len = 1; len < MAXBITS; len++) offsets[len + 1] = offsets[len]! + h.count[len]!;
  for (let sym = 0; sym < n; sym++) if (lengths[sym] !== 0) h.symbol[offsets[lengths[sym]!]!++] = sym;
  return left;
}

function stored(s: Stream): void {
  s.align();
  const at = s.inAt;
  if (at + 4 > s.input.length) throw new Malformed("the stream ends early");
  const len = s.input[at]! | (s.input[at + 1]! << 8);
  if (s.input[at + 2] !== (~len & 0xff) || s.input[at + 3] !== ((~len >> 8) & 0xff)) throw new Malformed("a stored block's length");
  s.inAt = at + 4;
  if (s.inAt + len > s.input.length) throw new Malformed("the stream ends early");
  for (let i = 0; i < len; i++) s.put(s.input[s.inAt++]!);
}

function codes(s: Stream, lencode: Huffman, distcode: Huffman): void {
  for (;;) {
    const symbol = decode(s, lencode);
    if (symbol < 256) {
      s.put(symbol);
    } else if (symbol === 256) {
      return;
    } else {
      const l = symbol - 257;
      if (l >= 29) throw new Malformed("a length code");
      const len = LBASE[l]! + s.bits(LEXT[l]!);
      const d = decode(s, distcode);
      if (d >= 30) throw new Malformed("a distance code");
      const dist = DBASE[d]! + s.bits(DEXT[d]!);
      if (dist > s.outAt) throw new Malformed("a distance before the start");
      for (let i = 0; i < len; i++) s.put(s.out[s.outAt - dist]!);
    }
  }
}

let fixedCodes: { lencode: Huffman; distcode: Huffman } | null = null;

function fixed(s: Stream): void {
  if (!fixedCodes) {
    const lengths = new Uint8Array(FIXLCODES);
    lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, FIXLCODES);
    const lencode = huffman(FIXLCODES);
    construct(lencode, lengths, FIXLCODES);
    const distcode = huffman(MAXDCODES);
    construct(distcode, new Uint8Array(MAXDCODES).fill(5), MAXDCODES);
    fixedCodes = { lencode, distcode };
  }
  codes(s, fixedCodes.lencode, fixedCodes.distcode);
}

function dynamic(s: Stream): void {
  const nlen = s.bits(5) + 257;
  const ndist = s.bits(5) + 1;
  const ncode = s.bits(4) + 4;
  if (nlen > MAXLCODES || ndist > MAXDCODES) throw new Malformed("too many codes");
  const lengths = new Uint8Array(MAXLCODES + MAXDCODES);
  for (let i = 0; i < ncode; i++) lengths[ORDER[i]!] = s.bits(3);
  const lencode = huffman(MAXLCODES);
  const distcode = huffman(MAXDCODES);
  if (construct(lencode, lengths, 19) !== 0) throw new Malformed("the code lengths' code");
  let index = 0;
  while (index < nlen + ndist) {
    let symbol = decode(s, lencode);
    if (symbol < 16) {
      lengths[index++] = symbol;
      continue;
    }
    let len = 0;
    if (symbol === 16) {
      if (index === 0) throw new Malformed("a repeat with nothing before it");
      len = lengths[index - 1]!;
      symbol = 3 + s.bits(2);
    } else if (symbol === 17) {
      symbol = 3 + s.bits(3);
    } else {
      symbol = 11 + s.bits(7);
    }
    if (index + symbol > nlen + ndist) throw new Malformed("too many lengths");
    while (symbol-- > 0) lengths[index++] = len;
  }
  if (lengths[256] === 0) throw new Malformed("no end of block");
  // An incomplete code is taken only when it is a single code of one bit.
  let left = construct(lencode, lengths, nlen);
  if (left < 0 || (left > 0 && nlen - lencode.count[0]! !== 1)) throw new Malformed("the literal/length code");
  left = construct(distcode, lengths.subarray(nlen), ndist);
  if (left < 0 || (left > 0 && ndist - distcode.count[0]! !== 1)) throw new Malformed("the distance code");
  codes(s, lencode, distcode);
}

/**
 * The bytes the raw DEFLATE stream `input` holds, or null: when it is not one, inflates past `max` bytes, or anything
 * follows its last block (the bits that fill the last byte excepted).
 */
export function inflateRaw(input: Uint8Array, max: number): Uint8Array | null {
  const s = new Stream(input, max);
  try {
    let last = 0;
    while (last === 0) {
      last = s.bits(1);
      const type = s.bits(2);
      if (type === 0) stored(s);
      else if (type === 1) fixed(s);
      else if (type === 2) dynamic(s);
      else throw new Malformed("block type 3");
    }
  } catch (e) {
    if (e instanceof Malformed) return null;
    throw e;
  }
  return s.inAt === input.length ? s.out.slice(0, s.outAt) : null;
}
