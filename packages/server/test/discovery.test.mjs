// Finding relays when the SDK runs (Saltix 41-transport §18.5), against relays this test plays: what was given, the cache,
// then the entry points, probed at once (16 at a time); once three relays answered, tickets from two relays that are not
// one, each checked here, kept only where it names a public address (a name found at one) and an anchor other than the
// one relay that handed it out confirms its license; one relay counted once whatever its names; the genesis adopted only
// where two relays agree, one an anchor; pins never overridden, only relays that answered cached; given tickets past
// their life left out with a warning; a look that found nothing not repeated within the minute; probes given up when
// the look is done; and when nothing answers, an error that names every relay tried and why, by fingerprint, never by
// address.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GivenRelayRefused, NoRelayAnswered, PROBES_AT_ONCE, RelayFinder, RelayGateways, TICKET_PREFIX, TicketRefused, checkGivenRelay,
  fileRelayCache, fromBase32, fromHex, memoryRelayCache, projectRelayCache, publicHost, readTicket, relaysFromEnvironment, sealTicketsAnswer,
  signRelayTicket, toBase32,
} from "../dist/index.js";
import { scratch } from "../../../scripts/scratch.mjs";

const GENESIS = "5a".repeat(32);
const OTHER = "6b".repeat(32);
const NOW = 1_800_000_000_000;
const pin = (n) => n.toString(16).padStart(2, "0").repeat(32);
const url = (n) => `wss://192.0.2.${n}:30335/`;
const endpoint = (n) => ({ url: url(n), cert_sha256: pin(n) });
const text = (n) => `${url(n)}#${pin(n)}`;
const secretOf = (n) => fromHex(pin(n + 100), 32);
const ticket = (n, options = {}) => signRelayTicket({
  secret: secretOf(options.key ?? n), genesis: options.genesis ?? GENESIS, endpoints: options.endpoints ?? [endpoint(n)],
  issuedAt: options.issuedAt ?? NOW - 60_000,
});
const keyOf = (n) => readTicket(ticket(n), { now: NOW }).nodeKey;
/** A ticket whose signature's last byte changed. */
const flipped = (t) => {
  const bytes = fromBase32(t.slice(TICKET_PREFIX.length));
  bytes[bytes.length - 1] ^= 1;
  return TICKET_PREFIX + toBase32(bytes);
};
/** A clock at `NOW` that runs as the wall clock does: answers' times measured, tickets read at the vectors' time. */
const running = () => {
  const start = Date.now();
  return () => NOW + (Date.now() - start);
};
const json = (value) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
const ok = (result) => json({ jsonrpc: "2.0", id: 1, result });
const unknown = () => json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not served here: ask a node of your own" } });
const busy = () => json({ jsonrpc: "2.0", id: 1, error: { code: 6, message: "busy: this relay's heavy reads are spent for now, retry later", data: { retry_after: 3 } } });

/**
 * Relays as `request` sees them, by the number their host ends with (192.0.2.n, relayN.example.net — a name is dialed at
 * the address it was found at, which names the relay too): what each answers (or a failure); every relay shows the
 * certificate `pin(n)`. `unlicensed`: node keys no relay finds an active license for, unless the relay `lies`. Everything
 * asked is in `asked` (with the request's abort signal), and `most` is the most probes (`node_status`) under way at once.
 */
function network(relays, { unlicensed = [] } = {}) {
  const asked = [];
  let under = 0;
  const state = { most: 0 };
  const request = async (e, verb, path, headers, body, options) => {
    const at = e.address ?? new URL(e.url).host;
    const n = Number(/(\d+)(?::\d+)?\/?$/.exec(at)?.[1] ?? /relay(\d+)/.exec(e.url)?.[1]);
    const { method, params } = JSON.parse(Buffer.from(body).toString());
    asked.push({ n, method, params, url: e.url, address: e.address ?? null, timeoutMs: options?.timeoutMs, signal: options?.signal });
    const relay = relays[n];
    if (!relay) throw Object.assign(new Error(`connect ECONNREFUSED 192.0.2.${n}:30335`), { code: "ECONNREFUSED" });
    if (e.cert_sha256 !== null && e.cert_sha256 !== pin(n)) throw new Error("certificate does not match the relay record");
    if (relay.hang) return new Promise(() => {});
    const probe = method === "node_status";
    if (probe) state.most = Math.max(state.most, ++under);
    try {
      if (relay.delay) await new Promise((r) => setTimeout(r, relay.delay));
      if (method === "node_status") return ok({ network: relay.network ?? "devnet", genesis: relay.genesis ?? GENESIS, slot: 1 });
      if (method === "relay_tickets") {
        if (!relay.tickets) return unknown();
        return ok({ sealed: sealTicketsAnswer({ period: 1, self: relay.self ?? null, tickets: relay.tickets }, params.key, relay.genesis ?? GENESIS) });
      }
      if (method === "license_list") {
        if (relay.checks === "busy") return busy();
        if (relay.checks === "down") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        const licenses = !relay.lies && unlicensed.includes(params.node_key) ? [] : [{ node_key: params.node_key, status: "active" }];
        return ok({ epoch: 9, licenses, next: null });
      }
      return ok({ from: n, method });
    } finally {
      if (probe) under--;
    }
  };
  return { request, asked, state, of: (method) => asked.filter((a) => a.method === method) };
}

