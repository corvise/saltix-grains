// Finding the network's relays when the SDK runs (Saltix 41-transport §18.5), never from a list it carries: what the
// developer gave (tickets or endpoints), the cache of relays that answered, then the release's obfuscated entry points
// (the last resort), probed at once, 16 at a time. Once three relays answered (or every probe ended), `relay_tickets` from
// two relays that are not one: the relays' own signed records, five chosen for the requester's network bucket and the
// answering relay's own, each checked here, kept only where it names a public address (a name found at one), and used
// only once a trust anchor — a relay the person gave, or an entry point — other than the one relay that handed it out
// confirms that its node key holds an active license. A relay is one relay whatever its names: its ticket's node key, or
// its host and port, count its word once. The network's genesis is adopted only where two relays agree, one of them an
// anchor. When nothing answers, the error names every source and every relay tried with its result, each relay by its
// key's or its certificate's fingerprint, never by its address.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { NetworkName } from "./address.js";
import { entryPoints } from "./entry.js";
import { type RelayEndpoint, relayFailure, relayId, relayName, usableEndpoint } from "./relay.js";
import {
  type RelayTicket, TICKETS, TICKET_PREFIX, type TicketReason, TicketRefused, isTicketText, openTicketsAnswer, readTicket, ticketsKey,
} from "./tickets.js";
import { relayRequest } from "./upload.js";

/** How long one relay has to answer a probe, a request for tickets or a license's check. */
export const PROBE_TIMEOUT_MS = 5_000;
/** The relays a cache keeps at most. */
export const CACHE_MAX = 16;
/** A finder looks again at most this often when every relay it found stops answering, or after a look that found none. */
export const REFIND_MIN_MS = 60_000;
/** And at least this often while it runs. */
export const REFRESH_MS = 3_600_000;
/** Relays probed at once at most. */
export const PROBES_AT_ONCE = 16;
/** Discovery goes on once this many relays (not names: a relay is counted once) answered, without waiting for the
 *  slowest probe. */
export const ENOUGH_ANSWERED = 3;
/** The relays asked for tickets. */
const DISCOVER_FROM = 2;

/** Where a relay came from: given by the developer, the cache, the release's entry points, or found by asking. */
export type RelaySource = "given" | "cache" | "entry" | "discovered";

/** Why a ticket was not used, besides a reader's refusal (`TicketReason`): past an answer's bound (`extra`), naming no
 *  public address (`private`), its endpoints repeating a host and port (`repeated`: one relay under several names) or
 *  naming one that is no URL a connection dials (`endpoint`), its node key holding no active license by an anchor's
 *  word (`unlicensed`), or no anchor but the relay that handed it out to ask (`unconfirmed`). */
export type TicketDrop = "extra" | "private" | "repeated" | "endpoint" | "unlicensed" | "unconfirmed";

/** One relay tried, and what came of it. */
export interface RelayTry {
  /** The relay as logs and errors name it (`relayName`): its node key's or its certificate's fingerprint, never its
   *  address. */
  relay: string;
  source: RelaySource;
  ok: boolean;
  /** Its answer's time, when it answered. */
  ms: number | null;
  /** Why not, in a person's words. */
  error: string | null;
}

/** What a finder did, for `grain doctor` and the error when nothing answered: counts, reasons and fingerprints, never a
 *  relay's address in the clear. */
export interface RelayReport {
  network: NetworkName;
  /** The network's genesis hash once two relays agreed on it, one of them an anchor (or as given), else its first 16 hex
   *  digits as the app key gives them, when known. */
  genesis: string | null;
  /** The cache's file, when it keeps one. */
  cache: string | null;
  /** The relays it kept there this time (entry points never are). */
  kept: number;
  /** The candidates each source gave. */
  sources: Record<RelaySource, number>;
  tried: RelayTry[];
  /** Whether more relays were found by tickets this time. */
  discovery: "tickets" | "none";
  /** Tickets taken (checked, naming a public address, their license confirmed by an anchor), and those that were not,
   *  by reason. */
  tickets: { taken: number; refused: Partial<Record<TicketReason | TicketDrop, number>> };
  /** The tickets of the relays that answered — an entry relay's own among them once it handed it out —: what a site's
   *  own proxy may name (connect.md), read with `readTicket`. */
  answered: string[];
  /** What was given and left out this time, in a person's words (a ticket past its life: ask for a new one). */
  warnings: string[];
  took_ms: number;
  at: number;
}

/** No relay answered: `report` names what was tried. */
export class NoRelayAnswered extends Error {
  constructor(readonly report: RelayReport) {
    super(describeFailure(report));
    this.name = "NoRelayAnswered";
  }
}

const SOURCE_WORDS: Record<RelaySource, string> = {
  given: "given", cache: "from the cache", entry: "the release's entry point", discovered: "found by asking",
};

function describeFailure(r: RelayReport): string {
  const lines = [`no relay of ${r.network} answered (${r.tried.length} tried in ${(r.took_ms / 1000).toFixed(1)} s):`];
  for (const t of r.tried) lines.push(`  relay ${t.relay} (${SOURCE_WORDS[t.source]}): ${t.error ?? "answered"}`);
  if (r.tried.length === 0) lines.push("  none: nothing was given, the cache is empty and this release carries no entry point for it");
  for (const w of r.warnings) lines.push(`  ${w}`);
  if (r.cache !== null && r.sources.cache === 0) lines.push(`  the cache (${r.cache}) held no relay of this network`);
  lines.push("what to do: grain doctor says the same; a relay ticket from someone whose Saltix works (--relay SALTIX-RELAY:…), " +
    "or a relay or node of your own (--relay wss://host:port/#<SHA-256 of its certificate>, --node URL)");
  return lines.join("\n");
}

