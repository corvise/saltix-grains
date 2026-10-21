// How a grain's server reaches its network with nothing but a developer key (Saltix 24-app-studio §3): the network's
// public relays, each trusted only with the certificate its relay record pins (09-relay §10.7: every relay serves the
// node's wallet interface at `POST /rpc` on its client port), the relays they know of (`relay_list`), and a view of the
// chain the server reads its grain's registry record and its members' keys from, cached per tip.
import { type AccessCredential, AccessRefused, accessReasonOf, accessToken } from "./access.js";
import type { NetworkName } from "./address.js";
import { fromHex } from "./bytes.js";
import type { Controller } from "./member.js";
import { RpcError, nodeOnly, rpc } from "./node.js";
import type { RegisteredGrain } from "./registry.js";
import { toBase64Url } from "./records.js";
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

/** The wallet interface's calls a relay whose node runs a gate takes only with an access token (37-gate §5, 09-relay
 *  §10.7): every read stays open. */
export const ACCESS_METHODS: ReadonlySet<string> = new Set(["transaction_submit", "faucet_request"]);

/** The JSON-RPC error of a write refused for its access (`-32001`, message `"access"`, `data: {access: <reason>}`). */
export const ACCESS_ERROR = -32001;

/** Where a relay's wallet interface refused a write for its access, its word; null for any other answer. */
function accessRefusalOf(status: number, body: Uint8Array): AccessRefused | null {
  if (status !== 401) return null;
  try {
    const reply = JSON.parse(new TextDecoder().decode(body)) as { error?: { code?: unknown; message?: unknown; data?: { access?: unknown } } };
    if (reply.error?.code !== ACCESS_ERROR || reply.error.message !== "access") return null;
    return new AccessRefused(accessReasonOf(reply.error.data?.access ?? "required"));
  } catch {
    return null;
  }
}

/** How `RelayGateways` finds relays besides those it starts from. */
export interface GatewayOptions {
  /**
   * Ask `relay_list` once when the relays known cannot answer a call (none answers, or none's node follows the
   * account's shard or runs a faucet), then try the relays it names: each pinned by its record's certificate, which
   * replaces an older pin for the same endpoint. Off by default.
   */
  discover?: boolean;
  /** The access a write shows where a relay requires one (`useAccess`). */
  access?: () => Promise<AccessCredential>;
}

/**
 * The wallet interface through the relays' gateways (09-relay §10.7), over each relay's pinned certificate: a call goes
 * to the relay that answered last, then to the others in turn. A node's answer is final, except where it is that node's
 * alone (it does not follow the account's shard, it runs no faucet: another relay's node may); a relay that does not
 * answer, shows another certificate than its pin (nothing is sent to it), or answers with an HTTP error (`429`, say), is
 * passed over.
 *
 * On a test network whose relays run a gate (37-gate §5), a write (`ACCESS_METHODS`) a relay refuses for want of access
 * is sent to it again with a token of the credential `useAccess` gives, asked for then and kept for later writes; a
 * refusal with a token, or with no credential to give, is an `AccessRefused`. Reads never ask for one.
 */
export class RelayGateways implements WalletInterface {
  private list: RelayEndpoint[] = [];
  private good = 0;
  private discovered = false;
  private access: (() => Promise<AccessCredential>) | null;
  /** The credential asked for, once: two writes at once ask for one code. */
  private credential: Promise<AccessCredential> | null = null;
  /** The relays' node keys by endpoint, from `relay_list`: a token names the relay it is shown to. */
  private keys: Map<string, Uint8Array> | null = null;

  constructor(endpoints: readonly RelayEndpoint[], private readonly request: Request = relayRequest, private readonly options: GatewayOptions = {}) {
    this.add(endpoints);
    this.access = options.access ?? null;
  }

  /**
   * Where the network's relays require access for writes, the credential to show (a computer's grant, `grain faucet`
   * and a key file's transactions): asked for only when a relay refuses a write without one, then kept. Null: none.
   */
  useAccess(access: (() => Promise<AccessCredential>) | null): this {
    this.access = access;
    this.credential = null;
    return this;
  }

  /** The node key of the relay at `endpoint`, from `relay_list` (asked once, and again for an endpoint it did not name). */
  private async relayKeyOf(endpoint: RelayEndpoint): Promise<Uint8Array | null> {
    const url = new URL(endpoint.url).href;
    if (this.keys?.has(url)) return this.keys.get(url)!;
    let relays: Array<{ key?: unknown; endpoints?: RelayEndpoint[] }>;
    try {
      ({ relays } = await this.call<{ relays: typeof relays }>("relay_list"));
    } catch {
      return null;
    }
    this.keys = new Map();
    for (const r of relays) {
      if (typeof r.key !== "string" || !/^[0-9a-f]{64}$/.test(r.key)) continue;
      for (const e of r.endpoints ?? []) {
        try {
          this.keys.set(new URL(e.url).href, fromHex(r.key, 32));
        } catch {
          // An endpoint that does not read is none we call.
        }
      }
    }
    return this.keys.get(url) ?? null;
  }