/** Documentation addresses stand for public ones here; `publicHost` alone refuses them (a test below). */
const documentation = (host) => publicHost(host) || host.startsWith("192.0.2.");
/** Names as this test's DNS answers them: relayN.example.net is found at 192.0.2.N. */
const names = async (name) => {
  const n = /^relay(\d+)\.example\.net$/.exec(name)?.[1];
  if (n === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  return [`192.0.2.${n}`];
};
const finder = (net, options = {}) => new RelayFinder({
  network: "devnet", request: net.request, now: () => NOW, probeMs: 200, entry: [], hostAllowed: documentation, lookup: names, ...options,
});
const cert = (n) => `cert:${pin(n).slice(0, 8)}`;
const key = (n) => `key:${keyOf(n).slice(0, 8)}`;

test("good tickets: two entry points hand out tickets, another relay confirms each license, and what answered is cached fastest first", async () => {
  const events = [];
  const net = network({
    1: { tickets: [ticket(3), ticket(4)], self: ticket(1) }, 2: { tickets: [ticket(3), ticket(4)], self: ticket(2), delay: 5 }, 3: {}, 4: { delay: 10 },
  });
  const cache = memoryRelayCache();
  const f = new RelayFinder({
    network: "devnet", request: net.request, now: running(), probeMs: 500, entry: [text(1), text(2), text(5)], cache, hostAllowed: documentation,
    log: (level, event, meta) => events.push({ level, event, meta }),
  });
  const found = await f.find();
  assert.deepEqual(found.map((e) => e.url).sort(), [url(1), url(2), url(3), url(4)]);
  assert.equal(found.find((e) => e.url === url(3)).key, keyOf(3), "a relay found by its ticket carries its node key");
  const r = f.report;
  assert.equal(r.discovery, "tickets");
  assert.equal(r.tickets.taken, 4, "3 and 4, and each entry point's own");
  assert.deepEqual(r.sources, { given: 0, cache: 0, entry: 3, discovered: 2 });
  assert.equal(r.genesis, GENESIS, "the genesis the relays answered");
  // A ticket one relay alone handed out is checked by another: the entry points' own tickets each by the other one.
  const checked = (k) => net.of("license_list").filter((a) => a.params.node_key === keyOf(k)).map((a) => a.n);
  assert.deepEqual(checked(1), [2]);
  assert.deepEqual(checked(2), [1]);
  assert.equal(checked(3).length, 1, "a ticket both handed out is checked once, by either");
  assert.equal(r.tried.find((t) => t.relay === cert(5)).error, "refused the connection");
  // Only what answered, fastest first, and never an entry point (the release carries it), so the cache never stands in
  // for one.
  const kept = cache.load();
  assert.ok(kept.every((e) => e.startsWith(TICKET_PREFIX)), "the signed tickets");
  assert.deepEqual(kept.map((e) => readTicket(e, { genesis: GENESIS, now: NOW }).endpoints[0].url), [url(3), url(4)], "fastest first");
  // Doctor's report gives the tickets of the relays that answered, the entry points' own once they handed them out.
  assert.deepEqual([...r.answered].sort(), [ticket(1), ticket(2), ticket(3), ticket(4)].sort());
  assert.equal(r.kept, 2, "only 3 and 4: entry points are never cached");
  // The log counts and names relays by fingerprint, never by address; so do the report and the found list's names.
  const found_ = events.find((e) => e.event === "relays_found");
  assert.equal(found_.meta.answered, 4);
  assert.equal(found_.meta.entry, 3);
  assert.equal(found_.meta.tickets, 4);
  assert.ok(!JSON.stringify(events).includes("192.0.2"), "no relay's address in the log");
  assert.ok(!JSON.stringify({ ...r, answered: [] }).includes("192.0.2"), "nor in the report (its tickets are base32)");
});

test("one relay's word is never enough: its tickets are checked by another, and dropped unlicensed or unconfirmed", async () => {
  const events = [];
  const log = (level, event, meta) => events.push({ level, event, meta });
  const net = network({ 1: { tickets: [ticket(3), ticket(4)] }, 2: { tickets: [] }, 3: {}, 4: {} }, { unlicensed: [keyOf(4)] });
  const f = finder(net, { entry: [text(1), text(2)], log });
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(1), url(2), url(3)]);
  assert.deepEqual(f.report.tickets.refused, { unlicensed: 1 });
  assert.deepEqual(net.of("license_list").map((a) => a.n), [2, 2], "never the relay that handed them out");
  assert.equal(net.of("node_status").filter((a) => a.n === 4).length, 0, "an unlicensed relay is never probed");
  const dropped = events.find((e) => e.event === "relay_ticket_dropped");
  assert.deepEqual(dropped.meta, { relay: key(4), reason: "unlicensed", from: [cert(1)] });
  assert.ok(!JSON.stringify(events).includes("192.0.2"));

  // The only other relay cannot check (its heavy reads spent, or down): unconfirmed, not used, and no discovery to show.
  for (const checks of ["busy", "down"]) {
    const quiet = network({ 1: { tickets: [ticket(3)] }, 2: { tickets: [], checks }, 3: {} });
    const g = finder(quiet, { entry: [text(1), text(2)] });
    assert.deepEqual((await g.find()).map((e) => e.url).sort(), [url(1), url(2)], checks);
    assert.deepEqual(g.report.tickets.refused, { unconfirmed: 1 }, checks);
    assert.equal(g.report.discovery, "none", "discovery only when tickets were taken");
    assert.equal(quiet.of("node_status").filter((a) => a.n === 3).length, 0);
  }

  // One relay that answered alone is not asked for tickets: nobody could confirm them.
  const alone = network({ 1: { tickets: [ticket(3)] }, 3: {} });
  const h = finder(alone, { entry: [text(1), text(2)] });
  assert.deepEqual((await h.find()).map((e) => e.url), [url(1)]);
  assert.deepEqual(alone.of("relay_tickets"), []);
});

