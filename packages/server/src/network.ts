// How a grain's server reaches its network with no node of its own (Saltix 24-app-studio §3): through the relays, each
// trusted only with the certificate its ticket pins (09-relay §10.7: every relay serves the node's wallet interface at
// `POST /rpc` on its client port), found when the SDK runs and never from a list it carries (41-transport §18:
// `RelayFinder`), and a view of the chain the server reads its grain's registry record and its members' keys from,
// cached per tip.
import type { NetworkName } from "./address.js";
import { type RelayCache, type RelayReport, RelayFinder } from "./discovery.js";
import { entryPoints } from "./entry.js";
import type { Controller } from "./member.js";
import { RpcError, nodeOnly, rpc } from "./node.js";
import type { RegisteredGrain } from "./registry.js";
import { type RelayEndpoint, relayFailure, relayId, relayName, usableEndpoint, withoutAddresses } from "./relay.js";
import { relayRequest } from "./upload.js";

/** How long a call waits for one relay — to connect, and between the bytes of its answer — before it asks the next. */
export const CALL_TIMEOUT_MS = 8_000;
/** And how long its whole answer may take: a relay that keeps trickling it is given up on, its socket destroyed. */
export const CALL_DEADLINE_MS = 30_000;

/** A node's wallet interface (08-node §6), however it is reached. */
export interface WalletInterface {
  call<T>(method: string, params?: object): Promise<T>;
}

/** Your own node's wallet interface over plain HTTP (a local node or a tunnel). */
export function nodeInterface(url: string): WalletInterface {
  return { call: <T>(method: string, params: object = {}) => rpc<T>(url, method, params) };
}

type Request = typeof relayRequest;

/** How `RelayGateways` finds relays besides those it starts from. */
export interface GatewayOptions {
  /**
   * The relays found when the first call is made, fastest first, and found again (at most once a minute) when every one
   * of them stops answering, and in the background every hour: what `publicGateways` gives.
   */
  finder?: RelayFinder;
}

/** One relay a call could not use, named by its fingerprint (`relayName`), and why. */
interface Failure {
  relay: string;
  why: string;
}

/** Failures in a person's words, at most four named: never a relay's address. */
function described(failures: readonly Failure[]): string {
  const shown = failures.slice(0, 4).map((f) => `relay ${f.relay}: ${f.why}`);
  if (failures.length > 4) shown.push(`${failures.length - 4} more`);
  return shown.join("; ");
}

/**
 * The wallet interface through the relays' gateways (09-relay §10.7), over each relay's pinned certificate (or a public
 * CA's): a call goes to the relay that answered last, then to the others in turn, each given `CALL_TIMEOUT_MS`. A node's
 * answer is final, except where it is that node's alone (it does not follow the account's shard, it runs no faucet:
 * another relay's node may); a relay that does not answer, shows another certificate than its pin (nothing is sent to
 * it), or answers with an HTTP error (`429`, say), is passed over. A call goes over the relays as they were when it
 * began: finding them again meanwhile never moves it.
 */
export class RelayGateways implements WalletInterface {
  private list: RelayEndpoint[] = [];
  /** The relay that answered last, by its URL and pin (`relayId`): a call starts there. */
  private good: string | null = null;
  private readonly finder: RelayFinder | null;
  private found = false;

  constructor(endpoints: readonly RelayEndpoint[], private readonly request: Request = relayRequest, options: GatewayOptions = {}) {
    this.add(endpoints);
    this.finder = options.finder ?? null;
  }

  /** The relays it calls. */
  get endpoints(): RelayEndpoint[] {
    return [...this.list];
  }

  /** What its finder did last (where the relays came from, which answered and how fast), or null. */
  get report(): RelayReport | null {
    return this.finder?.report ?? null;
  }

  /** The network's genesis as its finder settled it (two relays agreeing, one of them an anchor), or null: never one
   *  relay's word. */
  get genesis(): string | null {
    return this.finder?.genesis ?? null;
  }

  /** The relays found now, fastest first (`NoRelayAnswered`, naming everything tried, when none answers); the endpoints
   *  it was given when it has no finder. */
  async ready(): Promise<RelayEndpoint[]> {
    if (this.finder && !this.found) {
      this.replace(await this.finder.find());
      this.found = true;
    }
    return this.endpoints;
  }

  /** Whether it finds its relays by itself (a finder). */
  get finds(): boolean {
    return this.finder !== null;
  }

  /** The relays its finder knows now, found again when the last look is over a minute old: what a relay connection
   *  tries in its next round, and what a server's hourly look refreshes. */
  async refreshed(): Promise<RelayEndpoint[]> {
    if (!this.finder) return this.endpoints;
    try {
      this.replace(await this.finder.refresh());
    } catch {
      // None answers now: the connection tries those it knows, and asks again in its next round.
    }
    return this.endpoints;
  }

  private replace(endpoints: readonly RelayEndpoint[]): void {
    this.list = [];
    this.add(endpoints);
  }

