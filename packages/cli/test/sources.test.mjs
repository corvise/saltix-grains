// A sealed manifest's sources (Saltix 12-grains §2, 32-images §10): none on a network that runs protocol version 2; before
// it, copies the network itself serves, at up to 3 relays of its own relay list (those offering room first, ranked by
// the bundle's placement, one per network first), never a host the developer must run; the developer's own hosts kept.
import test from "node:test";
import assert from "node:assert/strict";
import { manifestProblem, derive, fromHex, toHex } from "@saltix/grain-server";
import { RELAY_SOURCES, isRelaySource, protocolOf, relayBlobUrl, relaySources, sourcesFor } from "../dist/sources.js";

const HASH = "78c43e9e707e58579fefaaa88c3c3c6ac5295576a0a23f55c39a51386342a0e3";
const relay = (n, over = {}) => ({
  key: toHex(derive("test relay", Uint8Array.of(n))), store_gib: null,
  endpoints: [{ url: `wss://10.${n}.0.1:30335/`, cert_sha256: "ab".repeat(32) }], ...over,
});
const placement = (key) => toHex(derive("Saltix bundle placement v1", fromHex(HASH, 32), fromHex(key, 32)));

test("a relay's endpoint as a source: https at its host and port, the bundle's path; endpoints a manifest cannot name are passed over", () => {
  assert.equal(relayBlobUrl("wss://203.0.113.1:30335/", HASH), `https://203.0.113.1:30335/_blob/grain_bundle/${HASH}`);
  assert.equal(relayBlobUrl("wss://relay.example/", HASH), `https://relay.example/_blob/grain_bundle/${HASH}`);
  assert.equal(relayBlobUrl("ws://127.0.0.1:30335/", HASH), null, "plain ws: a developer's loopback relay");
  assert.equal(relayBlobUrl("wss://[2001:db8::1]:30335/", HASH), null, "an IPv6 literal is no manifest's origin");
  assert.equal(relayBlobUrl("not a url", HASH), null);
  assert.ok(isRelaySource(`https://a.example/_blob/grain_bundle/${HASH}`));
  assert.ok(!isRelaySource("https://cdn.example/app.zip"));
});

test("up to 3 relays: room for the bundle first, then by its placement; one per /16 network first; the same list gives the same sources", () => {
  const relays = Array.from({ length: 8 }, (_, i) => relay(i + 1));
  const picked = relaySources(relays, HASH, 1000);
  assert.equal(picked.length, RELAY_SOURCES);
  const ranked = [...relays].sort((a, b) => (placement(a.key) < placement(b.key) ? 1 : -1));
  assert.deepEqual(picked, ranked.slice(0, 3).map((r) => relayBlobUrl(r.endpoints[0].url, HASH)));
  assert.deepEqual(relaySources([...relays].reverse(), HASH, 1000), picked, "the order of the list does not matter");
  for (const s of picked) assert.ok(manifestProblem({ ...base, entry: { sealed: { ...base.entry.sealed, sources: [s] } } }, false, 1) === null, s);
  // A relay offering room for it comes first, whatever its rank; one offering too little does not.
  const roomy = relay(9, { store_gib: 1 });
  const small = relay(10, { store_gib: 0 });
  assert.equal(relaySources([...relays, small, roomy], HASH, 1000)[0], relayBlobUrl(roomy.endpoints[0].url, HASH));
  // Two relays on one /16: the second only when nothing else is left.
  const twins = [relay(1), relay(1, { key: toHex(derive("twin", Uint8Array.of(1))), endpoints: [{ url: "wss://10.1.9.9:30335/", cert_sha256: null }] }), relay(2)];
  const spread = relaySources(twins, HASH, 1000);
  assert.equal(spread.length, 3);
  assert.notEqual(new URL(spread[0]).hostname.split(".").slice(0, 2).join("."), new URL(spread[1]).hostname.split(".").slice(0, 2).join("."));
  // Relays with no endpoint a manifest can name give nothing.
  assert.deepEqual(relaySources([relay(1, { endpoints: [{ url: "ws://127.0.0.1:1/", cert_sha256: null }] })], HASH, 1000), []);
});

const base = {
  slug: "space-game", version: 2, owner: "11".repeat(32), owner_key: { ed25519: "22".repeat(32) }, name: { en: "Space" }, description: {},
  icon: "00".repeat(32), entry: { sealed: { bundle: HASH, size: 483, sources: [], start: "index.html", connect: [] } }, permissions: 0, sponsor: null, min_host: 1,
};

test("sources by the network's protocol: relays' copies on version 1, none from version 2, the developer's own kept", async () => {
  const node = { call: async (m) => (m === "relay_list" ? { relays: [relay(1), relay(2), relay(3), relay(4)] } : null) };
  const v1 = await sourcesFor(node, 1, HASH, 483, []);
  assert.equal(v1.from, "relays");
  assert.equal(v1.sources.length, 3);
  assert.ok(v1.sources.every(isRelaySource));
  const v2 = await sourcesFor(node, 2, HASH, 483, v1.sources);
  assert.deepEqual(v2, { sources: [], from: "network" }, "relays' copies from an earlier publish are dropped");
  const own = await sourcesFor(node, 1, HASH, 483, ["https://cdn.example/app.zip", ...v1.sources]);
  assert.deepEqual(own, { sources: ["https://cdn.example/app.zip"], from: "own" });
  assert.deepEqual(await sourcesFor(node, 2, HASH, 483, ["https://cdn.example/app.zip"]), { sources: ["https://cdn.example/app.zip"], from: "own" });
  // A node from before protocol versions says nothing of them: version 1.
  assert.equal(protocolOf({}), 1);
  assert.equal(protocolOf({ protocol: { version: 2 } }), 2);
  assert.equal(protocolOf({ protocol: { version: "2" } }), 1);
});