  /** The `X-Saltix-Access` header for `endpoint`, with the credential kept or asked for now (`ask`); null without. */
  private async accessHeader(endpoint: RelayEndpoint, ask: boolean): Promise<Record<string, string> | null> {
    if (this.credential === null && (!ask || !this.access)) return null;
    const key = await this.relayKeyOf(endpoint);
    if (!key) return null;
    // A credential that could not be had (no code, a refused one) is asked for again by the next write.
    this.credential ??= this.access!().catch((e: unknown) => {
      this.credential = null;
      throw e;
    });
    return { "x-saltix-access": toBase64Url(accessToken(await this.credential, key, Date.now())) };
  }

  /** The relays it calls. */
  get endpoints(): RelayEndpoint[] {
    return [...this.list];
  }

  /** Relays to call besides: `wss://` ones pinned by their record's certificate, each once (`repin`: a new pin for a
   *  known endpoint replaces its old one). The endpoints that were new. */
  add(endpoints: readonly RelayEndpoint[], repin = false): RelayEndpoint[] {
    const added: RelayEndpoint[] = [];
    for (const e of endpoints) {
      if (!e.url.startsWith("wss://") || e.cert_sha256 === null || !usableEndpoint(e)) continue;
      const pinned = { url: e.url, cert_sha256: e.cert_sha256.toLowerCase() };
      const known = this.list.findIndex((x) => x.url === e.url);
      if (known < 0) {
        this.list.push(pinned);
        added.push(pinned);
      } else if (repin && this.list[known]!.cert_sha256 !== pinned.cert_sha256) {
        this.list[known] = pinned;
        added.push(pinned);
      }
    }
    return added;
  }

  async call<T>(method: string, params: object = {}): Promise<T> {
    if (this.list.length === 0) throw new Error(`${method}: no relay to ask`);
    const failures: string[] = [];
    const answer = await this.ask<T>(method, params, this.list.map((_, i) => (this.good + i) % this.list.length), failures);
    if (answer.ok) return answer.value;
    if (this.options.discover && !this.discovered) {
      this.discovered = true;
      let found: RelayEndpoint[] = [];
      try {
        found = await relaysOf(this);
      } catch (e) {
        failures.push(`relay_list: ${(e as Error).message}`);
      }
      const fresh = this.add(found, true).map((e) => this.list.findIndex((x) => x.url === e.url));
      const again = await this.ask<T>(method, params, fresh, failures);
      if (again.ok) return again.value;
    }
    throw new Error(`${method}: no relay answered (${failures.join("; ")})`);
  }

  /** `method` at the relays `order` names (indexes into the list), in turn: the first final answer, or none. */
  private async ask<T>(method: string, params: object, order: number[], failures: string[]): Promise<{ ok: true; value: T } | { ok: false }> {
    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    const write = ACCESS_METHODS.has(method);
    const send = (endpoint: RelayEndpoint, shown: Record<string, string> | null) =>
      this.request(endpoint, "POST", "/rpc", { "content-type": "application/json", ...shown }, body);
    for (const at of order) {
      const endpoint = this.list[at]!;
      let shown = write ? await this.accessHeader(endpoint, false) : null;
      let answer;
      try {
        answer = await send(endpoint, shown);
      } catch (e) {
        failures.push(`${endpoint.url}: ${(e as Error).message}`);
        continue;
      }
      let refused = write ? accessRefusalOf(answer.status, answer.body) : null;
      if (refused && shown === null && this.access) {
        // The relay requires access: the credential is asked for now (a code, the first time), and the write sent again.
        shown = await this.accessHeader(endpoint, true);
        if (shown === null) {
          failures.push(`${endpoint.url}: requires access, and the network's relay list does not name its key`);
          continue;
        }
        try {
          answer = await send(endpoint, shown);
        } catch (e) {
          failures.push(`${endpoint.url}: ${(e as Error).message}`);
          continue;
        }
        refused = accessRefusalOf(answer.status, answer.body);
      }
      // Every relay of the network trusts the same gates: a refusal of access is final.
      if (refused) throw refused;
      if (answer.status !== 200) {
        failures.push(`${endpoint.url}: HTTP ${answer.status}`);
        continue;
      }
      let reply: { result?: T; error?: { code: number; message: string; data?: unknown } };
      try {
        reply = JSON.parse(new TextDecoder().decode(answer.body)) as typeof reply;
      } catch {
        failures.push(`${endpoint.url}: not JSON`);
        continue;
      }
      if (reply.error) {
        if (nodeOnly(reply.error.code, reply.error.message)) {
          failures.push(`${endpoint.url}: ${reply.error.message}`);
          continue;
        }
        throw new RpcError(method, reply.error.code, reply.error.message, reply.error.data ?? null);
      }
      this.good = at;
      return { ok: true, value: reply.result as T };
    }
    return { ok: false };
  }
}

/**
 * The wallet interface of `network` through its public relays (`PUBLIC_RELAYS`), and the relays they name when those
 * cannot answer: what a tool needs with no node of its own. Throws for a network with no public relays known.
 */
export function publicGateways(network: NetworkName, request: Request = relayRequest): RelayGateways {
  const gateways = new RelayGateways(PUBLIC_RELAYS[network], request, { discover: true });
  if (gateways.endpoints.length === 0) throw new Error(`no public relays are known for ${network}: pass your own node's wallet interface`);
  return gateways;
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
