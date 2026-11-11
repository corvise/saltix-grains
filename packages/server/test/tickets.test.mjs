// vectors/relay-tickets-v1.json (Saltix 41-transport §18): relay tickets as the node writes them — a relay's own signed
// record with the network it serves — read and refused here exactly as every reader does, and relay_tickets' answer
// sealed to the requester's one-time key opened as the node sealed it.
import test from "node:test";
import assert from "node:assert/strict";
import { x25519 } from "@noble/curves/ed25519";
import {
  MAX_TICKET_BYTES, TICKET_PREFIX, TICKETS, TICKETS_SEAL_DOMAIN, TicketRefused, derive, fromBase32, fromHex, isTicketText, openTicketsAnswer,
  publicHost, readTicket, sealTicketsAnswer, signRelayTicket, ticketProblem, toBase32, toHex,
} from "../dist/index.js";
import { goldenVectors } from "../../../scripts/vectors.mjs";

const v = goldenVectors("relay-tickets-v1.json");

test("the vectors' constants are the SDK's", () => {
  assert.equal(v.prefix, TICKET_PREFIX);
  assert.equal(v.ticket_version, 1);
  assert.equal(v.life_ms, 30 * 86_400_000);
  assert.equal(v.domains.seal, TICKETS_SEAL_DOMAIN);
  assert.equal(v.choice.tickets, TICKETS, "an answer's tickets, which the SDK takes at most (and the relay's own)");
  assert.equal(v.max_ticket_bytes, MAX_TICKET_BYTES);
});

test("the largest ticket the bounds allow reads; a byte past the bound is refused before it is decoded", () => {
  const largest = v.tickets.find((t) => t.name === "the largest the bounds allow");
  assert.ok(largest, "the vector at the bound");
  assert.equal(largest.bytes.length / 2, 1145);
  assert.ok(readTicket(largest.text, { genesis: v.network, now: v.at }));
  const over = v.refused.find((r) => r.reason === "encoding" && /longer than a ticket may be/.test(r.name));
  assert.ok(over && fromBase32(over.text.slice(TICKET_PREFIX.length)).length === MAX_TICKET_BYTES + 1);
});

test("a public host is the node's: both read the vectors' hosts alike", () => {
  assert.ok(v.public_hosts.length >= 50);
  for (const { host, public: expected } of v.public_hosts) assert.equal(publicHost(host), expected, host);
});

test("every good ticket reads as the node wrote it: the record's endpoints, pins, key and life", () => {
  assert.ok(v.tickets.length >= 2);
  for (const t of v.tickets) {
    const read = readTicket(t.text, { genesis: v.network, now: v.at });
    assert.equal(read.text, t.text, t.name);
    assert.equal(read.network, v.network.slice(0, 16));
    assert.equal(read.recordVersion, t.record_version);
    assert.equal(read.nodeKey, t.node_key);
    assert.equal(read.issuedAt, t.issued_at);
    assert.equal(read.expiresAt, t.expires_at);
    assert.deepEqual(read.endpoints, t.endpoints);
    assert.equal(toHex(fromBase32(t.text.slice(TICKET_PREFIX.length))), t.bytes, "its bytes");
    const domain = t.record_version === 2 ? v.domains.record_v2 : v.domains.record_v3;
    assert.equal(toHex(derive(domain, fromHex(t.body_borsh))), t.signing_message, "the record's signing message");
    assert.equal(readTicket(t.text.toLowerCase(), { genesis: v.network, now: v.at }).text, t.text, "either case");
    assert.ok(readTicket(t.text, { now: v.at }), "a reader that knows no genesis yet takes it");
    assert.ok(isTicketText(t.text));
  }
});

test("every refused ticket is refused for its reason, in the readers' order", () => {
  const reasons = new Set(v.refused.map((r) => r.reason));
  for (const reason of ["prefix", "encoding", "version", "network", "record", "bounds", "signature", "future", "expired", "unreachable"]) {
    assert.ok(reasons.has(reason), `a vector refused for ${reason}`);
  }
  for (const r of v.refused) {
    assert.equal(ticketProblem(r.text, { genesis: r.network, now: r.now }), r.reason, r.name);
    assert.throws(() => readTicket(r.text, { genesis: r.network, now: r.now }), (e) => e instanceof TicketRefused && e.reason === r.reason);
  }
});

test("a text reads by ASCII's case and Rust's whitespace alone, as the node reads it", () => {
  assert.ok(v.taken.length >= 3);
  for (const t of v.taken) {
    assert.equal(readTicket(t.text, { genesis: v.network, now: v.at }).text, t.reads_as, t.name);
    assert.ok(isTicketText(t.text), t.name);
  }
  // What a reader that upper-cases all of Unicode (ſ as S, ı as I) or trims as JavaScript does (U+FEFF) would take:
  // refused here as the node refuses it, each vector for its reason (the test above), the prefix's at its prefix too.
  for (const letter of ["ſ", "ı", "\ufeff"]) {
    const refused = v.refused.filter((r) => r.text.includes(letter));
    assert.ok(refused.length >= 2, `${JSON.stringify(letter)}: in the prefix or before it, and in the body or after it`);
    for (const r of refused) {
      assert.equal(ticketProblem(r.text, { genesis: r.network, now: r.now }), r.reason, r.name);
      if (r.reason === "prefix") assert.equal(isTicketText(r.text), false, r.name);
    }
  }
});

