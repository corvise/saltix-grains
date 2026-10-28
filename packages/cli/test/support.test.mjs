// Who answers an app's users, from the command line (Saltix 19-connect §11.1): `grain support` writes the support
// contact into connect.json — a link, an e-mail address, a username (refused when nobody holds it), or from protocol
// version 9 a Saltix address, the owner's own or one whose holder consents, checked against the network — and
// `grain support consent` signs the holder's consent with the key in SALTIX_SUPPORT_KEY. `grain lint` and `grain profile`
// hold a profile of format 2 to the same rules; the steps' log names no contact.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, decodeSignedProfile, encodeAddress, fromHex, signSupportConsent, toHex } from "@saltix/grain-server";
import { CONNECT_FILE, lintConnect } from "../dist/connect.js";
import { SupportError, addressNotTaken, contactOf, holderConsent, ownerAccountOf, readingOf, supportFor, withSupport } from "../dist/support.js";
import { scratch } from "../../../scripts/scratch.mjs";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const vectors = JSON.parse(readFileSync(new URL("../../../vectors/connect-profiles-v1.json", import.meta.url), "utf8"));
const GENESIS = vectors.chain.genesis_hash_hex;
const secret = fromHex("61".repeat(32), 32);
const ownerId = toHex(accountId(ed25519.getPublicKey(secret)));
const ownAddress = encodeAddress("devnet", fromHex(ownerId, 32));
const AGENT = vectors.support_address.agent_secret_hex;
const agentKey = fromHex(AGENT, 32);
const agentAddress = encodeAddress("devnet", accountId(ed25519.getPublicKey(agentKey)));
const strangerKey = fromHex("83".repeat(32), 32);
const consentFor = (o = {}) => signSupportConsent(o.key ?? agentKey, o.genesis ?? GENESIS, o.slug ?? "dice", o.owner ?? ownerId);