test("pins are never overridden: another pin for a given URL is a relay of its own, and a cache entry never hides an entry point", async () => {
  // A record (licensed, signed by its own key) naming the given relay's URL under another certificate.
  const repinned = ticket(1, { key: 9, endpoints: [{ url: url(1), cert_sha256: pin(9) }] });
  const net = network({ 1: { tickets: [] }, 2: { tickets: [repinned], self: ticket(2) }, 3: { tickets: [] } });
  const f = finder(net, { given: [text(1)], entry: [text(2), text(3)] });
  const found = await f.find();
  assert.deepEqual(found.map((e) => [e.url, e.cert_sha256]).sort(), [[url(1), pin(1)], [url(2), pin(2)], [url(3), pin(3)]]);
  const tries = f.report.tried.filter((t) => t.relay === cert(1) || t.relay === key(9));
  assert.deepEqual(tries.map((t) => [t.relay, t.source, t.ok]), [[cert(1), "given", true], [key(9), "discovered", false]]);
  assert.match(tries[1].error, /showed another certificate than its pin/);
  // The entry point's own ticket, the same URL and pin, names it now (by its key), and is still never cached.
  assert.equal(found.find((e) => e.url === url(2)).key, keyOf(2));

  const cache = memoryRelayCache();
  cache.save([`${url(2)}#${pin(9)}`]);
  const g = finder(network({ 2: { tickets: [] } }), { entry: [text(2)], cache });
  assert.deepEqual((await g.find()).map((e) => [e.url, e.cert_sha256]), [[url(2), pin(2)]]);
  assert.deepEqual(g.report.sources, { given: 0, cache: 1, entry: 1, discovered: 0 }, "both tried");
  assert.deepEqual(cache.load(), [], "neither the cache's entry that failed nor the entry point is kept");
});

test("bounds: an answer gives its relay's own ticket and five, never more; a ticket naming no public address is dropped; 16 probes at once", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ticket(10 + i));
  const relays = { 1: { tickets: many, self: ticket(1) }, 2: { tickets: [] } };
  for (let n = 10; n < 19; n++) relays[n] = {};
  const net = network(relays);
  const f = finder(net, { entry: [text(1), text(2)] });
  await f.find();
  assert.deepEqual(f.report.tickets.refused, { extra: 4 });
  assert.equal(f.report.tickets.taken, 6);
  assert.deepEqual([...new Set(net.of("node_status").map((a) => a.n))].sort((a, b) => a - b), [1, 2, 10, 11, 12, 13, 14]);

  // By default only public hosts: a documentation address is no relay's.
  const plain = network({ 1: { tickets: [ticket(3)] }, 2: { tickets: [ticket(3)] }, 3: {} });
  const g = new RelayFinder({ network: "devnet", request: plain.request, now: () => NOW, probeMs: 200, entry: [text(1), text(2)] });
  assert.deepEqual((await g.find()).map((e) => e.url).sort(), [url(1), url(2)]);
  assert.deepEqual(g.report.tickets.refused, { private: 1 });
  assert.equal(plain.of("license_list").length, 0, "not even checked");
  // A given relay may be private: a person's own.
  const own = new RelayFinder({ network: "devnet", request: plain.request, now: () => NOW, probeMs: 200, given: [ticket(3)], entry: [] });
  assert.deepEqual((await own.find()).map((e) => e.url), [url(3)]);

  // However many candidates, at most 16 probes are under way.
  const crowd = {};
  for (let n = 30; n < 60; n++) crowd[n] = { delay: 20 };
  const busy = network(crowd);
  const h = finder(busy, { entry: Object.keys(crowd).map((n) => text(Number(n))) });
  assert.ok((await h.find()).length >= 3);
  assert.equal(busy.state.most, PROBES_AT_ONCE);
});

test("discovery goes on once three relays answered: the slowest probe is not waited for", async () => {
  const net = network({ 1: { tickets: [] }, 2: { tickets: [] }, 3: {}, 4: { hang: true } });
  const f = finder(net, { probeMs: 1_500, entry: [text(1), text(2), text(3), text(4)] });
  const started = Date.now();
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(1), url(2), url(3)]);
  assert.ok(Date.now() - started < 1_000, "well within the hanging relay's deadline");
  assert.equal(f.report.tried.find((t) => t.relay === cert(4)).error, "had not answered when the others were done");
});

