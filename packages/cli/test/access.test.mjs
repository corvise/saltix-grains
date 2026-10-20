// `grain pair` on a test network whose relays require access grants (Saltix 33-gate), end to end on a development
// gate and a relay that requires access: the code asked for before the offer is shown (a flag, the environment, or a
// person at a terminal), redeemed unattested for this computer, kept owner-only and reused while it lasts, never printed
// or logged; every refusal of the gate and of the relays in plain words; access that ends while it waits; and a paired
// key, which needs no code, never asked for one.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, RelayClient, accountId, decodeAccessToken, decodePairFrame, encodePairFrame, fromBase64Url, fromHex, offerAddress, parseOfferLink,
  toHex,
} from "@saltix/grain-server";
import { createDevGate, createDevRelay } from "@saltix/grain-server/dev";
import { pair } from "../dist/pair.js";
import { keyState } from "../dist/status.js";
import { DevLog, reasonOf } from "../dist/devlog.js";
import { ACCESS_FILE, ACCESS_KEY_FILE, AccessCodeNeeded, accessRefusalWords, duration, keptAccess, lengthMs, obtainAccess } from "../dist/access.js";
import { scratch } from "../../../scripts/scratch.mjs";

const GENESIS = "5a".repeat(32);
const OWNER = toHex(accountId(ed25519.getPublicKey(fromHex("41".repeat(32), 32))));
const CODE = "7K3QX-M9TAB";

/** A node of a network whose relays require the gate's grants: the registry holds `grains`, changed by the test. */
function fakeNode(relay, gate) {
  const grains = new Map();
  return {
    grains,
    async call(method, params = {}) {
      switch (method) {
        case "node_status":
          return { network: "devnet", genesis: GENESIS, slot: 1, beacon: { height: 1, hash: "01".padStart(64, "0") }, access: gate ? { gates: [toHex(gate.key)] } : null };
        case "grain_get":
          return { grain: structuredClone(grains.get(params.slug) ?? null), deposit: "10000000000" };
        case "relay_list":
          return { relays: [{ key: "09".repeat(32), endpoints: [relay.endpoint()] }] };
        default:
          throw new Error(`the fake node does not answer ${method}`);
      }
    },
  };
}

const record = (slug, owner, servers) => ({
  slug, owner, version: 1, id: "00".repeat(32), registered: 1, updated: 1, retired: null, deposit: "10000000000", manifest: null,
  servers, category: 9, public: false, members: [], handles: [],
});

function project() {
  const dir = scratch("grain-access-");
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "access", name: { en: "Access keys" } }));
  return dir;
}