/** A node that answers from `state`: its protocol version, the grain's record and a username's. */
async function fakeNode(state) {
  const submitted = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const grain = state.grain === null ? null : { slug: "dice", owner: ownerId, version: 1, retired: null, servers: [], category: 0, public: true, members: [], profile: null, ...state.grain };
      const result = {
        node_status: {
          genesis: GENESIS, slot: 1000, epoch_slots: 100, network: "devnet", beacon: { height: 1, hash: "b1" },
          protocol: { version: state.version ?? 9, next: state.next ?? null },
        },
        account_get: { nonce: 4, salt: "200000000000", controller: null, shard: "" },
        grain_get: { grain: params.slug === "dice" ? grain : null, deposit: "10000000000" },
        handle_get: { handle: state.handles?.[params.name] ?? null },
        transaction_submit: { id: "ab".repeat(32) },
      }[method];
      if (method === "transaction_submit") submitted.push(params.transaction);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}`, submitted, state, close: () => http.close() };
}

const run = (args, cwd, env = {}) => new Promise((resolve) => {
  const child = spawn("node", [main, ...args], { cwd, env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill(), 20_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});

/** A page project of `grain init`, its connect.json in its own words, owner.key the registry's owner. */
function project() {
  const dir = join(scratch("grain-support-"), "dice");
  const made = spawnSync("node", [main, "init", dir, "--slug", "dice", "--name", "Dice roll"], { cwd: tmpdir(), encoding: "utf8", timeout: 20_000 });
  assert.equal(made.status, 0, made.stderr);
  writeFileSync(join(dir, "owner.key"), "61".repeat(32) + "\n", { mode: 0o600 });
  const own = {
    en: { tagline: "Roll dice for board games", about: "Pick how many dice, tap Roll, and see the sum.", highlights: ["Up to 10 dice"], privacy: "Keeps your last roll in your Saltix vault." },
    ru: { tagline: "Кубики для настольных игр", about: "Выберите число кубиков и бросьте.", highlights: ["До 10 кубиков"], privacy: "Хранит последний бросок в хранилище Saltix." },
  };
  writeFileSync(join(dir, CONNECT_FILE), JSON.stringify({ ...connectOf(dir), texts: own }, null, 2));
  return dir;
}
const connectOf = (dir) => JSON.parse(readFileSync(join(dir, CONNECT_FILE), "utf8"));
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
const refused = (reason) => (e) => e instanceof SupportError && e.reason === reason;

test("a contact as typed, written as a profile carries it, or refused naming the four forms", () => {
  assert.deepEqual(contactOf(`  ${agentAddress.toUpperCase()}  `), {
    form: "address", text: agentAddress, network: "devnet", kind: 0, account: toHex(accountId(ed25519.getPublicKey(agentKey))),
  });
  assert.deepEqual(contactOf("@Dice_Help"), { form: "username", text: "@dice_help", name: "dice_help" });
  assert.deepEqual(contactOf("help@dice.app"), { form: "email", text: "mailto:help@dice.app" });
  assert.deepEqual(contactOf("https://dice.app/help"), { form: "link", text: "https://dice.app/help" });
  assert.throws(() => contactOf("https://dice.example/help"), refused("placeholder"));
  assert.throws(() => contactOf("http://dice.app"), refused("form"));
  assert.throws(() => contactOf("javascript:alert(1)"), refused("form"));
  assert.throws(() => contactOf("@dice__help"), refused("username"));
  const contract = vectors.support_address.contacts.find((c) => c.name === "contract").text;
  assert.throws(() => contactOf(contract), refused("address_kind"));
  assert.match(String((() => { try { contactOf("tel:+100"); } catch (e) { return e.message; } })()), /https:\/\/ link, a mailto: address, a Saltix username \(@name\) or a Saltix address/);
});

test("connect.json with a contact: format 2 and its consent for an address, format 1 for the rest, the other fields as they were", () => {
  const value = { version: 1, subject: { grain: { slug: "dice" } }, texts: {}, website: null, support: null, terms: null };
  const consent = consentFor();
  const address = withSupport(value, contactOf(agentAddress), consent);
  assert.deepEqual(Object.keys(address), ["version", "subject", "texts", "website", "support", "terms", "support_consent"]);
  assert.deepEqual([address.version, address.support, address.support_consent], [2, agentAddress, consent]);
  const username = withSupport(address, contactOf("@dice_help"), null);
  assert.deepEqual([username.version, username.support, "support_consent" in username], [1, "@dice_help", false]);
  const none = withSupport(address, null, null);
  assert.deepEqual([none.version, none.support, "support_consent" in none], [1, null, false]);
  assert.deepEqual(withSupport(value, contactOf(ownAddress), null).support_consent, null, "the owner's own needs none");
});

test("a link or an e-mail address asks no network; a username is what the registry says it opens, refused when nobody holds it", async () => {
  const offline = () => {
    throw new Error("no network for a link");
  };
  assert.equal((await supportFor({ contact: contactOf("https://dice.app/help"), slug: "dice", node: offline, env: {} })).consent, null);
  assert.equal((await supportFor({ contact: contactOf("help@dice.app"), slug: "dice", node: offline, env: {} })).consent, null);
  const node = await fakeNode({ handles: { dice_help: { owner: ownerId, app: "dice", display: "@dice_help" }, anna: { owner: "77".repeat(32), app: null }, chess: { owner: ownerId, app: "chess-bot" } } });
  try {
    const say = async (typed) => (await supportFor({ contact: contactOf(typed), slug: "dice", node: () => node.url, env: {} })).said;
    assert.match(await say("@dice_help"), /@dice_help opens dice's chat in Saltix: its program answers there, and every user reaches it/);
    assert.match(await say("@anna"), /a chat with whoever holds it: users write to a person once their messenger is activated/);
    assert.match(await say("@chess"), /the chat of another app, chess-bot/);
    await assert.rejects(say("@nobody_yet"), (e) => refused("username_free")(e) && /whoever mints it would get dice's users' questions/.test(e.message));
  } finally {
    node.close();
  }
});

test("an address: from protocol version 9, of this network, the owner's own or with its holder's consent for this app, owner and network", async () => {
  const node = await fakeNode({});
  const consentText = (c) => JSON.stringify(c);
  const of = (typed, o = {}) => supportFor({ contact: contactOf(typed), slug: "dice", node: () => node.url, env: o.env ?? {}, consent: o.consent });
  try {
    assert.deepEqual(await of(ownAddress), { consent: null, said: `${ownAddress}: the owner's own address; Saltix opens a chat with it, and users reach it before they activate their messenger` });
    const taken = await of(agentAddress, { consent: consentText(consentFor()) });
    assert.deepEqual(taken.consent, consentFor());
    assert.match(taken.said, /an address whose holder consents/);
    // Signed here with the holder's key from the environment: the same consent.
    assert.deepEqual((await of(agentAddress, { env: { SALTIX_SUPPORT_KEY: AGENT } })).consent, consentFor());
    await assert.rejects(of(agentAddress), (e) => refused("consent_missing")(e) && /SALTIX_SUPPORT_KEY=… grain support consent --slug dice/.test(e.message));
    await assert.rejects(of(agentAddress, { consent: consentText(consentFor({ owner: "77".repeat(32) })) }), refused("consent_owner"));
    await assert.rejects(of(agentAddress, { consent: consentText(consentFor({ slug: "dice-two" })) }), refused("consent_slug"));
    await assert.rejects(of(agentAddress, { consent: consentText(consentFor({ key: strangerKey })) }), refused("consent_key"));
    await assert.rejects(of(agentAddress, { consent: consentText(consentFor({ genesis: "5b".repeat(32) })) }), refused("consent_signature"));
    await assert.rejects(of(agentAddress, { consent: "{not json" }), refused("consent_json"));
    await assert.rejects(of(agentAddress, { env: { SALTIX_SUPPORT_KEY: "84" } }), (e) => e.name === "SupportKeyError");
    await assert.rejects(of(encodeAddress("testnet", accountId(ed25519.getPublicKey(agentKey)))), (e) => refused("network")(e) && /an address of testnet, and this network is devnet/.test(e.message));
    node.state.version = 8;
    node.state.next = { version: 9, epoch: 132 };
    await assert.rejects(of(ownAddress), (e) => refused("version")(e) && /runs protocol version 8.*version 9 begins at slot 13200/.test(e.message));
    node.state.next = null;
    await assert.rejects(of(ownAddress), (e) => refused("version")(e) && /no schedule names it yet/.test(e.message));
    node.state.version = 9;
    node.state.grain = null;
    await assert.rejects(of(ownAddress), refused("unregistered"));
    node.state.grain = { retired: 5 };
    await assert.rejects(of(ownAddress), refused("retired"));
  } finally {
    node.close();
  }
});