test("a given relay that cannot be one stops the start; a given ticket past its life is left out with a warning", async () => {
  const net = network({ 2: { tickets: [] } });
  const refused = (given, reason, options = {}) => assert.throws(() => finder(net, { given, ...options }),
    (e) => e instanceof GivenRelayRefused && e.reason === reason && !/192\.0\.2/.test(e.message), `${reason}: ${given}`);
  refused([text(2), flipped(ticket(1))], "signature");
  refused(["wss://192.0.2.1:30335/#abc"], "form");
  refused(["wss://192.0.2.1:30335/"], "form"); // an address without its pin: a pin forgotten
  refused(["SALTIX-RELAY:not base32!"], "encoding");
  refused([ticket(1, { genesis: OTHER })], "network", { genesis: GENESIS });
  assert.deepEqual(net.asked, [], "nothing asked before the developer's typo is fixed");
  assert.equal(checkGivenRelay(ticket(1).toLowerCase()), ticket(1), "a ticket in either case");
  assert.equal(checkGivenRelay("wss://relay7.example.net/"), "wss://relay7.example.net/", "a name behind a CA's certificate");

  const events = [];
  const old = ticket(1, { issuedAt: NOW - 31 * 86_400_000 });
  const f = finder(net, { given: [old], entry: [text(2)], log: (level, event, meta) => events.push({ event, meta }) });
  assert.deepEqual((await f.find()).map((e) => e.url), [url(2)], "the entry points still serve");
  assert.equal(f.report.sources.given, 0);
  assert.match(f.report.warnings[0], new RegExp(`relay ${key(1)} is left out: .*past its life.*new one`));
  assert.deepEqual(events.find((e) => e.event === "relay_given_skipped").meta, { relay: key(1), reason: "expired" });
  const ahead = finder(network({}), { given: [ticket(1, { issuedAt: NOW + 11 * 60_000 })] });
  const error = await ahead.find().then(() => null, (e) => e);
  assert.ok(error instanceof NoRelayAnswered);
  assert.match(error.message, /left out: .*check the clock/, "said with the way out, never thrown at start");
});

test("all dead: the error names every source and every relay with its result, by fingerprint, never by address", async () => {
  const net = network({ 2: { hang: true }, 3: {}, 4: { network: "testnet" }, 5: { genesis: OTHER } });
  const f = finder(net, { given: [text(5)], entry: [text(1), text(2), `${url(3)}#${pin(99)}`, text(4)], genesis: GENESIS });
  const error = await f.find().then(() => null, (e) => e);
  assert.ok(error instanceof NoRelayAnswered, String(error));
  const m = error.message;
  assert.match(m, /no relay of devnet answered \(5 tried/);
  assert.match(m, new RegExp(`relay ${cert(1)} \\(the release's entry point\\): refused the connection`));
  assert.match(m, new RegExp(`relay ${cert(2)} \\(the release's entry point\\): no answer within 200 ms`));
  assert.match(m, new RegExp(`relay ${cert(99)} \\(the release's entry point\\): showed another certificate than its pin`));
  assert.match(m, new RegExp(`relay ${cert(4)} \\(the release's entry point\\): is on testnet, not devnet`));
  assert.match(m, new RegExp(`relay ${cert(5)} \\(given\\): is on another devnet`));
  assert.match(m, /--relay SALTIX-RELAY:/, "and the way out");
  assert.ok(!/192\.0\.2/.test(m) && !JSON.stringify(error.report).includes("192.0.2"), "no relay's address");
  assert.equal(error.report.tried.length, 5);
  assert.ok(error.report.took_ms < 5_000);
});

test("a ticket naming an endpoint behind a CA's certificate is used, the certificate left to the CAs Node trusts", async () => {
  const ca = ticket(7, { endpoints: [{ url: "wss://relay7.example.net/", cert_sha256: null }] });
  const net = network({ 1: { tickets: [ca] }, 2: { tickets: [ca] }, 7: {} });
  const f = finder(net, { entry: [text(1), text(2)] });
  const found = await f.find();
  assert.deepEqual(found.find((e) => e.url === "wss://relay7.example.net/"), { url: "wss://relay7.example.net/", cert_sha256: null, key: keyOf(7), address: "192.0.2.7" },
    "its name found at a public address, dialed there");
  assert.ok(publicHost("relay7.example.net"), "a public name");
});

test("public hosts as the node judges them: no loopback, private, link-local, CGNAT, documentation or multicast address, nor a name for none", () => {
  // Public IPv4 addresses built from their numbers, at the edges of the ranges that are not: no address of anyone's stands
  // in this text (no-relay-list.test.mjs).
  const v4 = (...octets) => octets.join(".");
  for (const host of [v4(100, 63, 255, 255), v4(100, 128, 0, 0), v4(172, 15, 255, 255), v4(172, 32, 0, 1), v4(223, 255, 255, 255),
    "[2a00:1450:4001::1]", "2001:4860:4860::8888", "::ffff:808:808", `::ffff:${v4(8, 8, 4, 4)}`, "64:ff9b::808:808", "2002:808:808::1",
    "relay.example.net", "relay.saltix.io."]) {
    assert.ok(publicHost(host), host);
  }
  for (const host of ["0.1.2.3", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.0.8", "192.0.2.1",
    "198.51.100.7", "203.0.113.9", "198.18.0.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "::", "::1", "[::1]",
    "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "100::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::10.1.2.3", "64:ff9b::a00:1", "2002:a00:1::1", "localhost", "relay.localhost", "nas.local", "intranet", "router.home.arpa",
    "relay.internal", "relay.test", "relay.example", "relay.invalid"]) {
    assert.ok(!publicHost(host), host);
  }
});

test("an unreachable entry point: the cache's tickets answer, used as they are — no anchor answers, so nothing they hand out is", async () => {
  const dir = scratch("relay-cache-");
  const path = join(dir, ".grain", "relays.json");
  const cache = fileRelayCache(path, "devnet");
  cache.save([ticket(5), ticket(6)]);
  assert.equal(statSync(path).mode & 0o777, process.platform === "win32" ? statSync(path).mode & 0o777 : 0o600, "owner-only");
  const net = network({ 5: { tickets: [ticket(7)] }, 6: { tickets: [] }, 7: {} });
  const f = finder(net, { entry: [text(1), text(2)], cache });
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(5), url(6)]);
  assert.deepEqual(net.of("relay_tickets"), [], "a cached relay confirms nothing: no anchor answered, so no tickets are asked for");
  assert.equal(f.report.sources.cache, 2);
  assert.equal(f.report.cache, path);
  assert.equal(f.report.kept, 2);
  const kept = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(kept.network, "devnet");
  assert.equal(kept.relays.length, 2);
  assert.deepEqual(fileRelayCache(path, "testnet").load(), [], "another network's cache is empty");
  writeFileSync(path, "{not json");
  assert.deepEqual(fileRelayCache(path, "devnet").load(), [], "a cache that does not read is empty");
  assert.equal(projectRelayCache(dir, "devnet").where, path, "a project's cache is .grain/relays.json");
  assert.equal(projectRelayCache(join(dir, "nowhere"), "devnet").where, null, "outside a project, memory");
});