/** A relay given by the developer that cannot be one, refused when it is given (a ticket that does not read, of another
 *  network, naming no endpoint or one host and port twice; an endpoint that is not `wss://host:port/#<pin>`): a
 *  configuration to fix, which no restart mends. A ticket's time is not judged here: one past its life is left out when
 *  it is used, with a warning. */
export class GivenRelayRefused extends Error {
  constructor(readonly reason: TicketReason | "form" | "repeated" | "endpoint", readonly position: number) {
    super(`relay ${position + 1} given: ${reason === "form"
      ? "neither a relay ticket (SALTIX-RELAY:…) nor wss://host:port/#<the SHA-256 of its certificate, 64 hex> (a host name may go without it, behind a CA's certificate)"
      : reason === "repeated" ? "a relay ticket naming one host and port twice (one relay under several names)"
        : reason === "endpoint" ? "a relay ticket naming an endpoint that is no URL a connection can dial"
        : new TicketRefused(reason).message}`);
    this.name = "GivenRelayRefused";
  }
}

/** Where a finder keeps the relays that answered between runs. */
export interface RelayCache {
  /** The file, for people; null for one in memory. */
  readonly where: string | null;
  load(): string[];
  save(entries: string[]): void;
}

/** A cache in memory: what one process found. */
export function memoryRelayCache(): RelayCache {
  let kept: string[] = [];
  return { where: null, load: () => [...kept], save: (entries) => { kept = [...entries]; } };
}

interface CacheFile {
  network: string;
  saved_at: number;
  relays: string[];
}

/**
 * A cache in `path` (a project's `.grain/relays.json`) for `network`: owner-only, written whole through a temporary file,
 * a file of another network or one that does not read taken as empty. It holds relays, never keys.
 */
export function fileRelayCache(path: string, network: NetworkName): RelayCache {
  return {
    where: path,
    load() {
      try {
        const file = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
        if (file.network !== network || !Array.isArray(file.relays)) return [];
        return file.relays.filter((r): r is string => typeof r === "string").slice(0, CACHE_MAX);
      } catch {
        return [];
      }
    },
    save(entries) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const body: CacheFile = { network, saved_at: Date.now(), relays: entries.slice(0, CACHE_MAX) };
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
        if (process.platform !== "win32") chmodSync(temporary, 0o600);
        renameSync(temporary, path);
      } catch {
        // A cache that cannot be written costs the next run its head start, nothing more.
      }
    },
  };
}

/** `.grain/relays.json` in `dir` when `dir` holds `.grain/` (a project), else a cache in memory. */
export function projectRelayCache(dir: string, network: NetworkName): RelayCache {
  return existsSync(`${dir}/.grain`) ? fileRelayCache(`${dir}/.grain/relays.json`, network) : memoryRelayCache();
}

/** The relays given in `SALTIX_RELAYS`: tickets (`SALTIX-RELAY:…`) or endpoints (`wss://host:port/#<pin>`), apart by
 *  spaces or commas — a ticket someone whose Saltix works gave you, for a server whose entry points are blocked. */
export function relaysFromEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SALTIX_RELAYS ?? "").split(/[\s,]+/).filter((s) => s !== "");
}

type Request = typeof relayRequest;
type Log = (level: "info" | "warn", event: string, meta?: Record<string, unknown>) => void;

export interface FinderOptions {
  network: NetworkName;
  /** The network's genesis hash, or its first 16 hex digits (an app key's), when known: a relay of another is refused,
   *  and a full one given is taken as settled. */
  genesis?: string | null;
  /** Tickets (`SALTIX-RELAY:…`) or endpoints (`wss://host:port/#<pin>`) given by the developer, tried first: trust
   *  anchors, with the entry points. One that cannot be a relay throws `GivenRelayRefused` here. */
  given?: readonly string[];
  /** The relays that answered in earlier runs; none by default. */
  cache?: RelayCache | null;
  /** The entry points to try last; by default the release's for `network`. */
  entry?: readonly string[];
  request?: Request;
  now?: () => number;
  /** Events worth logging: counts, reasons, times and fingerprints, never a relay's address. */
  log?: Log;
  /** How long a probe waits, ms. */
  probeMs?: number;
  /** Which hosts (addresses, and what a name was found at) a ticket handed out may name: public ones only (`publicHost`)
   *  unless a test that plays relays at documentation addresses widens it. Given relays and entry points are not held
   *  to it (a relay of one's own may be on a private network). */
  hostAllowed?: (host: string) => boolean;
  /** The addresses a name is found at (tests give their own); by default the system's (`dns.lookup`, all of them). */
  lookup?: (name: string) => Promise<string[]>;
}

/** A relay to probe: its endpoint (with the node key its ticket names, and the checked address its name was found at),
 *  where it came from, what the cache would keep of it, and whether it is a trust anchor — a relay the person gave, or
 *  an entry point —, whose word alone confirms a ticket's license. */
interface Candidate {
  endpoint: RelayEndpoint;
  source: RelaySource;
  /** The ticket's text, or the endpoint as `wss://…#<pin>`. */
  entry: string;
  ticket: RelayTicket | null;
  anchor: boolean;
}

interface Probed {
  candidate: Candidate;
  ok: boolean;
  ms: number;
  error: string | null;
  genesis: string | null;
}

/** A ticket handed out, its endpoints that may be dialed, the relays that handed it out, and those of them that handed
 *  it out as their own (`self`, over their own pinned connection). */
interface Handed {
  ticket: RelayTicket;
  endpoints: RelayEndpoint[];
  from: Set<Candidate>;
  own: Set<Candidate>;
}

/** A relay given by the developer, read once: its text as the finder takes it, its candidates, and its ticket for the time
 *  checked at each look. */
interface Given {
  text: string;
  ticket: RelayTicket | null;
  candidates: Candidate[];
}