test("the network's reading, and when it takes a support address", () => {
  const status = { network: "devnet", genesis: GENESIS, slot: 10, epoch_slots: 100, protocol: { version: 8, next: { version: 9, epoch: 132 } } };
  assert.deepEqual(readingOf(status), { version: 8, network: "devnet", genesis: GENESIS });
  assert.match(addressNotTaken(status), /version 9 begins at slot 13200/);
  assert.equal(addressNotTaken({ ...status, protocol: { version: 9 } }), null);
  // A node left behind counts by the version its headers say the network runs.
  assert.equal(addressNotTaken({ ...status, protocol: { version: 8, outdated: { version: 9 } } }), null);
  assert.equal(ownerAccountOf(ownAddress), ownerId);
  assert.equal(ownerAccountOf(ownerId), ownerId);
  assert.throws(() => ownerAccountOf("dice"), refused("owner"));
});

test("the holder's consent from SALTIX_SUPPORT_KEY: the registry's owner unless named, the key's address said", async () => {
  const node = await fakeNode({});
  try {
    const signed = await holderConsent({ slug: "dice", node: node.url, env: { SALTIX_SUPPORT_KEY: AGENT } });
    assert.deepEqual(signed.consent, consentFor());
    assert.equal(signed.address, agentAddress);
    const named = await holderConsent({ slug: "chess-bot", owner: "77".repeat(32), node: node.url, env: { SALTIX_SUPPORT_KEY: AGENT } });
    assert.deepEqual(named.consent, consentFor({ slug: "chess-bot", owner: "77".repeat(32) }));
    await assert.rejects(holderConsent({ slug: "chess-bot", node: node.url, env: { SALTIX_SUPPORT_KEY: AGENT } }), refused("unregistered"));
    await assert.rejects(holderConsent({ slug: "dice", node: node.url, env: {} }), /no SALTIX_SUPPORT_KEY/);
  } finally {
    node.close();
  }
});