test("a ticket whose signature does not verify, or of another network, or past its life, is refused and never probed", async () => {
  const bytes = fromBase32(ticket(5).slice(TICKET_PREFIX.length));
  const at = Buffer.from(bytes).indexOf(Buffer.from("192.0.2.5"));
  bytes[at + 8] = "6".charCodeAt(0); // now names 192.0.2.6, under 5's signature
  const forged = TICKET_PREFIX + toBase32(bytes);
  const handed = [forged, ticket(7, { genesis: OTHER }), ticket(8, { issuedAt: NOW - 31 * 86_400_000 })];
  const net = network({ 1: { tickets: handed }, 2: { tickets: handed }, 6: {}, 7: {}, 8: {} });
  const f = finder(net, { entry: [text(1), text(2)] });
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(1), url(2)]);
  assert.deepEqual(f.report.tickets.refused, { signature: 1, network: 1, expired: 1 }, "each counted once");
  assert.ok(!net.asked.some((a) => [6, 7, 8].includes(a.n)), "a refused ticket's relay is never asked");
});

test("gateways find again when every relay they found stops answering, at most once a minute", async () => {
  let now = NOW;
  const relays = { 1: { tickets: [] }, 3: { tickets: [] } };
  const net = network(relays);
  const f = new RelayFinder({ network: "devnet", request: net.request, now: () => now, probeMs: 200, entry: [text(1), text(3)] });
  delete relays[3];
  const g = new RelayGateways([], net.request, { finder: f });
  assert.deepEqual(await g.call("grain_get", { slug: "x" }), { from: 1, method: "grain_get" });
  assert.deepEqual(g.endpoints.map((e) => e.url), [url(1)]);
  delete relays[1];
  relays[3] = { tickets: [] };
  await assert.rejects(g.call("grain_get", { slug: "x" }), /no relay answered/, "within the minute it does not look again");
  now += 60_000;
  assert.deepEqual(await g.call("grain_get", { slug: "x" }), { from: 3, method: "grain_get" }, "then it does, and the next one answers");
  assert.deepEqual(g.endpoints.map((e) => e.url), [url(3)]);
});

test("the probe's deadline holds whatever a relay does", async () => {
  const net = network({ 1: { hang: true }, 2: {} });
  const started = Date.now();
  const f = new RelayFinder({ network: "devnet", request: net.request, probeMs: 150, entry: [text(1), text(2)] });
  assert.deepEqual((await f.find()).map((e) => e.url), [url(2)]);
  assert.ok(Date.now() - started < 2_000, "all at once, each within its deadline");
  assert.match(f.report.tried.find((t) => t.relay === cert(1)).error, /no answer within/);
});

test("SALTIX_RELAYS gives tickets or endpoints, apart by spaces or commas", () => {
  assert.deepEqual(relaysFromEnvironment({ SALTIX_RELAYS: ` ${text(1)},${text(2)}\n${ticket(3)} ` }), [text(1), text(2), ticket(3)]);
  assert.deepEqual(relaysFromEnvironment({}), []);
});

test("a refused ticket says why in a person's words", () => {
  assert.throws(() => readTicket(ticket(1), { now: NOW + 31 * 86_400_000 }), (e) => e instanceof TicketRefused && e.reason === "expired");
});

test("one relay is one relay whatever its names: its ticket's key counts it once, it is asked for tickets once, and it never confirms", async () => {
  // F (relay 5, licensed) lies about licenses and is cached under one ticket naming four ports of its server; it hands
  // out tickets of keys nobody licensed (its sybils, relays 20 to 24). The entry points 1 and 2 are honest anchors.
  const four = [30335, 30336, 30337, 30338].map((port) => ({ url: `wss://192.0.2.5:${port}/`, cert_sha256: pin(5) }));
  const fTicket = ticket(5, { endpoints: four });
  const sybils = [20, 21, 22, 23, 24];
  const relays = { 1: { delay: 20, tickets: [] }, 2: { delay: 20, tickets: [] }, 5: { lies: true, self: fTicket, tickets: sybils.map((n) => ticket(n)) } };
  for (const n of sybils) relays[n] = {};
  const net = network(relays, { unlicensed: sybils.map(keyOf) });
  const cache = memoryRelayCache();
  cache.save([fTicket]);
  const f = new RelayFinder({
    network: "devnet", request: net.request, now: running(), probeMs: 1_000, entry: [text(1), text(2)], cache, hostAllowed: documentation, lookup: names,
  });
  const found = await f.find();
  assert.equal(found.filter((e) => /192\.0\.2\.2[0-4]:/.test(e.url)).length, 0, "no sybil of the one relay F is taken");
  assert.deepEqual(f.report.tickets.refused, { unlicensed: 5 });
  // F's four names answered first, yet the look waited for the anchors: three relays, not three names.
  assert.ok(found.some((e) => e.url === url(1)) && found.some((e) => e.url === url(2)), "the honest entry points answered and serve");
  const asked = net.of("relay_tickets").map((a) => a.n);
  assert.equal(asked.length, 2);
  assert.equal(asked.filter((n) => n === 5).length, 1, "F is asked for tickets once, under whichever of its names");
  assert.ok(net.of("license_list").every((a) => a.n === 1 || a.n === 2), "only anchors confirm: never F, a cached relay");
  assert.ok(cache.load().every((t) => !sybils.some((n) => readTicket(t, { now: NOW }).nodeKey === keyOf(n))), "nor are they cached");

  // The same server under two endpoints given apart, as one host and port, is one relay too: no anchor besides it answers,
  // so nothing is asked for.
  const alone = network({ 5: { tickets: sybils.map((n) => ticket(n)) } });
  const g = finder(alone, { given: [`wss://192.0.2.5:30335/#${pin(5)}`, `wss://192.0.2.5:30335/a#${pin(5)}`] });
  assert.equal((await g.find()).length, 2);
  assert.deepEqual(alone.of("relay_tickets"), [], "one relay alone, under two names: no tickets, which nobody else could confirm");
});