/** An endpoint's host and port, what a connection dials whatever the path: one server; null for a URL that does not
 *  parse, which no connection could dial (a relay's text never throws past here: the review of 2026-11-04, where one
 *  ticket naming `wss://a b/` stopped every look with a bare "Invalid URL"). */
const hostPort = (url: string): string | null => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === "") return null;
  return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "wss:" ? "443" : "80")}`;
};

/** Why a ticket's endpoints cannot be told apart: one that is no URL a connection dials (`endpoint`), or one host and
 *  port twice (`repeated`: one relay under several names, each of which would count); null when they can. */
const endpointsProblem = (ticket: RelayTicket): "endpoint" | "repeated" | null => {
  const at = ticket.endpoints.map((e) => hostPort(e.url));
  if (at.some((a) => a === null)) return "endpoint";
  return new Set(at).size < at.length ? "repeated" : null;
};

/**
 * Which candidates are one relay: those that share a node key (a ticket's) or a host and port, joined by every name
 * they share, so that one relay's word counts once — among the first that answered, the genesis's voters, the relays
 * asked for tickets and the anchors that confirm a ticket.
 */
class Identities {
  private readonly parent = new Map<string, string>();

  private root(mark: string): string {
    let at = mark;
    while (this.parent.get(at) !== at) at = this.parent.get(at)!;
    this.parent.set(mark, at);
    return at;
  }

  /** `c` among them, joined with whatever shares a name with it. */
  add(c: { endpoint: RelayEndpoint; ticket: RelayTicket | null }): void {
    const marks = [`at:${hostPort(c.endpoint.url) ?? c.endpoint.url}`, ...(c.ticket ? [`key:${c.ticket.nodeKey}`] : [])];
    for (const m of marks) if (!this.parent.has(m)) this.parent.set(m, m);
    const first = this.root(marks[0]!);
    for (const m of marks.slice(1)) this.parent.set(this.root(m), first);
  }

  /** The relay `c` is (added first). */
  of(c: { endpoint: RelayEndpoint; ticket: RelayTicket | null }): string {
    this.add(c);
    return this.root(`at:${hostPort(c.endpoint.url) ?? c.endpoint.url}`);
  }
}

/** An endpoint's text as `--relay` takes it and a file reference names it. */
export function endpointText(e: RelayEndpoint): string {
  return e.cert_sha256 === null ? e.url : `${e.url}#${e.cert_sha256.toLowerCase()}`;
}

/** An endpoint from `wss://host:port/#<pin>` (or `wss://…` behind a CA's certificate), or null. */
export function endpointOf(text: string): RelayEndpoint | null {
  const hash = text.lastIndexOf("#");
  const url = hash < 0 ? text.trim() : text.slice(0, hash).trim();
  const pin = hash < 0 ? null : text.slice(hash + 1).trim().toLowerCase();
  if (!/^wss:\/\/[^\s#]+$/.test(url) || (pin !== null && !/^[0-9a-f]{64}$/.test(pin)) || hostPort(url) === null) return null;
  const endpoint = { url, cert_sha256: pin };
  return usableEndpoint(endpoint) ? endpoint : null;
}

/** An endpoint's host, without an IPv6 address's brackets; empty for a URL that does not parse (no public host). */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
};

/**
 * A relay given by the developer, checked as it is given (41-transport §18.5): a ticket by every check but its time
 * (`readTicket` at `now: null`) for the network of `genesis` when known, naming each host and port once, or
 * `wss://host:port/#<pin>` (a host name may go without a pin, behind a CA's certificate). Its text as the finder takes
 * it, or `GivenRelayRefused`.
 */
export function checkGivenRelay(text: string, genesis: string | null = null, position = 0): string {
  return readGiven(text, genesis, position).text;
}

function readGiven(text: string, genesis: string | null, position: number): Given {
  if (isTicketText(text)) {
    let ticket: RelayTicket;
    try {
      ticket = readTicket(text, { genesis, now: null });
    } catch (e) {
      if (e instanceof TicketRefused) throw new GivenRelayRefused(e.reason, position);
      throw e;
    }
    const problem = endpointsProblem(ticket);
    if (problem !== null) throw new GivenRelayRefused(problem, position);
    const candidates = ticket.endpoints.filter(gatewayEndpoint).map((e) => ({
      endpoint: { ...e, key: ticket.nodeKey }, source: "given" as const, entry: ticket.text, ticket, anchor: true,
    }));
    return { text: ticket.text, ticket, candidates };
  }
  const endpoint = endpointOf(text);
  // An address without its certificate's pin is a pin forgotten: a CA vouches for names.
  if (endpoint === null || (endpoint.cert_sha256 === null && isIP(hostOf(endpoint.url)) !== 0)) {
    throw new GivenRelayRefused("form", position);
  }
  const entry = endpointText(endpoint);
  return { text: entry, ticket: null, candidates: [{ endpoint, source: "given", entry, ticket: null, anchor: true }] };
}

/** Whether a relay's endpoint can serve a gateway's calls: `wss://`, pinned or behind a CA's certificate. */
const gatewayEndpoint = (e: RelayEndpoint): boolean => e.url.startsWith("wss://") && usableEndpoint(e);

/** A probe's or a request's deadline: no answer in time. */
const lateError = () => Object.assign(new Error("no answer in time"), { code: "ETIMEDOUT" });

/** A promise that rejects with `signal`'s reason once it fires: a deadline for a request that does not take one. */
const firing = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

/**
 * Whether a ticket's host is one a relay serves the public from, as the node's `ip::is_public` judges an address: not
 * unspecified, loopback, private, link-local, shared (CGNAT), the IETF's, documentation, benchmarking, reserved,
 * multicast or broadcast, nor unique-local, site-local or discard-only, an IPv6 address carrying an IPv4 one (mapped,
 * compatible, NAT64, 6to4) judged as that one; a name only with a dot, and none of the names for no public host
 * (`localhost`, `.local`, `.internal`, `.home.arpa`, `.test`, `.example`, `.invalid`).
 */
export function publicHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const family = isIP(h);
  if (family === 4) return publicV4(h.split(".").map(Number));
  if (family === 6) {
    const groups = v6Groups(h);
    return groups !== null && publicV6(groups);
  }
  return h.includes(".") && !/(^|\.)(localhost|local|internal|home\.arpa|test|example|invalid)$/.test(h);
}