const until = async (what, check, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A gated network: a gate with `codes`, a relay that requires its grants (`exempt` keys aside), a node naming it. */
async function gated(t, codes = { [CODE]: "1d" }, gateOptions = {}) {
  const gate = await createDevGate({ genesis: GENESIS, codes, ...gateOptions });
  t.after(() => gate.close());
  const exempt = new Set();
  const relay = await createDevRelay({ access: { gates: [gate.key], genesis: GENESIS, exempt: (key) => exempt.has(key) } });
  t.after(() => relay.close());
  return { gate, relay, exempt, node: fakeNode(relay, gate) };
}

/** `pair` with its output kept, its access from `ask` (a code, the environment, a prompt). */
function run(dir, net, ask = {}, over = {}) {
  const lines = [];
  const log = new DevLog(dir, "pair", "test");
  const out = (l) => lines.push(l);
  const access = (g) => obtainAccess({ dir, env: { SALTIX_GATE: net.gate.url, ...ask.env }, code: ask.code, prompt: ask.prompt, out, log, again: "grain pair" }, g);
  const done = pair({ dir, node: net.node, flags: "", log, fresh: false, wait: true, timeoutMs: 15_000, tty: false, pollMs: 50, out, access, ...over });
  return { lines, done };
}

const linkIn = (lines) => until("the offer's link", () => lines.join("\n").match(/salt:grain-pair\?o=[A-Za-z0-9_-]+/)?.[0]);

/** The owner's Saltix asks the computer of `link` for `slug` and waits for its answer. */
async function wallet(relay, net, link, slug) {
  const offer = parseOfferLink(link);
  const secret = randomBytes(32);
  // A phone's own connection is let in by its own grant; here, as a key the relay exempts.
  net.exempt.add(toHex(ed25519.getPublicKey(secret)));
  const alias = await RelayClient.connect({ endpoints: [relay.endpoint()], secret, network: "devnet" });
  const answers = [];
  alias.on("frame", (f) => {
    const frame = decodePairFrame(f.payload);
    if ("answer" in frame) answers.push(frame.answer);
  });
  await until("the computer's registration", () => relay.records.has(offerAddress(offer)));
  await alias.send(offerAddress(offer), encodePairFrame({ request: { offer: offer.nonce, slug, owner: OWNER } }), { keep: true });
  const answer = await until("the computer's answer", () => answers[0]);
  alias.close();
  return answer;
}

test("a code given, the grant comes before the offer, is kept owner-only and never shown, and the relay takes it", async (t) => {
  const net = await gated(t);
  const dir = project();
  const { lines, done } = run(dir, net, { code: "7k3qx-m9tab" });
  const link = await linkIn(lines);
  const granted = lines.findIndex((l) => /^Access to the test network granted to this computer until \d{4}-\d\d-\d\dT.*\((24 h|23 h 59 min); the code gives 1d\)\. Kept in \.grain\/access\.json/.test(l));
  assert.ok(granted >= 0, lines.join("\n"));
  assert.ok(granted < lines.findIndex((l) => l.includes(link)), "access first: a code that fails stops before anyone scans");
  // Redeemed unattested, as a computer: the gate saw the canonical code and the reason.
  assert.equal(net.gate.redemptions.length, 1);
  assert.equal(net.gate.redemptions[0].body.unattested, "computer");
  assert.equal(net.gate.redemptions[0].body.code, "7K3QXM9TAB");
  // Kept owner-only, out of git, never printed.
  const keyHex = readFileSync(join(dir, ACCESS_KEY_FILE), "utf8").trim();
  const kept = JSON.parse(readFileSync(join(dir, ACCESS_FILE), "utf8"));
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, ACCESS_KEY_FILE)).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ACCESS_FILE)).mode & 0o777, 0o600);
  }
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.grain\/$/m);
  // The registration carried a token of that grant, for this relay.
  const register = await until("a register with access", () => net.relay.sent.find((f) => f.type === "register" && f.access));
  const token = decodeAccessToken(fromBase64Url(register.access));
  assert.equal(toHex(token.access.own.grant.key), kept.key);

  const answer = await wallet(net.relay, net, link, "access");
  assert.equal(answer.result, "accepted");
  net.node.grains.set("access", record("access", OWNER, [parseOfferLink(link).key]));
  assert.equal(await done, 0);
  assert.ok(lines.includes("The server needs no access code: the relays let a registered server key in."));
  const output = lines.join("\n");
  const logText = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
  for (const secret of [keyHex, kept.grant, CODE, "7K3QXM9TAB", "7k3qx-m9tab"]) {
    assert.ok(!output.includes(secret), "never printed");
    assert.ok(!logText.includes(secret), "never logged");
  }
  const steps = logText.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.step === "gate");
  assert.deepEqual(steps.map((l) => `${l.outcome}:${l.reason}`), ["ok:redeemed"]);

  // Paired: no code is asked for again, whatever the gate would say.
  const again = run(dir, net, { prompt: async () => assert.fail("a paired key needs no code") });
  assert.equal(await again.done, 0);
  assert.match(again.lines.join("\n"), /nothing to do/);
  assert.equal(net.gate.redemptions.length, 1);
  net.exempt.add(AppKey.parse(readFileSync(join(dir, "app.key"), "utf8")).publicKey);
  const state = await keyState(dir, net.node);
  assert.equal(state.status, "paired");
  assert.equal(state.next, null);
});