test("a ticket naming one host and port twice is refused: given, cached or handed out", async () => {
  const twice = ticket(5, { endpoints: [endpoint(5), { url: "wss://192.0.2.5:30335/a", cert_sha256: pin(5) }] });
  assert.throws(() => finder(network({}), { given: [twice] }), (e) => e instanceof GivenRelayRefused && e.reason === "repeated" && /one host and port twice/.test(e.message));
  const cache = memoryRelayCache();
  cache.save([twice]);
  const net = network({ 1: { tickets: [twice] }, 2: { tickets: [] }, 5: {} });
  const f = finder(net, { entry: [text(1), text(2)], cache });
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(1), url(2)]);
  assert.deepEqual(f.report.tickets.refused, { repeated: 2 }, "the cached one and the one handed out");
  assert.equal(net.of("node_status").filter((a) => a.n === 5).length, 0);
});

test("a ticket naming an endpoint no connection can dial is refused, never a crash: given, cached or handed out", async () => {
  // Both readers take any wss:// text within the bounds; `wss://a b/` is no URL (the review of 2026-11-04: one such
  // ticket stopped every look with a bare "Invalid URL", and a server restarted in a loop).
  const bad = ticket(5, { endpoints: [endpoint(5), { url: "wss://a b/", cert_sha256: pin(5) }] });
  assert.throws(() => finder(network({}), { given: [bad] }), (e) => e instanceof GivenRelayRefused && e.reason === "endpoint" && /no URL a connection can dial/.test(e.message));
  assert.throws(() => finder(network({}), { given: [`wss://[zz]:30335/#${pin(5)}`] }), (e) => e instanceof GivenRelayRefused && e.reason === "form");
  const cache = memoryRelayCache();
  cache.save([bad]);
  const net = network({ 1: { tickets: [bad] }, 2: { tickets: [] }, 5: {} });
  const f = finder(net, { entry: [text(1), text(2)], cache });
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(1), url(2)]);
  assert.deepEqual(f.report.tickets.refused, { endpoint: 2 }, "the cached one and the one handed out");
  assert.equal(net.of("node_status").filter((a) => a.n === 5).length, 0);
});

test("a relay's name looked up within a probe's deadline: one that never resolves holds no look", async () => {
  // A ticket handed out names relay 7 by a name whose lookup never settles (the review of 2026-11-04: a look waited
  // for it for minutes, saying nothing). It is dropped as naming no public address once the probe's time is out.
  const named = ticket(7, { endpoints: [{ url: "wss://relay7.example.net:30335/", cert_sha256: pin(7) }] });
  const net = network({ 1: { tickets: [named] }, 2: { tickets: [] }, 7: {} });
  const started = Date.now();
  const f = finder(net, { entry: [text(1), text(2)], lookup: (name) => (name.startsWith("relay7.") ? new Promise(() => {}) : names(name)) });
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(1), url(2)]);
  assert.ok(Date.now() - started < 3_000, "within the probe's deadline, not the lookup's own");
  assert.deepEqual(f.report.tickets.refused, { private: 1 });
});

test("only anchors confirm licenses: a cached relay never does, and with no anchor answering nothing handed out is used", async () => {
  // Relays 5 and 6 are cached, the entry points down: their tickets cannot be confirmed by anyone the person or the
  // release vouches for, so none is asked for, while 5 and 6 themselves serve.
  const net = network({ 5: { tickets: [ticket(7)], lies: true }, 6: { tickets: [ticket(7)], lies: true }, 7: {} });
  const cache = memoryRelayCache();
  cache.save([ticket(5), ticket(6)]);
  const f = finder(net, { entry: [text(1), text(2)], cache });
  assert.deepEqual((await f.find()).map((e) => e.url).sort(), [url(5), url(6)]);
  assert.deepEqual(net.of("relay_tickets"), []);
  assert.deepEqual(net.of("license_list"), []);
  // A given relay is an anchor: with it answering, what the cached relays hand out is confirmed by it alone.
  const given = network({ 3: { tickets: [] }, 5: { tickets: [ticket(7)], lies: true }, 6: { tickets: [ticket(7)], lies: true }, 7: {} }, { unlicensed: [keyOf(7)] });
  const g = finder(given, { given: [text(3)], entry: [], cache });
  await g.find();
  assert.deepEqual(given.of("license_list").map((a) => a.n), [3], "the given relay, never the cached ones that say yes to anything");
  assert.deepEqual(g.report.tickets.refused, { unlicensed: 1 });
});

