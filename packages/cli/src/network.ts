// Where the command line reaches a network's wallet interface (Saltix 08-node §6): through the network's public relays
// by default (every relay serves it at `POST /rpc`, pinned by the certificate its relay record publishes, 09-relay
// §10.7), through relays named on the command line, or through your own node.
import { type NetworkName, type NodeLike, PUBLIC_RELAYS, RelayGateways, publicGateways, relayRequest } from "@saltix/grain-server";
import { UsageError } from "./args.js";

/** The network a command goes to unless told: Saltix's test network, of the devnet kind, the only one with public
 *  relays yet. */
export const DEFAULT_NETWORK: NetworkName = "devnet";

const NETWORKS: readonly NetworkName[] = ["mainnet", "testnet", "devnet"];

/** A network's wallet interface as a command reaches it: `node` for the SDK's calls, `where` for people, and `flags`,
 *  the words that reach it again in a command the tool suggests (empty for the default). */
export interface Reach {
  node: NodeLike;
  where: string;
  flags: string;
}

/** `wss://host:port/#<SHA-256 of its certificate>`: a relay's endpoint and pin, as a file reference names a relay. */
export function relayOf(text: string): { url: string; cert_sha256: string } {
  const hash = text.lastIndexOf("#");
  const url = hash < 0 ? text : text.slice(0, hash);
  const pin = hash < 0 ? "" : text.slice(hash + 1).toLowerCase();
  if (!/^wss:\/\/[^\s#]+$/.test(url) || !/^[0-9a-f]{64}$/.test(pin)) {
    throw new UsageError(`--relay ${text}: wss://host:port/#<the SHA-256 of its certificate, 64 hex>, as its relay record names it`);
  }
  return { url, cert_sha256: pin };
}

/**
 * Where a command reaches the network: `--node URL` (your own node, plain HTTP), else the relays `--relay` names (each
 * pinned), else the public relays of `--network` (by default `fallback`, the developer key's network or devnet), and the
 * relays they name. `--node` with `--relay` or `--network` is refused: one place answers.
 */
export function reachOf(flags: Map<string, string | true>, all: (name: string) => string[], fallback: NetworkName = DEFAULT_NETWORK,
  request = relayRequest): Reach {
  const node = flags.get("node");
  const network = flags.get("network");
  const relays = all("relay");
  if (node === true) throw new UsageError("--node URL: your node's wallet interface, such as http://127.0.0.1:30334");
  if (network === true) throw new UsageError(`--network: ${NETWORKS.join(", ")}`);
  if (typeof node === "string" && (relays.length > 0 || network !== undefined)) {
    throw new UsageError("--node, or --relay and --network: a command goes to one of them");
  }
  if (typeof node === "string") return { node, where: `the node at ${node}`, flags: ` --node ${node}` };
  if (network !== undefined && !NETWORKS.includes(network as NetworkName)) throw new UsageError(`--network ${network}: ${NETWORKS.join(", ")}`);
  const name = (network as NetworkName | undefined) ?? fallback;
  if (relays.length > 0) {
    const named = new RelayGateways(relays.map(relayOf), request, { discover: true });
    return { node: named, where: `the relays named (${relays.length})`, flags: relays.map((r) => ` --relay ${r}`).join("") };
  }
  if (PUBLIC_RELAYS[name].length === 0) {
    throw new UsageError(`no public relays are known for ${name}: pass --node URL (your node's wallet interface) or --relay wss://…#<pin>`);
  }
  return {
    node: publicGateways(name, request),
    where: `${name === "devnet" ? "the test network's" : `${name}'s`} public relays`,
    flags: network === undefined ? "" : ` --network ${name}`,
  };
}