test("grain support end to end: connect.json written, said back, cleared; the holder's file taken; the log names no contact", async () => {
  const dir = project();
  const node = await fakeNode({ handles: { dice_help: { owner: ownerId, app: "dice", display: "@dice_help" } } });
  try {
    const bound = await run(["support", "@Dice_Help", "--node", node.url], dir);
    assert.equal(bound.code, 0, bound.stderr);
    assert.match(bound.stdout, /@dice_help opens dice's chat in Saltix/);
    assert.match(bound.stdout, /support @dice_help \(version 1\); next: grain profile sets it in the registry/);
    assert.deepEqual([connectOf(dir).version, connectOf(dir).support], [1, "@dice_help"]);
    assert.match((await run(["support"], dir)).stdout, /support @dice_help \(username\)/);
    // The holder signs on its side; the owner takes the file.
    const holder = scratch("grain-holder-");
    const signed = await run(["support", "consent", "--slug", "dice", "--node", node.url], holder, { SALTIX_SUPPORT_KEY: AGENT });
    assert.equal(signed.code, 0, signed.stderr);
    assert.match(signed.stdout, new RegExp(`the consent of ${agentAddress} to answer for dice`));
    assert.ok(!(signed.stdout + signed.stderr).includes(AGENT), "the key is never printed");
    const file = join(holder, "support-consent.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), consentFor());
    const address = await run(["support", agentAddress, "--consent", file, "--node", node.url], dir);
    assert.equal(address.code, 0, address.stderr);
    assert.deepEqual([connectOf(dir).version, connectOf(dir).support, connectOf(dir).support_consent], [2, agentAddress, consentFor()]);
    assert.deepEqual(lintConnect(dir, manifestOf(dir)).errors, [], "grain lint takes what grain support wrote");
    // Refused for a consent that does not hold: connect.json stays as it was, and the log says why in a code.
    const before = readFileSync(join(dir, CONNECT_FILE), "utf8");
    writeFileSync(file, JSON.stringify(consentFor({ owner: "77".repeat(32) })));
    const wrong = await run(["support", agentAddress, "--consent", file, "--node", node.url], dir);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /the consent names another owner than dice's/);
    assert.equal(readFileSync(join(dir, CONNECT_FILE), "utf8"), before);
    assert.equal((await run(["support", "@dice_help", "--consent", file], dir)).code, 2, "--consent goes with an address alone");
    const mixed = await run(["support", "@dice_help", "--owner", ownerId], dir);
    assert.equal(mixed.code, 2, "the holder's flags are not the owner's command's");
    assert.match(mixed.stderr, /--owner: grain support consent's, not this command's/);
    assert.equal((await run(["support", "consent", "--clear"], dir)).code, 2);
    const cleared = await run(["support", "--clear"], dir);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.deepEqual([connectOf(dir).version, connectOf(dir).support, "support_consent" in connectOf(dir)], [1, null, false]);
    const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
    assert.match(log, /"reason":"support_consent_owner"/);
    for (const never of [agentAddress, "dice_help", ownerId, AGENT]) assert.ok(!log.includes(never), `the log never holds ${never.slice(0, 12)}…`);
  } finally {
    node.close();
  }
});

test("grain lint: an address needs version 2, a consent its key's and the app's; version 2 with no address is a warning", () => {
  const dir = project();
  const set = (fields) => {
    writeFileSync(join(dir, CONNECT_FILE), JSON.stringify({ ...connectOf(dir), ...fields }));
    return lintConnect(dir, manifestOf(dir));
  };
  assert.deepEqual(set({ version: 2, support: agentAddress, support_consent: consentFor() }).errors, []);
  assert.deepEqual(set({ version: 2, support: ownAddress, support_consent: null }).errors, [], "the owner's own needs none");
  assert.match(set({ version: 1, support: agentAddress, support_consent: undefined }).errors.join("\n"), /a Saltix address needs version 2/);
  assert.match(set({ version: 2, support: agentAddress.toUpperCase(), support_consent: consentFor() }).errors.join("\n"), /canonical form \(lowercase/);
  assert.match(set({ version: 2, support: agentAddress, support_consent: consentFor({ key: strangerKey }) }).errors.join("\n"), /consent_key: the support address's consent does not hold/);
  assert.match(set({ version: 2, support: agentAddress, support_consent: consentFor({ slug: "dice-two" }) }).errors.join("\n"), /consent_slug/);
  assert.match(set({ version: 2, support: "@dice_help", support_consent: consentFor() }).errors.join("\n"), /consent_unneeded/);
  assert.match(set({ version: 3, support: "@dice_help", support_consent: undefined }).errors.join("\n"), /version: 1, the format's version; 2 when support is a Saltix address/);
  const v2 = set({ version: 2, support: "@dice_help", support_consent: null });
  assert.deepEqual(v2.errors, []);
  assert.match(v2.warnings.join("\n"), /version 2 with no support address/);
});

test("grain profile holds a support address to the network: refused before version 9 and for a consent of another network, sent from 9", async () => {
  const dir = project();
  writeFileSync(join(dir, CONNECT_FILE), JSON.stringify({ ...connectOf(dir), version: 2, support: agentAddress, support_consent: consentFor() }));
  const node = await fakeNode({ version: 8, next: { version: 9, epoch: 132 } });
  try {
    const early = await run(["profile", "--no-wait", "--node", node.url], dir);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /version 2 \(a support address\): the network runs protocol version 8, and a support address is taken from version 9 \(version 9 begins at slot 13200\)/);
    assert.equal(node.submitted.length, 0);
    node.state.version = 9;
    writeFileSync(join(dir, CONNECT_FILE), JSON.stringify({ ...connectOf(dir), support_consent: consentFor({ genesis: "5b".repeat(32) }) }));
    const other = await run(["profile", "--no-wait", "--node", node.url], dir);
    assert.equal(other.code, 1);
    assert.match(other.stderr, /signed for another network/);
    assert.equal(node.submitted.length, 0);
    writeFileSync(join(dir, CONNECT_FILE), JSON.stringify({ ...connectOf(dir), support_consent: consentFor() }));
    const sent = await run(["profile", "--no-wait", "--node", node.url], dir);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(node.submitted.length, 1);
    // The SetGrainProfile's profile: after the sender, nonce, fee and slot, the action's and the call's tags, the slug.
    const b = fromHex(node.submitted[0]);
    assert.equal(b[58], 38, "SetGrainProfile");
    const at = 63 + new DataView(b.buffer, 59, 4).getUint32(0, true);
    const profile = decodeSignedProfile(b.slice(at + 1, b.length - 8 - 65)).profile;
    assert.deepEqual([profile.version, profile.support, profile.support_consent], [2, agentAddress, consentFor()]);
  } finally {
    node.close();
  }
});
