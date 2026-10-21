// `grain pair` pairs only the app the developer named or confirmed (Saltix 24-app-studio §3a: whoever saw an offer may
// ask the computer for an app of their own, and their registry call must not make this server theirs). An offer that
// names no app answers whoever asks, says who asked, and writes app.key only after `grain pair --accept S`; `grain
// status` says the same; an earlier offer's answer counts for nothing once a new offer is made.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, PAIR_OFFER_LIFE_MS, RelayClient, accountId, checkPairAnswer, decodePairFrame, encodeAddress, encodePairFrame, fromHex, offerAddress,
  parseOfferLink, toHex,
} from "@saltix/grain-server";
import { createDevRelay } from "@saltix/grain-server/dev";
import { pair, readPairState } from "../dist/pair.js";
import { keyState } from "../dist/status.js";
import { DevLog } from "../dist/devlog.js";
import { scratch } from "../../../scripts/scratch.mjs";

const GENESIS = "5a".repeat(32);
const STRANGER = toHex(accountId(ed25519.getPublicKey(fromHex("43".repeat(32), 32))));
const OWNER = toHex(accountId(ed25519.getPublicKey(fromHex("41".repeat(32), 32))));

function fakeNode(relay) {
  const grains = new Map();
  return {
    grains,
    async call(method, params = {}) {
      switch (method) {
        case "node_status":
          return { network: "devnet", genesis: GENESIS, slot: 1, beacon: { height: 1, hash: "01".padStart(64, "0") } };
        case "grain_get":
          return { grain: structuredClone(grains.get(params.slug) ?? null), deposit: "10000000000" };
        case "relay_list":
          return { relays: [{ endpoints: [relay.endpoint()] }] };
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

const until = async (what, check, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** Whoever holds the offer's link asks the computer for `slug` of `owner`'s. */
async function ask(relay, link, slug, owner) {
  const offer = parseOfferLink(link);
  const alias = await RelayClient.connect({ endpoints: [relay.endpoint()], secret: randomBytes(32), network: "devnet" });
  const answers = [];
  alias.on("frame", (f) => {
    const frame = decodePairFrame(f.payload);
    if ("answer" in frame && f.from === offerAddress(offer)) answers.push(frame.answer);
  });
  const request = { offer: offer.nonce, slug, owner };
  await until("the computer's registration", () => relay.records.has(offerAddress(offer)));
  await alias.send(offerAddress(offer), encodePairFrame({ request }), { keep: true });
  const answer = await until("the computer's answer", () => answers[0]);
  alias.close();
  return { offer, answer, proof: checkPairAnswer(answer, GENESIS, offer, request) };
}

function run(dir, node, over = {}) {
  const lines = [];
  const done = pair({
    dir, node, flags: "", log: new DevLog(dir, "pair", "test"), fresh: false, wait: true, timeoutMs: 15_000, tty: false, pollMs: 50,
    out: (l) => lines.push(l), ...over,
  });
  return { lines, done };
}

const linkIn = (lines) => until("the offer's link", () => lines.join("\n").match(/salt:grain-pair\?o=[A-Za-z0-9_-]+/)?.[0]);

test("an offer that names no app: a stranger's app is answered, but never paired without the developer's --accept", async (t) => {
  const relay = await createDevRelay();
  t.after(() => relay.close());
  const node = fakeNode(relay);
  const dir = scratch("grain-pair-accept-");
  const first = run(dir, node);
  const link = await linkIn(first.lines);
  const offer = parseOfferLink(link);
  assert.equal(offer.slug, null);

  // The stranger asks and gets the proof for their own app (the spec allows it: it costs the developer a new offer).
  const asked = await ask(relay, link, "evil", STRANGER);
  assert.equal(asked.answer.result, "accepted");
  assert.ok(asked.proof);
  // The stranger names the key for their app: the registry says so, and this computer still pairs nothing.
  node.grains.set("evil", record("evil", STRANGER, [offer.key]));
  assert.equal(await first.done, 1);
  const said = first.lines.join("\n");
  assert.match(said, new RegExp(`Saltix asked to pair this server with evil \\(a new app\\), owner ${encodeAddress("devnet", fromHex(STRANGER, 32))}: answered\\.\\n`));
  assert.match(said, /not set up for, so nothing is written.*grain pair --accept evil.*grain pair --new/s);
  assert.ok(!existsSync(join(dir, "app.key")) && !existsSync(join(dir, "app.json")), "nothing written for an app the developer did not name");

  // grain status says the same, and names the next step.
  const state = await keyState(dir, node);
  assert.equal(state.status, "pairing");
  assert.match(state.detail, /asked to pair it with evil.*not confirmed/);
  assert.equal(state.next, "grain pair --accept evil");

  // Run again without --accept: the same offer, still nothing (the registry already names the key for evil).
  const again = run(dir, node);
  assert.equal(await again.done, 1);
  assert.ok(!existsSync(join(dir, "app.key")));
  assert.match(again.lines.join("\n"), /grain pair --accept evil/);

  // --accept for another slug than the one asked for finishes nothing either.
  const other = run(dir, node, { accept: "dice", timeoutMs: 400 });
  assert.equal(await other.done, 1);
  assert.ok(!existsSync(join(dir, "app.key")));
  assert.equal(readPairState(dir).accepted, "dice", "what was accepted is kept with the offer");

  // The developer confirms the app Saltix asked for: paired, as the words said.
  const accepted = run(dir, node, { accept: "evil" });
  assert.equal(await accepted.done, 0);
  assert.equal(AppKey.parse(readFileSync(join(dir, "app.key"), "utf8")).slug, "evil");
  assert.match(accepted.lines.join("\n"), /Paired: this server speaks for evil/);
});

test("an earlier offer's answer counts for nothing once a new offer is made, and --accept against the offer's own slug is refused", async (t) => {
  const relay = await createDevRelay();
  t.after(() => relay.close());
  const node = fakeNode(relay);
  const dir = scratch("grain-pair-accept-");
  // A clock that runs, and jumps ahead when told.
  let skew = 0;
  const now = () => Date.now() + skew;
  const first = run(dir, node, { now, timeoutMs: 15_000 });
  const link = await linkIn(first.lines);
  const offer = parseOfferLink(link);
  assert.equal((await ask(relay, link, "evil", STRANGER)).answer.result, "accepted");
  assert.equal(await first.done, 1);

  // The offer expires; the next run makes a new one, which forgets the old answer. The stranger's call lands now: with
  // --accept evil the developer would take it, but the answer was the old offer's, so nothing is written until Saltix asks
  // this offer.
  skew += PAIR_OFFER_LIFE_MS + 1;
  node.grains.set("evil", record("evil", STRANGER, [offer.key]));
  const second = run(dir, node, { now, accept: "evil", timeoutMs: 400 });
  const link2 = await linkIn(second.lines);
  assert.notEqual(parseOfferLink(link2).nonce, offer.nonce, "a new offer");
  assert.equal(await second.done, 1);
  assert.ok(!existsSync(join(dir, "app.key")), "the old offer's answer is forgotten");
  assert.deepEqual(readPairState(dir).answered, []);
  assert.match(second.lines.join("\n"), /did not ask in time/);

  // A project set up for an app: --accept names another one, refused before anything is shown.
  const named = scratch("grain-pair-accept-");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(named, "grain.json"), JSON.stringify({ slug: "access", name: { en: "Access" } }));
  await assert.rejects(run(named, node, { accept: "dice" }).done, /--accept dice: this project is set up for access/);
  await assert.rejects(run(named, node, { accept: "not a slug!" }).done, /--accept not a slug!: a slug is/);
  // --accept with the offer's own slug is the same as naming it.
  const same = run(named, node, { accept: "access" });
  const link3 = await linkIn(same.lines);
  assert.equal((await ask(relay, link3, "access", OWNER)).answer.result, "accepted");
  node.grains.set("access", record("access", OWNER, [parseOfferLink(link3).key]));
  assert.equal(await same.done, 0);
  assert.equal(AppKey.parse(readFileSync(join(named, "app.key"), "utf8")).slug, "access");
});
