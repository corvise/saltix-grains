// Where the command line reaches a network's wallet interface (Saltix 08-node §6): through relays it finds when it runs
// (41-transport §18.5: the project's cache of relays that answered, then the release's entry points, probed at once, then
// the tickets the fastest hand out, each confirmed by a second relay; every relay serves the interface at `POST /rpc`,
// pinned by the certificate its ticket names, 09-relay §10.7), through relays named on the command line, or through your
// own node.
import {
  type NetworkName, type NodeLike, RelayFinder, RelayGateways, checkGivenRelay, isTicketText, projectRelayCache, publicGateways,
  relayRequest,
} from "@saltix/grain-server";
import { UsageError } from "./args.js";

/** The network a command goes to unless told: Saltix's test network, of the devnet kind, the only one with relays to
 *  find yet. */
export const DEFAULT_NETWORK: NetworkName = "devnet";

const NETWORKS: readonly NetworkName[] = ["mainnet", "testnet", "devnet"];

/** A network's wallet interface as a command reaches it: `node` for the SDK's calls, `where` for people, and `flags`,
 *  the words that reach it again in a command the tool suggests (empty for the default). `gateways` is set when it goes
 *  through relays: where they came from and which answered (`report`), for `grain doctor`. */
export interface Reach {
  node: NodeLike;
  where: string;
  flags: string;
  gateways?: RelayGateways;
}

/** How a finder's events reach the command's log (`relaysLog`). */
export type RelayLog = (level: "info" | "warn", event: string, meta?: Record<string, unknown>) => void;

/** A finder's events as the command's steps (`.grain/log.jsonl`): `relays`, ok with how more were found, or failed with
 *  none answering; a ticket handed out and dropped, a ticket given and left out, each with its reason; the counts and
 *  times beside, never a relay's address. */
export function relaysLog(log: { step(step: string, outcome: "ok" | "failed" | "refused", reason?: string, numbers?: Record<string, unknown>): void }): RelayLog {
  return (_level, event, meta = {}) => {
    // The finder's own time as `took_ms`: the log's `ms` is the command's.
    const numbers = Object.fromEntries(Object.entries(meta).filter(([, v]) => typeof v === "number").map(([k, v]) => [k === "ms" ? "took_ms" : k, v]));
    if (event === "relays_found") log.step("relays", "ok", String(meta.discovery ?? "none"), numbers);
    else if (event === "relays_unreachable") log.step("relays", "failed", "none_answered", numbers);
    else if (event === "relay_ticket_dropped") log.step("relay_ticket", "refused", String(meta.reason));
    else if (event === "relay_given_skipped") {
      log.step("relay_given", "refused", String(meta.reason));
      // A relay the person gave, left out (a ticket past its life, or dated ahead): said where the person sees it, once
      // a run, whatever the command — the help promises it (the review of 2026-11-04: only doctor said it).
      const said = `${String(meta.relay ?? "?")}:${String(meta.reason)}`;
      if (!warned.has(said)) {
        warned.add(said);
        process.stderr.write(`warning: the ticket you gave for relay ${String(meta.relay ?? "?")} is left out (${String(meta.reason)}): give a fresh one\n`);
      }
    }
  };
}

/** The given relays already said left out in this run. */
const warned = new Set<string>();

/**
 * `--relay`'s value, checked as it is given: a relay ticket (`SALTIX-RELAY:…`, every check but its time — one past its
 * life is left out when the command runs, with a warning) or `wss://host:port/#<SHA-256 of its certificate>` (a host
 * name may go without it, behind a CA's certificate). Anything else is refused as `GivenRelayRefused`: the command exits
 * with 78, a configuration to fix.
 */
export function relayOf(text: string, position = 0): string {
  return checkGivenRelay(text, null, position);
}

/**
 * Where a command reaches the network: `--node URL` (your own node, plain HTTP); else the relays `--relay` names — a
 * person's tickets first, then the project's cache and the release's entry points as without them (41-transport §18.5:
 * the entry points are always tried), or relays of one's own named by `wss://…#<pin>` alone (a private network's, which
 * the release's relays are not of); else the relays of `--network` (by default `fallback`, the developer key's network or
 * devnet) found when the command runs, the relays that answered kept in the project's `.grain/relays.json`. `--node`
 * with `--relay` or `--network` is refused: one place answers.
 */
export function reachOf(flags: Map<string, string | true>, all: (name: string) => string[], fallback: NetworkName = DEFAULT_NETWORK,
  request = relayRequest, dir = process.cwd(), log?: RelayLog): Reach {
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
  const given = relays.map((r, i) => relayOf(r, i));
  const flagged = relays.map((r) => ` --relay ${r}`).join("");
  if (given.length > 0 && !given.some(isTicketText)) {
    // Relays of one's own alone (and those they hand out, confirmed by another of them): never the release's entry points
    // or the cache, which are another network's when the named relays are a private one's.
    const named = new RelayGateways([], request, { finder: new RelayFinder({ network: name, request, given, cache: null, entry: [], log }) });
    return { node: named, gateways: named, where: `the relays named (${relays.length})`, flags: flagged };
  }
  let gateways: RelayGateways;
  try {
    gateways = publicGateways(name, request, { given, cache: projectRelayCache(dir, name), log });
  } catch {
    throw new UsageError(`no relay is known for ${name}: pass --relay SALTIX-RELAY:… (a relay ticket), --relay wss://…#<pin> or --node URL (your node's wallet interface)`);
  }
  return {
    node: gateways,
    gateways,
    where: `${name === "devnet" ? "the test network's" : `${name}'s`} relays${given.length > 0 ? ` (and the tickets given, ${given.length})` : ""}`,
    flags: (network === undefined ? "" : ` --network ${name}`) + flagged,
  };
}
