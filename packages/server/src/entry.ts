// The release's entry points (Saltix 41-transport §18.6): the relays the SDK tries last, when nothing it was given or
// cached answers. They are obfuscated, never listed: XOR with a SHAKE-256 stream of "Salarium relay entry v1", a zero byte
// and the network's name. That stops a search of the package for addresses and nothing more — whoever runs
// `entryPoints` reads them — so they are few, change with each release, and are the last resort, never what makes the
// SDK work. Saltix's `scripts/set-network.py` writes `ENTRY` from the relays the apps' pins name, and its `--check` holds
// it to them in CI: never edit it by hand.
import { createHash } from "node:crypto";
import type { NetworkName } from "./address.js";
import { concat, fromBase64, toBase64 } from "./bytes.js";

/** The stream's domain. */
export const ENTRY_DOMAIN = "Salarium relay entry v1";

/** By network: base64 of the entries, one a line (an endpoint `wss://host:port/#<pin>` or a ticket), XOR the stream. */
const ENTRY: Readonly<Record<NetworkName, string>> = {
  mainnet: "",
  testnet: "",
  devnet:
    "lpPpdDF1SXwQ/jK4qLFaG0dDj5oRT9R6D9zZEPPl8/RSvDTY/IXn9g0Yl838Uhoisk0XqPEueCM4jkKxBNc9lu6XRLKnZ1qykEY7BhIltJHoqz+XnEZ/zEmJZ2pV72kOUKnOaW5wJFcanKjzhpBmqSS2Hk8IaNFjD0At/+cIJ7fpajnTPnH97ZEbOQF4dCX7koCp7p0Itc2kgGCfV6viLpnyr+qvHbIF37ynPIwNcsvIda8I3NE9bGZuRWKcIliEFzQ8cAv9znSDekFgXR/B9UrX8Keq+wkKL8L9qvSkVs3mtbCvhRHNMRExJfqtyto60g1/fVbyWC70v8ukjE/qfARULzAvFPOHP0lqcmzlnF0pfcq9UA==",
};

/** `length` bytes of the stream of `network`. */
function stream(network: string, length: number): Uint8Array {
  const seed = concat(new TextEncoder().encode(ENTRY_DOMAIN), Uint8Array.of(0), new TextEncoder().encode(network));
  return new Uint8Array(createHash("shake256", { outputLength: length }).update(seed).digest());
}

const xor = (bytes: Uint8Array, network: string) => {
  const key = stream(network, bytes.length);
  return bytes.map((b, i) => b ^ key[i]!);
};

/** `lines` as `ENTRY` holds them for `network` (what set-network.py writes; for tests). */
export function obfuscateEntries(network: string, lines: readonly string[]): string {
  return lines.length === 0 ? "" : toBase64(xor(new TextEncoder().encode(lines.join("\n")), network));
}

/** The lines `blob` holds for `network`. */
export function revealEntries(network: string, blob: string): string[] {
  if (blob === "") return [];
  return new TextDecoder().decode(xor(fromBase64(blob), network)).split("\n").filter((l) => l !== "");
}

/** The entry points of `network` this release carries: endpoints with their pins, or tickets; none for a network whose
 *  relays this release does not know. */
export function entryPoints(network: NetworkName): string[] {
  return revealEntries(network, ENTRY[network]);
}