test("the grant kept is used again while it lasts: a later run asks for no code", async (t) => {
  const net = await gated(t);
  const dir = project();
  // --no-wait gets the access too, so the run that waits needs no code.
  const first = run(dir, net, { env: { SALTIX_ACCESS_CODE: ` ${CODE} ` } }, { wait: false });
  assert.equal(await first.done, 0);
  assert.equal(net.gate.redemptions.length, 1);
  const status = await keyState(dir, net.node);
  assert.equal(status.status, "pairing");
  assert.equal(status.next, "grain pair", "a grant is kept: nothing more to say");
  const second = run(dir, net, { prompt: async () => assert.fail("no code asked: one is kept") }, { timeoutMs: 400 });
  assert.equal(await second.done, 1, "Saltix did not ask in time");
  assert.equal(net.gate.redemptions.length, 1, "the gate was not asked again");
  assert.ok(second.lines.some((l) => /^Access to the test network: this computer's grant, until .*\((23 h 59 min|24 h) left\)\.$/.test(l)), second.lines.join("\n"));
  assert.ok(await until("a register with the kept grant", () => net.relay.sent.filter((f) => f.type === "register" && f.access).length >= 1));
});

test("no code and nobody at a terminal: what to run and where codes come from, and no offer shown", async (t) => {
  const net = await gated(t);
  const dir = project();
  const status = await keyState(dir, net.node);
  assert.equal(status.status, "unpaired");
  assert.match(status.next, /^grain pair --access-code XXXXX-XXXXX \(this test network requires an access code to pair: .*operator.*Saltix Pass.*24 hours/);
  const { lines, done } = run(dir, net);
  const e = await done.catch((x) => x);
  assert.ok(e instanceof AccessCodeNeeded, String(e));
  assert.equal(reasonOf(e), "access_code_needed");
  assert.match(e.message, /lets in only people with an access code/);
  assert.match(e.message, /grain pair --access-code XXXXX-XXXXX \(or set SALTIX_ACCESS_CODE\)/);
  assert.match(e.message, /Saltix Pass/);
  assert.match(e.message, /at most 24 hours/);
  assert.doesNotMatch(lines.join("\n"), /salt:grain-pair/);
  assert.ok(!existsSync(join(dir, ".grain", "pair.html")), "no offer before the access");
  assert.equal(net.gate.redemptions.length, 0);
});

test("a person at a terminal types the code", async (t) => {
  const net = await gated(t);
  const dir = project();
  const asked = [];
  const { lines, done } = run(dir, net, { prompt: async (q) => (asked.push(q), CODE) }, { wait: false });
  assert.equal(await done, 0);
  assert.deepEqual(asked, ["Access code (XXXXX-XXXXX): "]);
  assert.ok(lines.some((l) => /^This test network lets in only people with an access code/.test(l)));
  assert.ok(existsSync(join(dir, ACCESS_FILE)));
});

test("every refusal of the gate in plain words, and a code mistyped refused before the gate is asked", async (t) => {
  let refusal;
  const net = await gated(t, { [CODE]: "1d" }, { refuse: () => refusal });
  const dir = project();
  const attempt = async (code) => run(dir, net, { code }, { wait: false }).done.catch((e) => e);
  for (const [code, words] of [["7K3QX-M9TA", /10 letters and digits/], ["7K3QX-M9TAO", /I, L, O and U/]]) {
    const e = await attempt(code);
    assert.match(e.message, words);
    assert.equal(net.gate.redemptions.length, 0, "a mistyped code costs no attempt at the gate");
    assert.ok(!existsSync(join(dir, ".grain", "pair.html")), "and shows no offer");
  }
  for (const [r, words, logged] of [
    [{ status: 401, error: "rejected" }, /does not take this code: it is unknown, used already, revoked, or older than 7 days/, "gate_rejected"],
    [{ status: 429, error: "rate_limited", retry_after: 42 }, /too many attempts from this address: try again in 42 s/, "gate_rate_limited"],
    [{ status: 403, error: "unattested_off" }, /no access to computers now/, "gate_unattested_off"],
    [{ status: 503, error: "unavailable" }, /try again in a few minutes/, "gate_unavailable"],
  ]) {
    refusal = r;
    const e = await attempt(CODE);
    assert.match(e.message, words, r.error);
    assert.equal(reasonOf(e), logged);
  }
  refusal = undefined;
  const steps = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.step === "gate");
  assert.deepEqual(steps.map((l) => l.reason), ["code_length", "code_letters", "rejected", "rate_limited", "unattested_off", "unavailable"]);
  assert.ok(!existsSync(join(dir, ACCESS_FILE)), "nothing kept from a refusal");
  // The code the gate never spent still opens the network.
  assert.equal(await run(dir, net, { code: CODE }, { wait: false }).done, 0);
  // A gate of another network, or one the relays do not trust.
  const other = await createDevGate({ genesis: "6b".repeat(32), codes: { "AAAAA-BBBBB": "1d" } });
  t.after(() => other.close());
  const e = await obtainAccess({ dir: project(), code: "AAAAA-BBBBB", env: { SALTIX_GATE: other.url }, out: () => {}, log: new DevLog(null, "pair", "test"), again: "grain pair" },
    { network: "devnet", genesis: GENESIS, gates: [net.gate.key] }).catch((x) => x);
  assert.match(e.message, /does not serve the network the relays are on/);
  const plain = await obtainAccess({ dir: project(), code: CODE, env: { SALTIX_GATE: "http://gate.example" }, out: () => {}, log: new DevLog(null, "pair", "test"), again: "grain pair" },
    { network: "devnet", genesis: GENESIS, gates: [net.gate.key] }).catch((x) => x);
  assert.match(plain.message, /SALTIX_GATE=http:\/\/gate\.example: a gate's https:\/\/ address/);
});

test("access that ends while it waits: words, the grant forgotten, the offer kept for the next run", async (t) => {
  const net = await gated(t, { [CODE]: "1d", "AAAAA-BBBBB": "1d" });
  const dir = project();
  const { lines, done } = run(dir, net, { code: CODE });
  const link = await linkIn(lines);
  const offer = parseOfferLink(link);
  await until("the computer's registration", () => net.relay.records.has(offerAddress(offer)));
  net.relay.endAccess(offerAddress(offer));
  assert.equal(await done, 1);
  const said = lines.join("\n");
  assert.match(said, /This computer's access to the test network has ended: get a new access code \(.*Saltix Pass.*\) and run grain pair --access-code XXXXX-XXXXX\. It shows the same offer while it lives\./);
  assert.ok(!existsSync(join(dir, ACCESS_FILE)) && !existsSync(join(dir, ACCESS_KEY_FILE)), "the ended grant is forgotten");
  assert.ok(existsSync(join(dir, ".grain", "pair.key")), "the key waiting to be paired stays");
  const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.step === "relay" && l.outcome === "refused" && l.reason === "access_expired"));
  // The next run asks for a new code and shows the same offer.
  const again = run(dir, net, { code: "AAAAA-BBBBB" }, { wait: false });
  assert.equal(await again.done, 0);
  assert.equal(await linkIn(again.lines), link);
});

test("a grant the relays refuse at connection: words, and forgotten", async (t) => {
  const net = await gated(t);
  const dir = project();
  // Kept here, then the network's gate changes under it: the node still names the old gate, the relays the new one.
  assert.equal(await run(dir, net, { code: CODE }, { wait: false }).done, 0);
  const moved = await createDevRelay({ access: { gates: [new Uint8Array(32).fill(7)], genesis: GENESIS } });
  t.after(() => moved.close());
  const node = fakeNode(moved, net.gate);
  const e = await pair({ dir, node, flags: "", log: new DevLog(dir, "pair", "test"), fresh: false, wait: true, timeoutMs: 15_000, tty: false, pollMs: 50, out: () => {},
    access: (g) => obtainAccess({ dir, env: { SALTIX_GATE: net.gate.url }, out: () => {}, log: new DevLog(dir, "pair", "test"), again: "grain pair" }, g) }).catch((x) => x);
  assert.match(e.message, /The relays do not take this computer's access \(gate: a gate this network no longer trusts\): get a new access code/);
  assert.equal(reasonOf(e), "access_gate");
  assert.ok(!existsSync(join(dir, ACCESS_FILE)), "forgotten: the next run asks for a code");
});

test("a kept grant is judged before it is shown: another network, another gate, near its end", async (t) => {
  const net = await gated(t);
  const dir = project();
  assert.equal(await run(dir, net, { code: CODE }, { wait: false }).done, 0);
  const gates = [net.gate.key];
  const now = Date.now();
  assert.ok("credential" in keptAccess(dir, { network: "devnet", genesis: GENESIS, gates }, now));
  assert.deepEqual(keptAccess(dir, { network: "devnet", genesis: "6b".repeat(32), gates }, now), { why: "other_network" });
  assert.deepEqual(keptAccess(dir, { network: "devnet", genesis: GENESIS, gates: [new Uint8Array(32).fill(3)] }, now), { why: "other_gate" });
  assert.deepEqual(keptAccess(dir, { network: "devnet", genesis: GENESIS, gates }, now + 86_400_000 - 30_000), { why: "ended" });
  assert.deepEqual(keptAccess(project(), { network: "devnet", genesis: GENESIS, gates }, now), { why: "none" });
  // A kept grant that ended is said and replaced by a new code's.
  const lines = [];
  const log = new DevLog(dir, "pair", "test");
  await assert.rejects(obtainAccess({ dir, env: { SALTIX_GATE: net.gate.url }, out: (l) => lines.push(l), log, again: "grain pair", now: () => now + 86_400_000 }, { network: "devnet", genesis: GENESIS, gates }), AccessCodeNeeded);
  assert.deepEqual(lines, ["The access kept here has ended: a new access code is needed."]);
  assert.ok(!existsSync(join(dir, ACCESS_FILE)));
});

test("the words for each refusal of the relays, and the lengths and durations said", () => {
  assert.equal(accessRefusalWords("expired", "grain pair").forget, true);
  assert.match(accessRefusalWords("time", "grain pair").words, /clock/);
  assert.equal(accessRefusalWords("time", "grain pair").forget, false);
  assert.match(accessRefusalWords("proof", "grain faucet").words, /Update the SDK.*grain faucet --access-code/);
  assert.match(accessRefusalWords("required", "grain faucet").words, /--relay or --node/);
  assert.equal(lengthMs("10m"), 600_000);
  assert.equal(lengthMs("6mo"), 6 * 30 * 86_400_000);
  assert.equal(lengthMs("forever"), null);
  assert.equal(duration(86_400_000), "24 h");
  assert.equal(duration(86_340_000), "23 h 59 min");
  assert.equal(duration(40_000), "40 s");
});