  /** Relays to call besides: `wss://` ones, pinned or behind a CA's certificate, each URL and pin once — a second pin
   *  for a known URL is a relay of its own, tried beside it, and never replaces the first. The endpoints that were new. */
  add(endpoints: readonly RelayEndpoint[]): RelayEndpoint[] {
    const added: RelayEndpoint[] = [];
    for (const e of endpoints) {
      if (!e.url.startsWith("wss://") || !usableEndpoint(e)) continue;
      const one: RelayEndpoint = { url: e.url, cert_sha256: e.cert_sha256?.toLowerCase() ?? null, ...(e.key ? { key: e.key } : {}) };
      if (this.list.some((x) => relayId(x) === relayId(one))) continue;
      this.list.push(one);
      added.push(one);
    }
    return added;
  }

  /** The relays as they are now, the one that answered last first. */
  private inTurn(): RelayEndpoint[] {
    const at = Math.max(0, this.list.findIndex((e) => relayId(e) === this.good));
    return [...this.list.slice(at), ...this.list.slice(0, at)];
  }

  async call<T>(method: string, params: object = {}): Promise<T> {
    await this.ready();
    if (this.finder?.stale) void this.finder.refresh().then((found) => this.replace(found), () => {});
    const relays = this.inTurn();
    if (relays.length === 0) throw new Error(`${method}: no relay to ask`);
    const failures: Failure[] = [];
    const answer = await this.ask<T>(method, params, relays, failures);
    if (answer.ok) return answer.value;
    if (this.finder) {
      // Every relay it found stopped answering: find again (at most once a minute), then try those it has not.
      let found: RelayEndpoint[] = [];
      try {
        found = await this.finder.refresh();
      } catch {
        failures.push({ relay: "found again", why: `none of ${this.finder.report?.tried.length ?? 0} answered` });
      }
      const fresh = found.filter((e) => !relays.some((x) => relayId(x) === relayId(e)));
      if (fresh.length > 0) {
        this.replace(found);
        const again = await this.ask<T>(method, params, fresh, failures);
        if (again.ok) return again.value;
      }
    }
    throw new Error(`${method}: no relay answered (${described(failures)})`);
  }

  /** `method` at `relays`, in turn: the first final answer, or none. */
  private async ask<T>(method: string, params: object, relays: readonly RelayEndpoint[], failures: Failure[]): Promise<{ ok: true; value: T } | { ok: false }> {
    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    for (const endpoint of relays) {
      const relay = relayName(endpoint);
      let answer;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(Object.assign(new Error("the relay did not answer in time"), { code: "ETIMEDOUT" })), CALL_DEADLINE_MS);
      timer.unref?.();
      try {
        answer = await this.request(endpoint, "POST", "/rpc", { "content-type": "application/json" }, body, { timeoutMs: CALL_TIMEOUT_MS, signal: deadline.signal });
      } catch (e) {
        failures.push({ relay, why: relayFailure(e, CALL_TIMEOUT_MS) });
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (answer.status !== 200) {
        failures.push({ relay, why: `HTTP ${answer.status}` });
        continue;
      }
      let reply: { result?: T; error?: { code: number; message: string; data?: unknown } };
      try {
        reply = JSON.parse(new TextDecoder().decode(answer.body)) as typeof reply;
      } catch {
        failures.push({ relay, why: "not JSON" });
        continue;
      }
      if (reply.error) {
        if (nodeOnly(reply.error.code, reply.error.message)) {
          failures.push({ relay, why: withoutAddresses(String(reply.error.message)) });
          continue;
        }
        throw new RpcError(method, reply.error.code, reply.error.message, reply.error.data ?? null);
      }
      this.good = relayId(endpoint);
      return { ok: true, value: reply.result as T };
    }
    return { ok: false };
  }
}

/** Where `publicGateways` starts from besides the release's entry points. */
export interface PublicOptions {
  /** Tickets or endpoints the developer gave (`--relay`): tried first. */
  given?: readonly string[];
  /** The relays that answered in earlier runs (`projectRelayCache`). */
  cache?: RelayCache | null;
  /** The network's genesis hash or its first 16 hex digits, when known. */
  genesis?: string | null;
  log?: ConstructorParameters<typeof RelayFinder>[0]["log"];
  now?: () => number;
}

/**
 * The wallet interface of `network` with no node of its own: the relays found when the first call is made (41-transport
 * §18.5) — what was given, the cache, then the release's entry points, probed at once; then the tickets the fastest hand
 * out, each confirmed by a second relay. Throws for a network with nothing to start from.
 */
export function publicGateways(network: NetworkName, request: Request = relayRequest, options: PublicOptions = {}): RelayGateways {
  const finder = new RelayFinder({
    network, request, given: options.given ?? [], cache: options.cache ?? null, entry: entryPoints(network),
    genesis: options.genesis ?? null, log: options.log, now: options.now,
  });
  if (!finder.hasCandidates) throw new Error(`no relay is known for ${network}: pass a relay ticket or your own node's wallet interface`);
  return new RelayGateways([], request, { finder });
}

/** What `node_status` says, as far as a grain's server reads it. */
export interface NodeStatus {
  network: string;
  genesis: string;
  slot: number;
  beacon: { height: number; hash: string };
  shards?: Array<{ shard: string; hash: string }>;
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
