import { derive } from "./bytes.js";

/**
 * Salarium's address: one 20-byte id in two spellings — `Bech32m(prefix, q ‖ id)` for people, `0x…` for EVM tools —, the
 * id the first 20 bytes of `derive("Salarium address v1", [kind] ‖ material)`. The kind enters the derivation only: the
 * symbol after the separator is always `q`.
 */
export type NetworkName = "mainnet" | "testnet" | "devnet";

/** An account id's bytes. */
export const ID_BYTES = 20;

const PREFIX: Record<NetworkName, string> = { mainnet: "salt", testnet: "tsalt", devnet: "dsalt" };
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M = 0x2bc830a3;

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  return [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
}

function convert(data: Uint8Array | number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max) !== 0) {
    return null;
  }
  return out;
}

/** The id of the account a key of `kind` (0: personal) controls: the first 20 bytes of its derivation. */
export function accountId(publicKey: Uint8Array, kind = 0): Uint8Array {
  return derive("Salarium address v1", Uint8Array.of(kind), publicKey).slice(0, ID_BYTES);
}

/** The address of the account `id` on `network`: `q` and the id, whatever kind made it. */
export function encodeAddress(network: NetworkName, id: Uint8Array): string {
  if (id.length !== ID_BYTES) throw new TypeError(`an account id is ${ID_BYTES} bytes`);
  const hrp = PREFIX[network];
  const data = [0, ...convert(id, 8, 5, true)!];
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

/** What `address` names, or null when it is not an address of v1. */
export function decodeAddress(address: string): { network: NetworkName; kind: number; id: Uint8Array } | null {
  const text = address.toLowerCase();
  if (text !== address && address.toUpperCase() !== address) return null;
  const sep = text.lastIndexOf("1");
  if (sep < 1) return null;
  const hrp = text.slice(0, sep);
  const network = (Object.keys(PREFIX) as NetworkName[]).find((n) => PREFIX[n] === hrp);
  if (!network) return null;
  const data = [...text.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.length < 8 || data.some((d) => d < 0)) return null;
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M) return null;
  const payload = data.slice(0, -6);
  if (payload[0] !== 0) return null;
  const bytes = convert(payload.slice(1), 5, 8, false);
  if (!bytes || bytes.length !== ID_BYTES) return null;
  return { network, kind: 0, id: Uint8Array.from(bytes) };
}