function publicV4([a, b, c]: number[]): boolean {
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && (b! & 0xc0) === 64) || (a === 169 && b === 254) ||
    (a === 172 && (b! & 0xf0) === 16) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) ||
    (a === 198 && (b! & 0xfe) === 18) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    a! >= 224);
}

function publicV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return publicV4(v4(g[6]!, g[7]!));
  // Compatible, `::` and `::1` among them: 0.0.0.0 and 0.0.0.1, not public either.
  if (zeros(6)) return publicV4(v4(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(v4(g[6]!, g[7]!));
  if (g[0] === 0x2002) return publicV4(v4(g[1]!, g[2]!));
  const a = g[0]!;
  return !((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00 ||
    (a === 0x2001 && g[1] === 0x0db8) || (a === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0));
}

/** An IPv6 address's eight groups (one `isIP` takes), its dotted IPv4 tail as two of them. */
function v6Groups(text: string): number[] | null {
  let s = text;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [w, x, y, z] = dotted.slice(2).map(Number) as [number, number, number, number];
    s = `${dotted[1]}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
}

/**
 * The relays of a network, found when it runs (41-transport §18.5). `find` probes every candidate (16 at a time); once
 * three relays answered it asks two of them for tickets, keeps those that name a public address, has an anchor confirm
 * each one's license, probes those, keeps what answers fastest first and caches it; `refresh` finds again when the last
 * look is over a minute old. A look that found nothing is not repeated within the minute: its error comes again.
 */
export class RelayFinder {
  private readonly request: Request;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly probeMs: number;
  private readonly hostAllowed: (host: string) => boolean;
  private readonly lookup: (name: string) => Promise<string[]>;
  private readonly given: Given[];
  private readonly givenTexts: Set<string>;
  /** What the app key (or the caller) vouches for: 16 hex digits, or the whole genesis. */
  private readonly prefix: string | null;
  /** The genesis adopted: given whole, or agreed by two relays, one of them an anchor. */
  private settled: string | null;
  private found: RelayEndpoint[] = [];
  private lastReport: RelayReport | null = null;
  private lastFind = Number.NEGATIVE_INFINITY;
  private failed: { at: number; error: NoRelayAnswered } | null = null;
  private running: Promise<RelayEndpoint[]> | null = null;

  constructor(private readonly options: FinderOptions) {
    this.request = options.request ?? relayRequest;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.probeMs = options.probeMs ?? PROBE_TIMEOUT_MS;
    this.hostAllowed = options.hostAllowed ?? publicHost;
    this.lookup = options.lookup ?? (async (name) => (await dnsLookup(name, { all: true, verbatim: true })).map((a) => a.address));
    const genesis = options.genesis ? options.genesis.toLowerCase() : null;
    this.prefix = genesis !== null && /^([0-9a-f]{16}|[0-9a-f]{64})$/.test(genesis) ? genesis : null;
    this.settled = this.prefix !== null && this.prefix.length === 64 ? this.prefix : null;
    // What the developer gave is checked now, never skipped: a typo stops the start, where it is fixed.
    this.given = (options.given ?? []).map((text, i) => readGiven(text, this.prefix, i));
    this.givenTexts = new Set(this.given.map((g) => g.text));
  }

  /** What the last look did, or null before the first. */
  get report(): RelayReport | null {
    return this.lastReport;
  }

  /** The relays found last, fastest first. */
  get endpoints(): RelayEndpoint[] {
    return [...this.found];
  }

  /** The network's genesis once settled: given whole, or agreed by two relays, one of them an anchor; null until then. A
   *  server signs under it, never under one relay's word. */
  get genesis(): string | null {
    return this.settled;
  }

  /** Whether anything at all is there to try: a network with no entry point needs something given. */
  get hasCandidates(): boolean {
    return this.given.length > 0 || this.entry.length > 0 || (this.options.cache?.load().length ?? 0) > 0;
  }

  /** The last look is older than an hour: look again in the background. */
  get stale(): boolean {
    return this.now() - this.lastFind >= REFRESH_MS;
  }

  private get entry(): readonly string[] {
    return this.options.entry ?? entryPoints(this.options.network);
  }

  /** Find again, unless the last look is under a minute old: the relays found. */
  async refresh(): Promise<RelayEndpoint[]> {
    if (this.now() - this.lastFind < REFIND_MIN_MS && this.found.length > 0) return this.endpoints;
    return this.find();
  }

  /** Look now (one look at a time): the relays that answered, fastest first; `NoRelayAnswered` when none did — the same
   *  error again, with no new look, for a minute after. */
  find(): Promise<RelayEndpoint[]> {
    if (this.running) return this.running;
    if (this.failed !== null && this.now() - this.failed.at < REFIND_MIN_MS) return Promise.reject(this.failed.error);
    this.running = this.look().then((found) => {
      this.failed = null;
      return found;
    }, (e: unknown) => {
      if (e instanceof NoRelayAnswered) this.failed = { at: this.now(), error: e };
      throw e;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  /** The candidates of this look, each endpoint and pin once, in order: given, the cache, the entry points. A given
   *  ticket past its life (or dated ahead of this clock) is left out with a warning; an entry point is always tried; a
   *  cached relay that was not given is held to the public rule as when it was handed out. */
  private async candidates(refused: RelayReport["tickets"]["refused"]):
    Promise<{ list: Candidate[]; sources: Record<RelaySource, number>; warnings: string[]; entries: Set<string> }> {
    const list: Candidate[] = [];
    const sources: Record<RelaySource, number> = { given: 0, cache: 0, entry: 0, discovered: 0 };
    const warnings: string[] = [];
    const seen = new Set<string>();
    const add = (c: Candidate) => {
      const id = relayId(c.endpoint);
      if (seen.has(id)) return;
      seen.add(id);
      list.push(c);
      sources[c.source]++;
    };
    for (const g of this.given) {
      const late = g.ticket === null ? null : timeProblem(g.ticket.text, this.prefix, this.now());
      if (late !== null) {
        const relay = keyName(g.ticket!.nodeKey);
        warnings.push(`the ticket given for relay ${relay} is left out: ${new TicketRefused(late).message}`);
        this.log("warn", "relay_given_skipped", { relay, reason: late });
        continue;
      }
      g.candidates.forEach(add);
    }
    for (const text of this.options.cache?.load() ?? []) (await this.read(text, "cache", refused, this.givenTexts.has(text))).forEach(add);
    const entries = new Set<string>();
    for (const text of this.entry) {
      for (const c of await this.read(text, "entry", refused, true)) {
        entries.add(relayId(c.endpoint));
        add(c);
      }
    }
    return { list, sources, warnings, entries };
  }

  /** A cached or entry text's candidates: a ticket's endpoints (checked, 41-transport §18.3, each host and port once), or
   *  an endpoint; held to the public rule unless `exempt` (an entry point, or what the person gave); nothing for one that
   *  does not read (counted). */
  private async read(text: string, source: RelaySource, refused: RelayReport["tickets"]["refused"], exempt: boolean): Promise<Candidate[]> {
    const drop = (reason: TicketReason | TicketDrop) => { refused[reason] = (refused[reason] ?? 0) + 1; };
    if (isTicketText(text)) {
      let ticket: RelayTicket;
      try {
        ticket = readTicket(text, { genesis: this.settled ?? this.prefix, now: this.now() });
      } catch (e) {
        if (!(e instanceof TicketRefused)) throw e;
        drop(e.reason);
        return [];
      }
      const problem = endpointsProblem(ticket);
      if (problem !== null) {
        drop(problem);
        return [];
      }
      const usable = ticket.endpoints.filter(gatewayEndpoint).map((e) => ({ ...e, key: ticket.nodeKey }));
      const endpoints = exempt ? usable : await this.vetted(usable);
      if (endpoints.length === 0) {
        drop("private");
        return [];
      }
      return endpoints.map((endpoint) => ({ endpoint, source, entry: ticket.text, ticket, anchor: source === "entry" }));
    }
    const endpoint = endpointOf(text);
    if (endpoint === null) return [];
    const endpoints = exempt ? [endpoint] : await this.vetted([endpoint]);
    if (endpoints.length === 0) drop("private");
    return endpoints.map((e) => ({ endpoint: e, source, entry: endpointText(e), ticket: null, anchor: source === "entry" }));
  }

  /** The endpoints of `endpoints` that name a public address: an address the rule takes, or a name every address of which
   *  it takes — dialed at the first of them, so a name found anew elsewhere never moves the connection. */
  private async vetted(endpoints: readonly RelayEndpoint[]): Promise<RelayEndpoint[]> {
    const kept = await Promise.all(endpoints.map(async (e): Promise<RelayEndpoint | null> => {
      const host = hostOf(e.url);
      if (isIP(host) !== 0) return this.hostAllowed(host) ? e : null;
      if (!this.hostAllowed(host)) return null;
      let addresses: string[];
      // A name is looked up within a probe's deadline: one relay's slow name never holds a look (the review of
      // 2026-11-04); one not found in time counts as no public address.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        addresses = await Promise.race([
          this.lookup(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(lateError()), this.probeMs);
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
      return addresses.length > 0 && addresses.every((a) => this.hostAllowed(a)) ? { ...e, address: addresses[0]! } : null;
    }));
    return kept.filter((e): e is RelayEndpoint => e !== null);
  }

  /** `method` at one relay within the probe's time, given up (its socket destroyed) at that deadline or when `cancel`
   *  fires: its HTTP answer. */
  private async post(endpoint: RelayEndpoint, method: string, params: object, cancel?: AbortSignal): Promise<{ status: number; body: Uint8Array }> {
    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(lateError()), this.probeMs);
    timer.unref?.();
    const stop = () => deadline.abort(lateError());
    cancel?.addEventListener("abort", stop, { once: true });
    if (cancel?.aborted) stop();
    try {
      const asked = this.request(endpoint, "POST", "/rpc", { "content-type": "application/json" }, body, { timeoutMs: this.probeMs, signal: deadline.signal });
      // Settled late, after the deadline, it is nobody's: never an unhandled rejection.
      asked.catch(() => {});
      return await Promise.race([asked, firing(deadline.signal)]);
    } finally {
      clearTimeout(timer);
      cancel?.removeEventListener("abort", stop);
    }
  }

  /** A JSON-RPC call to one relay: the result, or the error's code and message. */
  private async rpc(endpoint: RelayEndpoint, method: string, params: object): Promise<{ result?: unknown; code?: number; message?: string }> {
    const answer = await this.post(endpoint, method, params);
    if (answer.status !== 200) return { code: -answer.status, message: `HTTP ${answer.status}` };
    const reply = JSON.parse(new TextDecoder().decode(answer.body)) as { result?: unknown; error?: { code: number; message: string } };
    return reply.error ? { code: reply.error.code, message: reply.error.message } : { result: reply.result };
  }

  /** One relay's `node_status` within the probe's time, held to the network and to the genesis vouched for. */
  private async probe(candidate: Candidate, cancel?: AbortSignal): Promise<Probed> {
    const started = this.now();
    try {
      const answer = await this.post(candidate.endpoint, "node_status", {}, cancel);
      const ms = Math.max(0, this.now() - started);
      if (answer.status !== 200) return { candidate, ok: false, ms, error: `answered HTTP ${answer.status}`, genesis: null };
      let status: { network?: unknown; genesis?: unknown } | undefined;
      try {
        status = (JSON.parse(new TextDecoder().decode(answer.body)) as { result?: { network?: unknown; genesis?: unknown } }).result;
      } catch {
        return { candidate, ok: false, ms, error: "did not answer as a relay does (not JSON)", genesis: null };
      }
      if (status?.network !== this.options.network) {
        const network = typeof status?.network === "string" && /^[a-z]{1,16}$/.test(status.network) ? status.network : "an unknown network";
        return { candidate, ok: false, ms, error: `is on ${network}, not ${this.options.network}`, genesis: null };
      }
      if (typeof status.genesis !== "string" || !/^[0-9a-f]{64}$/.test(status.genesis)) {
        return { candidate, ok: false, ms, error: "did not answer as a relay does (no genesis of 64 lower-case hex digits)", genesis: null };
      }
      const probed = { candidate, ok: true, ms, error: null, genesis: status.genesis };
      this.holdTo(probed, this.settled ?? this.prefix);
      return probed;
    } catch (e) {
      return { candidate, ok: false, ms: Math.max(0, this.now() - started), error: relayFailure(e, this.probeMs), genesis: null };
    }
  }

  /** An answer of another genesis than `genesis` (whole or its first digits): no answer of this network's. */
  private holdTo(p: Probed, genesis: string | null): void {
    if (p.ok && genesis !== null && !p.genesis!.startsWith(genesis)) {
      p.ok = false;
      p.error = `is on another ${this.options.network} (genesis ${p.genesis!.slice(0, 16)}…, not ${genesis.slice(0, 16)}…): an old network's relay?`;
    }
  }

  /** Probes of `list`, at most `PROBES_AT_ONCE` under way: `results` fills as each ends; `early` resolves once `want`
   *  relays (not names) answered or every probe ended, `all` once every probe ended. Nothing new starts once `cancel`
   *  fired, and those under way are given up. */
  private probeMany(list: readonly Candidate[], want: number, ids: Identities, cancel?: AbortSignal):
    { results: Map<Candidate, Probed>; early: Promise<void>; all: Promise<void> } {
    const results = new Map<Candidate, Probed>();
    const answered = new Set<string>();
    let next = 0;
    let enough = () => {};
    const early = new Promise<void>((resolve) => { enough = resolve; });
    const worker = async () => {
      while (next < list.length && !cancel?.aborted) {
        const candidate = list[next++]!;
        const probed = await this.probe(candidate, cancel);
        results.set(candidate, probed);
        if (probed.ok) answered.add(ids.of(candidate));
        if (answered.size >= want) enough();
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(PROBES_AT_ONCE, list.length) }, worker)).then(() => enough());
    return { results, early, all };
  }

  /**
   * The look's genesis among those that answered, each relay voting once: settled, or the one most anchors answer (then
   * most relays, then the fastest); every answer of another is no answer of this network's. It is adopted — settled for
   * every later look and what a server signs under — only where two relays agree on it, one of them an anchor: one
   * relay's word never extends what the app key vouches for.
   */
  private settleGenesis(probed: readonly Probed[], ids: Identities): string | null {
    if (this.settled !== null) return this.settled;
    const tally = new Map<string, { relays: Set<string>; anchors: Set<string>; ms: number }>();
    for (const p of probed.filter((p) => p.ok)) {
      const relay = ids.of(p.candidate);
      const t = tally.get(p.genesis!) ?? { relays: new Set(), anchors: new Set(), ms: p.ms };
      t.relays.add(relay);
      if (p.candidate.anchor) t.anchors.add(relay);
      t.ms = Math.min(t.ms, p.ms);
      tally.set(p.genesis!, t);
    }
    const best = [...tally.entries()].sort(([, a], [, b]) => b.anchors.size - a.anchors.size || b.relays.size - a.relays.size || a.ms - b.ms)[0];
    if (best === undefined) return null;
    const [genesis, t] = best;
    for (const p of probed) this.holdTo(p, genesis);
    if (t.relays.size >= 2 && t.anchors.size >= 1) this.settled = genesis;
    return genesis;
  }

  /**
   * The tickets two relays that are not one hand out (41-transport §18.4), each answer opened under the genesis that relay
   * itself answered: from each its own ticket and the first `TICKETS` of the rest (more are counted, never read), each
   * read here, refused where it names one host and port twice, and kept with the endpoints that name a public address;
   * then each confirmed (`confirm`) before it is used.
   */
  private async discover(from: readonly Probed[], refused: RelayReport["tickets"]["refused"]): Promise<Handed[]> {
    const drop = (reason: TicketReason | TicketDrop, n = 1) => { refused[reason] = (refused[reason] ?? 0) + n; };
    const handed = new Map<string, Handed>();
    const read = new Set<string>();
    const answers = await Promise.all(from.map(async (p) => {
      try {
        const { secret, key } = ticketsKey();
        const reply = await this.rpc(p.candidate.endpoint, "relay_tickets", { key });
        const sealed = (reply.result as { sealed?: unknown } | undefined)?.sealed;
        const opened = typeof sealed === "string" ? openTicketsAnswer(sealed, secret, p.genesis!) : null;
        return opened !== null && typeof opened === "object" ? { from: p, answer: opened as { self?: unknown; tickets?: unknown } } : null;
      } catch {
        return null; // This relay could not be asked; the other may be.
      }
    }));
    for (const got of answers) {
      if (got === null) continue;
      const others = Array.isArray(got.answer.tickets) ? got.answer.tickets : [];
      if (others.length > TICKETS) drop("extra", others.length - TICKETS);
      for (const [i, text] of [got.answer.self, ...others.slice(0, TICKETS)].entries()) {
        if (typeof text !== "string") continue;
        let ticket: RelayTicket;
        try {
          ticket = readTicket(text, { genesis: got.from.genesis, now: this.now() });
        } catch (e) {
          if (!(e instanceof TicketRefused)) throw e;
          if (!read.has(text)) drop(e.reason);
          read.add(text);
          continue;
        }
        let one = handed.get(ticket.text);
        if (one === undefined) {
          if (read.has(ticket.text)) continue;
          read.add(ticket.text);
          const problem = endpointsProblem(ticket);
          if (problem !== null) {
            drop(problem);
            continue;
          }
          const endpoints = await this.vetted(ticket.endpoints.filter(gatewayEndpoint).map((e) => ({ ...e, key: ticket.nodeKey })));
          if (endpoints.length === 0) {
            drop("private");
            continue;
          }
          one = { ticket, endpoints, from: new Set(), own: new Set() };
          handed.set(ticket.text, one);
        }
        one.from.add(got.from.candidate);
        if (i === 0) one.own.add(got.from.candidate);
      }
    }
    return [...handed.values()];
  }

  /**
   * Each ticket's node key checked for an active license (`license_list {node_key}`, the gateway's narrowest read of
   * it) by a trust anchor that answered — a relay the person gave, or an entry point; never a cached or found one — and
   * that is not the one relay that handed the ticket out (by key or host and port): one relay's word never brings in
   * relays of its own. Each anchor is asked one check at a time (a gateway serves a client one heavy read at a time), and
   * one that cannot answer is asked no more this look. A ticket no other anchor could check is `unconfirmed`, one whose
   * key holds no active license `unlicensed`.
   */
  private async confirm(tickets: readonly Handed[], anchors: readonly Probed[], ids: Identities): Promise<Map<Handed, "licensed" | TicketDrop>> {
    const verdicts = new Map<Handed, "licensed" | TicketDrop>();
    const queues = new Map<string, Promise<unknown>>();
    const failed = new Set<string>();
    const inTurn = <T>(relay: string, job: () => Promise<T>): Promise<T> => {
      const run = (queues.get(relay) ?? Promise.resolve()).then(job);
      queues.set(relay, run.catch(() => {}));
      return run;
    };
    // What a ticket's relays and its handers are, once every name they show is known.
    for (const t of tickets) for (const endpoint of t.endpoints) ids.add({ endpoint, ticket: t.ticket });
    await Promise.all(tickets.map(async (t, i) => {
      const handers = new Set([...t.from].map((c) => ids.of(c)));
      const others = anchors.filter((k) => !(handers.size === 1 && handers.has(ids.of(k.candidate))));
      // The i-th ticket starts at the i-th anchor, so the checks spread over them.
      for (let j = 0; j < others.length; j++) {
        const k = others[(i + j) % others.length]!;
        const relay = ids.of(k.candidate);
        if (failed.has(relay)) continue;
        const licensed = await inTurn(relay, () => (failed.has(relay) ? Promise.resolve(null) : this.licensed(k.candidate.endpoint, t.ticket.nodeKey)));
        if (licensed === null) {
          failed.add(relay);
          continue;
        }
        verdicts.set(t, licensed ? "licensed" : "unlicensed");
        return;
      }
      verdicts.set(t, "unconfirmed");
    }));
    return verdicts;
  }

  /** Whether `key` holds an active license by the word of the relay at `endpoint`, or null when it cannot say now (no
   *  answer, an error, its heavy reads spent). */
  private async licensed(endpoint: RelayEndpoint, key: string): Promise<boolean | null> {
    try {
      const reply = await this.rpc(endpoint, "license_list", { node_key: key });
      const licenses = (reply.result as { licenses?: unknown } | undefined)?.licenses;
      if (reply.code !== undefined || !Array.isArray(licenses)) return null;
      return licenses.some((l: { node_key?: unknown; status?: unknown } | null) => l?.node_key === key && l?.status === "active");
    } catch {
      return null;
    }
  }

  /** The first of `answered` (fastest first) and the next that is another relay: the two asked for tickets. */
  private static twoRelays(answered: readonly Probed[], ids: Identities): Probed[] {
    const picked: Probed[] = [];
    for (const p of answered) {
      if (picked.length === DISCOVER_FROM) break;
      if (!picked.some((q) => ids.of(q.candidate) === ids.of(p.candidate))) picked.push(p);
    }
    return picked;
  }

  private async look(): Promise<RelayEndpoint[]> {
    const started = this.now();
    const refused: RelayReport["tickets"]["refused"] = {};
    const { list, sources, warnings, entries } = await this.candidates(refused);
    const ids = new Identities();
    for (const c of list) ids.add(c);
    // The first round's probes still under way when the look is done are given up, and none starts after.
    const cancel = new AbortController();
    try {
      const first = this.probeMany(list, ENOUGH_ANSWERED, ids, cancel.signal);
      await first.early;
      const early = [...first.results.values()];
      const genesis = this.settleGenesis(early, ids);
      const answered = early.filter((p) => p.ok).sort((a, b) => a.ms - b.ms);
      const anchors = answered.filter((p) => p.candidate.anchor);
      const askable = RelayFinder.twoRelays(answered, ids);
      let taken = 0;
      let discovered: Probed[] = [];
      // Tickets only where they can be used: two relays to hand them out, and an anchor to confirm what they hand out.
      if (askable.length === DISCOVER_FROM && anchors.length > 0) {
        const handed = await this.discover(askable, refused);
        const verdicts = await this.confirm(handed, anchors, ids);
        const byId = new Map(list.map((c) => [relayId(c.endpoint), c]));
        const named = new Map(answered.map((p) => [p.candidate, relayName(p.candidate.endpoint)]));
        const fresh: Candidate[] = [];
        for (const t of handed) {
          const verdict = verdicts.get(t)!;
          if (verdict !== "licensed") {
            refused[verdict] = (refused[verdict] ?? 0) + 1;
            this.log("warn", "relay_ticket_dropped", { relay: keyName(t.ticket.nodeKey), reason: verdict, from: [...t.from].map((c) => named.get(c)!) });
            continue;
          }
          taken++;
          for (const endpoint of t.endpoints) {
            const known = byId.get(relayId(endpoint));
            if (known === undefined) {
              const c: Candidate = { endpoint, source: "discovered", entry: t.ticket.text, ticket: t.ticket, anchor: false };
              byId.set(relayId(endpoint), c);
              fresh.push(c);
            } else if (known.source !== "given" && newerWord(known, t)) {
              // The same relay by its URL and its pin: kept as this signed, newer ticket. A given one is never replaced,
              // and a ticket of another pin is a relay of its own, tried beside it.
              known.endpoint = endpoint;
              known.entry = t.ticket.text;
              known.ticket = t.ticket;
            }
          }
        }
        sources.discovered = fresh.length;
        const second = this.probeMany(fresh, Number.POSITIVE_INFINITY, ids);
        await second.all;
        discovered = [...second.results.values()];
        for (const p of discovered) this.holdTo(p, genesis);
      }
      // The first round's probes still under way are not waited for.
      const late = list.filter((c) => !early.some((p) => p.candidate === c));
      const lateProbed = late.map((c) => first.results.get(c) ?? {
        candidate: c, ok: false, ms: Math.max(0, this.now() - started), error: "had not answered when the others were done", genesis: null,
      });
      for (const p of lateProbed) this.holdTo(p, genesis);
      return this.conclude(started, [...early, ...lateProbed, ...discovered], sources, warnings, entries, refused, taken);
    } finally {
      cancel.abort();
    }
  }

  /** The look's report, log and outcome: the relays that answered, fastest first, cached; `NoRelayAnswered` when none. */
  private conclude(started: number, all: readonly Probed[], sources: Record<RelaySource, number>, warnings: string[], entries: ReadonlySet<string>,
    refused: RelayReport["tickets"]["refused"], taken: number): RelayEndpoint[] {
    const good = all.filter((p) => p.ok).sort((a, b) => a.ms - b.ms);
    const kept = good.length > 0 ? this.remember(good, entries) : 0;
    const report: RelayReport = {
      network: this.options.network,
      genesis: this.settled ?? this.prefix,
      cache: this.options.cache?.where ?? null,
      kept,
      sources,
      tried: all.map((p) => ({ relay: relayName(p.candidate.endpoint), source: p.candidate.source, ok: p.ok, ms: p.ok ? p.ms : null, error: p.error })),
      discovery: taken > 0 ? "tickets" : "none",
      tickets: { taken, refused },
      answered: [...new Set(good.map((p) => p.candidate.entry).filter((e) => e.startsWith(TICKET_PREFIX)))],
      warnings,
      took_ms: Math.max(0, this.now() - started),
      at: started,
    };
    this.lastReport = report;
    this.lastFind = this.now();
    const sum = (reasons: readonly string[]) => reasons.reduce((n, r) => n + (refused[r as TicketReason | TicketDrop] ?? 0), 0);
    const counts = {
      given: sources.given, cache: sources.cache, entry: sources.entry, discovered: sources.discovered, tried: all.length,
      answered: good.length, discovery: report.discovery, tickets: taken, refused: sum(Object.keys(refused)),
      unconfirmed: sum(["unconfirmed", "unlicensed"]), ms: report.took_ms,
    };
    if (good.length === 0) {
      this.log("warn", "relays_unreachable", counts);
      throw new NoRelayAnswered(report);
    }
    this.log("info", "relays_found", { ...counts, fastest_ms: good[0]!.ms });
    this.found = good.map((p) => p.candidate.endpoint);
    return this.endpoints;
  }

  /** Cache the relays that answered, fastest first, at most `CACHE_MAX`: never an entry point (the release carries them,
   *  and the cache never stands in for one), and a relay found by asking only as its confirmed ticket. How many it kept. */
  private remember(good: readonly Probed[], entries: ReadonlySet<string>): number {
    const cache = this.options.cache;
    if (!cache) return 0;
    const kept: string[] = [];
    for (const p of good) {
      if (entries.has(relayId(p.candidate.endpoint)) || kept.includes(p.candidate.entry)) continue;
      kept.push(p.candidate.entry);
    }
    cache.save(kept.slice(0, CACHE_MAX));
    return Math.min(kept.length, CACHE_MAX);
  }
}

/** Whether `t` is the newer word on the relay `known` already is: its own ticket, handed out over its own pinned
 *  connection, or a newer one of the key its ticket names — never another key's ticket that merely names its URL and pin,
 *  which would give it that key's name and count it as that relay. */
function newerWord(known: Candidate, t: Handed): boolean {
  return (known.ticket === null || known.ticket.issuedAt < t.ticket.issuedAt) &&
    (t.own.has(known) || known.ticket?.nodeKey === t.ticket.nodeKey);
}

/** How logs name the relay of a node key (`relayName`). */
const keyName = (key: string): string => relayName({ url: "", cert_sha256: null, key });

/** Why a ticket's time keeps it out at `now`, or null: dated ahead of this clock, or past its life. */
function timeProblem(text: string, genesis: string | null, now: number): "future" | "expired" | null {
  try {
    readTicket(text, { genesis, now });
    return null;
  } catch (e) {
    return e instanceof TicketRefused && (e.reason === "future" || e.reason === "expired") ? e.reason : null;
  }
}