test("the genesis is adopted only where two relays agree, one an anchor: a fastest relay's word never refuses honest relays", async () => {
  // A (relay 5, cached) answers fastest with the app key's 16 digits and a tail of its own.
  const LIE = GENESIS.slice(0, 16) + "ee".repeat(24);
  const net = network({ 1: { delay: 20, tickets: [] }, 2: { delay: 20, tickets: [] }, 3: { delay: 20, tickets: [] }, 5: { genesis: LIE, tickets: [] } });
  const cache = memoryRelayCache();
  cache.save([ticket(5)]);
  let now = NOW;
  const f = new RelayFinder({
    network: "devnet", genesis: GENESIS.slice(0, 16), request: net.request, now: () => now, probeMs: 1_000, entry: [text(1), text(2), text(3)], cache,
    hostAllowed: documentation, lookup: names,
  });
  const first = await f.find();
  assert.equal(f.genesis, GENESIS, "the anchors' genesis, agreed by three");
  assert.ok(!first.some((e) => e.url === url(5)), "A is on another network");
  now += 61_000;
  const second = await f.refresh();
  assert.deepEqual(second.map((e) => e.url).sort(), [url(1), url(2), url(3)], "the honest entry points still serve");
  // One anchor alone answering: its genesis serves this look but is not adopted.
  const lone = network({ 1: { tickets: [] } });
  const g = finder(lone, { genesis: GENESIS.slice(0, 16), entry: [text(1), text(2)] });
  assert.deepEqual((await g.find()).map((e) => e.url), [url(1)]);
  assert.equal(g.genesis, null, "one relay's word extends no prefix");
  assert.equal(g.report.genesis, GENESIS.slice(0, 16));
  // A genesis that is not 64 lower-case hex digits is no answer.
  const upper = network({ 1: { genesis: GENESIS.toUpperCase() }, 2: { genesis: GENESIS.slice(0, 63) } });
  const h = finder(upper, { entry: [text(1), text(2)] });
  const error = await h.find().then(() => null, (e) => e);
  assert.ok(error instanceof NoRelayAnswered && /no genesis of 64 lower-case hex digits/.test(error.message));
});

test("with no genesis known (the command line), one relay's names do not out-vote the anchors' genesis", async () => {
  const FAKE = "7c".repeat(32);
  const four = [30335, 30336, 30337, 30338].map((port) => ({ url: `wss://192.0.2.5:${port}/`, cert_sha256: pin(5) }));
  const fTicket = ticket(5, { endpoints: four, genesis: FAKE });
  const net = network({ 1: { delay: 20 }, 2: { delay: 20 }, 5: { genesis: FAKE } });
  const cache = memoryRelayCache();
  cache.save([fTicket]);
  const f = new RelayFinder({ network: "devnet", request: net.request, now: running(), probeMs: 1_000, entry: [text(1), text(2)], cache, hostAllowed: documentation });
  const found = await f.find();
  assert.equal(f.genesis, GENESIS, "the entry points' genesis");
  assert.deepEqual(found.map((e) => e.url).sort(), [url(1), url(2)]);
});

test("a cached ticket is held to the public rule as when it was handed out; only what the person gave is exempt", async () => {
  const mixed = ticket(7, { endpoints: [endpoint(7), { url: "wss://127.0.0.1:30335/", cert_sha256: pin(7) }, { url: "wss://10.0.0.7:30335/", cert_sha256: pin(7) }] });
  const net = network({ 1: { tickets: [mixed] }, 2: { tickets: [] }, 7: {} });
  const cache = memoryRelayCache();
  await finder(net, { entry: [text(1), text(2)], cache }).find();
  const dialed = () => net.asked.filter((a) => /127\.0\.0\.1|10\.0\.0\.7/.test(a.url)).length;
  assert.equal(dialed(), 0, "dropped when handed out");
  assert.ok(cache.load().includes(mixed), "cached as the whole ticket");
  await finder(net, { entry: [text(1), text(2)], cache }).find();
  assert.equal(dialed(), 0, "and from the cache on the next run");
  // Given, the same ticket's private endpoints are the person's own.
  await finder(net, { given: [mixed], entry: [], cache: null }).find();
  assert.ok(dialed() > 0);
});

test("a name in a ticket handed out is found before it is dialed: every address public, the connection to the first", async () => {
  const lan = async (name) => (name === "relay8.example.net" ? ["192.168.1.8"] : names(name));
  const named = (n, host = `relay${n}.example.net`) => ticket(n, { endpoints: [{ url: `wss://${host}:30335/`, cert_sha256: pin(n) }] });
  const net = network({ 1: { tickets: [named(7), named(8), named(9, "nowhere9.example.net")] }, 2: { tickets: [] }, 7: {}, 8: {} });
  const f = finder(net, { entry: [text(1), text(2)], lookup: lan });
  const found = await f.find();
  const seven = found.find((e) => e.url === "wss://relay7.example.net:30335/");
  assert.equal(seven.address, "192.0.2.7", "dialed at the address its name was found at");
  assert.ok(net.of("node_status").some((a) => a.address === "192.0.2.7"));
  assert.ok(!found.some((e) => /relay8/.test(e.url)), "a name found at a private address is no relay's");
  assert.deepEqual(f.report.tickets.refused, { private: 2 }, "nor is one that is not found");
  assert.ok(!net.of("node_status").some((a) => /relay8|nowhere9/.test(a.url)));
});