test("a ticket's checks without the time: what a ticket given at start must pass whenever it is used", () => {
  const genesis = "5a".repeat(32);
  const endpoints = [{ url: "wss://192.0.2.7:30335/", cert_sha256: "7c".repeat(32) }];
  const issuedAt = 1_800_000_000_000;
  const text = signRelayTicket({ secret: fromHex("71".repeat(32), 32), genesis, endpoints, issuedAt });
  assert.equal(ticketProblem(text, { genesis, now: issuedAt + 31 * 86_400_000 }), "expired");
  assert.equal(ticketProblem(text, { genesis, now: issuedAt - 11 * 60_000 }), "future");
  assert.equal(ticketProblem(text, { genesis, now: null }), null, "neither is checked without a time");
  assert.equal(ticketProblem(text, { genesis: "11".repeat(32), now: null }), "network", "the rest is");
  assert.equal(ticketProblem(text.slice(0, -4), { genesis, now: null }) !== null, true);
  // The words a person reads say what to do.
  assert.match(new TicketRefused("future").message, /check the clock/);
  assert.match(new TicketRefused("expired").message, /a new one/);
});

test("relay_tickets' sealed answer opens with the requester's secret, for its network only", () => {
  const s = v.sealed;
  const secret = fromHex(s.client_secret, 32);
  assert.equal(toHex(x25519.getPublicKey(secret)), s.client_key);
  assert.deepEqual(openTicketsAnswer(s.sealed, secret, s.aad), JSON.parse(s.plaintext));
  assert.equal(openTicketsAnswer(s.sealed, secret, "11".repeat(32)), null, "another network's");
  assert.equal(openTicketsAnswer(s.sealed, fromHex("44".repeat(32), 32), s.aad), null, "another key");
  const changed = s.sealed.slice(0, -2) + (s.sealed.endsWith("AA") ? "BA" : "AA");
  assert.equal(openTicketsAnswer(changed, secret, s.aad), null, "a changed byte");
  assert.equal(openTicketsAnswer("not base64!", secret, s.aad), null);
  // Sealed here as the node seals it: the vector's bytes from the same one-time secret.
  assert.equal(sealTicketsAnswer(JSON.parse(s.plaintext), s.client_key, s.aad, fromHex(s.one_time_secret, 32)), s.sealed);
  const answer = JSON.parse(s.plaintext);
  for (const text of [answer.self, ...answer.tickets]) assert.ok(readTicket(text, { genesis: v.network, now: v.at }));
});

test("a ticket signed here reads back; a changed endpoint, pin or network does not", () => {
  const genesis = "5a".repeat(32);
  const endpoints = [{ url: "wss://192.0.2.7:30335/", cert_sha256: "7c".repeat(32) }];
  const now = 1_800_000_000_000;
  const text = signRelayTicket({ secret: fromHex("71".repeat(32), 32), genesis, endpoints, issuedAt: now });
  assert.deepEqual(readTicket(text, { genesis, now }).endpoints, endpoints);
  const bytes = fromBase32(text.slice(TICKET_PREFIX.length));
  const at = Buffer.from(bytes).indexOf(Buffer.from("192.0.2.7"));
  const moved = Uint8Array.from(bytes);
  moved[at + 8] = "8".charCodeAt(0);
  assert.equal(ticketProblem(TICKET_PREFIX + toBase32(moved), { genesis, now }), "signature", "an endpoint changed");
  const pinAt = bytes.length - 64 - 8 - 32;
  const repinned = Uint8Array.from(bytes);
  repinned[pinAt] ^= 1;
  assert.equal(ticketProblem(TICKET_PREFIX + toBase32(repinned), { genesis, now }), "signature", "a pin changed");
  assert.equal(ticketProblem(text, { genesis: "11".repeat(32), now }), "network");
  assert.equal(ticketProblem(text, { genesis, now: now + 30 * 86_400_000 + 1 }), "expired");
  assert.equal(ticketProblem(text, { genesis, now: now - 10 * 60_000 - 1 }), "future");
  assert.equal(ticketProblem(text.slice(0, -4), { genesis, now }) !== null, true, "cut short");
});

test("base32 is the node's: upper case, no padding, lengths an encoding makes, unused bits zero", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 9, 31, 64]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual(fromBase32(toBase32(bytes)), bytes);
  }
  assert.equal(toBase32(new TextEncoder().encode("foobar")), "MZXW6YTBOI");
  assert.equal(fromBase32("mzxw6ytboi"), null, "lower case is not the form (readTicket upper-cases first)");
  assert.equal(fromBase32("MZXW6YTBOI======"), null, "no padding");
  assert.equal(fromBase32("A"), null, "a length no encoding makes");
  assert.equal(fromBase32("MB"), null, "unused bits set");
  assert.equal(fromBase32("M1"), null, "outside the alphabet");
});
