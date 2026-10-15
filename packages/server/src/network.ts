// How a grain's server reaches its network with nothing but a developer key (Saltix 24-app-studio §3): the network's
// public relays, each trusted only with the certificate its relay record pins (09-relay §10.7: every relay serves the
// node's wallet interface at `POST /rpc` on its client port), the relays they know of (`relay_list`), and a view of the
// chain the server reads its grain's registry record and its members' keys from, cached per tip.
import type { NetworkName } from "./address.js";
import type { Controller } from "./member.js";
import { NOT_FOLLOWED, RpcError, rpc } from "./node.js";
import type { RegisteredGrain } from "./registry.js";
import { type RelayEndpoint, usableEndpoint } from "./relay.js";
import { relayRequest } from "./upload.js";

/**
 * The public relays a server starts from on each kind of network, before it asks them for the rest (`relay_list`):
 * their client endpoints and the SHA-256 of the self-signed certificate each relay's record publishes. Saltix's test
 * network is of the devnet kind (`dsalt1…`); its relays keep their certificates across the network's resets. No public
 * mainnet or testnet runs yet. A server on another network passes `node` or `endpoints`.
 */
export const PUBLIC_RELAYS: Readonly<Record<NetworkName, readonly RelayEndpoint[]>> = {
  mainnet: [],
  testnet: [],
  devnet: [
    { url: "wss://138.124.52.41:30335/", cert_sha256: "dc1ece5e64b22d087d85659a325191b667bdb1c3547e6095504385816b85bb3f" },
    { url: "wss://45.141.177.244:30335/", cert_sha256: "3c3d43b9a2f9c7448d7a6714ef6a11f31b5c82a535724aabb36d6e6ee7ef8449" },
    { url: "wss://85.192.42.65:30335/", cert_sha256: "a94187bc36785212e149f6d32a6cd01633712ac0c9b1bc900ebacda23d4e8fad" },
  ],
};

/** A node's wallet interface (08-node §6), however it is reached. */
export interface WalletInterface {
  call<T>(method: string, params?: object): Promise<T>;
}

/** Your own node's wallet interface over plain HTTP (a local node or a tunnel). */
export function nodeInterface(url: string): WalletInterface {
  return { call: <T>(method: string, params: object = {}) => rpc<T>(url, method, params) };
}

type Request = typeof relayRequest;

/**
 * The wallet interface through the relays' gateways (09-relay §10.7), over each relay's pinned certificate: a call goes
 * to the relay that answered last, then to the others in turn. A node's answer is final, except that it does not follow
 * the account's shard (another relay's node may); a relay that does not answer, or answers with an HTTP error (`429`,
 * say), is passed over.
 */
export class RelayGateways implements WalletInterface {
  private list: RelayEndpoint[] = [];
  private good = 0;

  constructor(endpoints: readonly RelayEndpoint[], private readonly request: Request = relayRequest) {
    this.add(endpoints);
  }

  /** The relays it calls. */
  get endpoints(): RelayEndpoint[] {
    return [...this.list];
  }

  /** Relays to call besides: `wss://` ones pinned by their record's certificate, each once. */
  add(endpoints: readonly RelayEndpoint[]): void {
    for (const e of endpoints) {
      if (!e.url.startsWith("wss://") || e.cert_sha256 === null || !usableEndpoint(e)) continue;
      if (!this.list.some((x) => x.url === e.url)) this.list.push({ url: e.url, cert_sha256: e.cert_sha256.toLowerCase() });
    }
  }