test("a look that found nothing is not repeated within the minute: its error comes again", async () => {
  let now = NOW;
  const net = network({});
  const f = new RelayFinder({ network: "devnet", request: net.request, now: () => now, probeMs: 200, entry: [text(1), text(2), text(3)] });
  const g = new RelayGateways([], net.request, { finder: f });
  const errors = [];
  for (let i = 0; i < 5; i++) errors.push(await g.call("node_status").then(() => null, (e) => e));
  assert.ok(errors.every((e) => e instanceof NoRelayAnswered) && errors.every((e) => e === errors[0]), "the same error each time");
  assert.equal(net.of("node_status").length, 3, "one look: each entry point probed once");
  now += 60_000;
  await assert.rejects(f.refresh(), NoRelayAnswered);
  assert.equal(net.of("node_status").length, 6, "a minute on, a new look");
});

test("probes still under way when the look is done are given up, and none starts after it", async () => {
  const relays = { 1: { tickets: [] }, 2: { tickets: [] }, 3: {} };
  for (let n = 30; n < 60; n++) relays[n] = { hang: true };
  const net = network(relays);
  const f = finder(net, { probeMs: 2_000, entry: [text(1), text(2), text(3), ...Object.keys(relays).filter((n) => n >= 30).map((n) => text(Number(n)))] });
  const started = Date.now();
  await f.find();
  assert.ok(Date.now() - started < 1_000, "on once three answered");
  const probes = net.of("node_status");
  assert.ok(probes.length < 33, "not every candidate was probed");
  assert.ok(probes.filter((a) => a.n >= 30).every((a) => a.signal.aborted), "those still under way given up, their sockets with them");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(net.of("node_status").length, probes.length, "and none started after the look");
});

test("an anchor under two names never confirms what it alone handed out: its other name is the same relay", async () => {
  // Entry point 5 is listed under two paths of one server and says yes to every license; entry point 1 is honest.
  const net = network({ 1: { delay: 10, tickets: [] }, 5: { lies: true, tickets: [ticket(7)] }, 7: {} }, { unlicensed: [keyOf(7)] });
  const f = finder(net, { entry: [text(5), `wss://192.0.2.5:30335/a#${pin(5)}`, text(1)] });
  await f.find();
  assert.deepEqual(net.of("license_list").map((a) => a.n), [1], "the honest anchor checks it, never the hander's other name");
  assert.deepEqual(f.report.tickets.refused, { unlicensed: 1 });
});

test("with no anchor answering and no genesis known, each relay votes once whatever its names", async () => {
  const FAKE = "7c".repeat(32);
  const four = [30335, 30336, 30337, 30338].map((port) => ({ url: `wss://192.0.2.5:${port}/`, cert_sha256: pin(5) }));
  const net = network({ 5: { genesis: FAKE }, 6: {}, 7: {} });
  const cache = memoryRelayCache();
  cache.save([ticket(5, { endpoints: four, genesis: FAKE }), ticket(6), ticket(7)]);
  const f = finder(net, { entry: [text(1)], cache });
  const found = await f.find();
  assert.deepEqual(found.map((e) => e.url).sort(), [url(6), url(7)], "two relays out-vote one relay's four names");
  assert.equal(f.genesis, null, "and no anchor agreed, so nothing is adopted");
});

test("another key's ticket naming a known relay's URL and pin never renames it: only its own ticket, or a newer one of its key", async () => {
  // Relay 9 (licensed) gets entry point 1 to hand out a ticket of its key, newer than 1's own, that names the cached relay
  // 5's URL and pin, and entry point 1's, beside its own; relay 6 is cached under an older ticket of its key, and entry
  // point 2 hands out a newer one. The entry points answer first, so they are the two asked; relay 9's slower answer lets
  // 5 and 6 answer within the look.
  const squatter = ticket(9, { endpoints: [endpoint(5), endpoint(1), endpoint(9)], issuedAt: NOW - 30_000 });
  const older = ticket(6, { issuedAt: NOW - 120_000 });
  const net = network({
    1: { tickets: [squatter], self: ticket(1) }, 2: { tickets: [ticket(6)], self: ticket(2) }, 5: { delay: 20 }, 6: { delay: 20 }, 9: { delay: 60 },
  });
  const cache = memoryRelayCache();
  cache.save([text(5), older]);
  const f = finder(net, { entry: [text(1), text(2)], cache });
  await f.find();
  assert.deepEqual(f.report.tried.filter((t) => t.ok).map((t) => t.relay).sort(), [key(1), key(2), cert(5), key(6), key(9)].sort());
  assert.equal(f.endpoints.find((e) => e.url === url(5)).key, undefined, "relay 5 keeps its name: relay 9's key is not its");
  assert.equal(f.endpoints.find((e) => e.url === url(9)).key, keyOf(9), "relay 9 is found at its own endpoint");
  assert.ok(cache.load().includes(text(5)), "relay 5 is cached as it was, not as relay 9's ticket");
  assert.equal(f.endpoints.find((e) => e.url === url(6)).key, keyOf(6));
  assert.ok(cache.load().includes(ticket(6)) && !cache.load().includes(older), "relay 6's newer ticket of its own key takes its place");
  assert.equal(f.endpoints.find((e) => e.url === url(1)).key, keyOf(1), "an entry point is named by the ticket it handed out as its own, not by another it handed out");
});