  async call<T>(method: string, params: object = {}): Promise<T> {
    if (this.list.length === 0) throw new Error(`${method}: no relay to ask`);
    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    const failures: string[] = [];
    for (let i = 0; i < this.list.length; i++) {
      const at = (this.good + i) % this.list.length;
      const endpoint = this.list[at]!;
      let answer;
      try {
        answer = await this.request(endpoint, "POST", "/rpc", { "content-type": "application/json" }, body);
      } catch (e) {
        failures.push(`${endpoint.url}: ${(e as Error).message}`);
        continue;
      }
      if (answer.status !== 200) {
        failures.push(`${endpoint.url}: HTTP ${answer.status}`);
        continue;
      }
      let reply: { result?: T; error?: { code: number; message: string } };
      try {
        reply = JSON.parse(new TextDecoder().decode(answer.body)) as typeof reply;
      } catch {
        failures.push(`${endpoint.url}: not JSON`);
        continue;
      }
      if (reply.error) {
        if (reply.error.code === NOT_FOLLOWED) {
          failures.push(`${endpoint.url}: ${reply.error.message}`);
          continue;
        }
        throw new RpcError(method, reply.error.code, reply.error.message);
      }
      this.good = at;
      return reply.result as T;
    }
    throw new Error(`${method}: no relay answered (${failures.join("; ")})`);
  }
}

/** What `node_status` says, as far as a grain's server reads it. */
export interface NodeStatus {
  network: string;
  genesis: string;
  slot: number;
  beacon: { height: number; hash: string };
  shards?: Array<{ shard: string; hash: string }>;
}

/** The relays a node knows (`relay_list`): their usable endpoints. */
export async function relaysOf(node: WalletInterface): Promise<RelayEndpoint[]> {
  const { relays } = await node.call<{ relays: Array<{ endpoints: RelayEndpoint[] }> }>("relay_list");
  return relays.flatMap((r) => r.endpoints).filter(usableEndpoint);
}

const STATUS_MS = 2_000;
const MAX_ACCOUNTS = 1_024;

/**
 * A grain server's view of the chain: the node's status for at most 2 seconds, a grain's registry record while the
 * beacon chain's tip is the same (the registry lives there), and an account's keys while its shard's tip is. So a
 * member removed, a key replaced or a device dropped takes effect with the block that does it.
 */
export class ChainView {
  private status: { at: number; value: NodeStatus } | null = null;
  private readonly grains = new Map<string, { tip: string; value: RegisteredGrain | null }>();
  private readonly accounts = new Map<string, { tip: string; shard: string; controller: Controller | null }>();

  constructor(readonly node: WalletInterface, private readonly clock: () => number = Date.now) {}

  /** The node's status, at most 2 seconds old (`fresh`: asked now). */
  async nodeStatus(fresh = false): Promise<NodeStatus> {
    const now = this.clock();
    if (!fresh && this.status && now - this.status.at < STATUS_MS && now >= this.status.at) return this.status.value;
    const value = await this.node.call<NodeStatus>("node_status");
    this.status = { at: now, value };
    return value;
  }

  /** The registry's record of `slug` at the beacon chain's tip (`fresh`: the status asked now), or null. */
  async grain(slug: string, fresh = false): Promise<RegisteredGrain | null> {
    const tip = (await this.nodeStatus(fresh)).beacon.hash;
    const known = this.grains.get(slug);
    if (known && known.tip === tip) return known.value;
    const { grain } = await this.node.call<{ grain: RegisteredGrain | null }>("grain_get", { slug });
    this.grains.set(slug, { tip, value: grain });
    return grain;
  }

  /** The controller of `account` (hex) at its shard's tip: null for an account that has none, so that only its own key
   *  speaks for it. */
  async controller(account: string): Promise<Controller | null> {
    const status = await this.nodeStatus();
    const tipOf = (shard: string) => status.shards?.find((s) => s.shard === shard)?.hash ?? status.beacon.hash;
    const known = this.accounts.get(account);
    if (known && known.tip === tipOf(known.shard)) return known.controller;
    const a = await this.node.call<{ shard?: string; controller: Controller | null }>("account_get", { address: account });
    const shard = a.shard ?? "";
    if (this.accounts.size >= MAX_ACCOUNTS && !this.accounts.has(account)) this.accounts.delete(this.accounts.keys().next().value!);
    this.accounts.set(account, { tip: tipOf(shard), shard, controller: a.controller ?? null });
    return a.controller ?? null;
  }
}
