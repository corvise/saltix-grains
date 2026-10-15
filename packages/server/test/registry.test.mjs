// The registry transactions of vectors/grains-v1.json and vectors/handles-v1.json, byte for byte (Saltix 12-grains §3,
// 21-names, 24-app-studio): register, update, retire, a chat-only grain's registration, configure, access, rate and a
// username bound to a grain; the deposits by the slug's length; what the shard refuses before a call leaves it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  encodeGrainTx, grainTxId, signGrainTx, minimumFee, fromHex, toHex, sameManifest, grainDeposit, grainCallProblem, callAmount,
  parseRoles, roleNames, categoryOf, accountId, parseHandle, displayHandle, encodeHandle, handleProblem, GRAIN_DEPOSIT, ROLES,
} from "../dist/index.js";
import { ed25519 } from "@noble/curves/ed25519";

const v = JSON.parse(readFileSync(new URL("../../../vectors/grains-v1.json", import.meta.url), "utf8"));
const handles = JSON.parse(readFileSync(new URL("../../../vectors/handles-v1.json", import.meta.url), "utf8"));
const access = JSON.parse(readFileSync(new URL("../../../vectors/access-v1.json", import.meta.url), "utf8"));
const secret = fromHex(v.owner_secret, 32);
/** The rater of the vectors: `RATER` of crates/saltix-types/src/grain/vectors.rs (its public key is checked below). */
const RATER = fromHex("65".repeat(32), 32);
const callOf = (c) => {
  switch (c.call) {
    case "register_grain": return { register: c.manifest };
    case "update_grain": return { update: c.manifest };
    case "retire_grain": return { retire: c.slug };
    case "configure_grain": return { configure: { slug: c.slug, servers: c.servers, category: c.category } };
    case "set_grain_access": return { access: { slug: c.slug, public: c.public, members: c.members } };
    case "rate_grain": return { rate: { slug: c.slug, score: c.score, review: c.review } };
    default: throw new Error(`a call of the vectors: ${c.call}`);
  }
};
const sender = (hex) => hex.slice(2, 66);

test("registry transactions are the node's", () => {
  const r = v.registry;
  assert.deepEqual(r.transactions.map((t) => t.name), ["register", "update", "retire", "register-chat", "configure", "access", "rate"]);
  assert.equal(toHex(ed25519.getPublicKey(RATER)), sender(r.transactions.find((t) => t.name === "rate").transaction_hex));
  for (const t of r.transactions) {
    const key = t.name === "rate" ? RATER : secret;
    const fields = { nonce: BigInt(t.nonce), fee: BigInt(t.fee), validUntilSlot: BigInt(t.valid_until_slot) };
    const call = callOf(t.call);
    assert.equal(callAmount(call), BigInt(t.amount), t.name);
    const body = encodeGrainTx({ ...fields, sender: toHex(ed25519.getPublicKey(key)) }, call);
    assert.equal(toHex(body), t.transaction_hex, t.name);
    assert.equal(grainTxId(body, r.genesis_hash), t.id_hex, t.name);
    const signed = signGrainTx(key, fields, call, r.genesis_hash);
    assert.equal(signed.hex, t.signed_hex, t.name);
    assert.equal(signed.id, t.id_hex);
    assert.ok(minimumFee(call) >= BigInt(t.signed_hex.length / 2) * 10n);
  }
  assert.equal(r.deposit, "100000000000");
});

test("the deposit follows the slug's length, and a registration sends the node's quote", () => {
  for (const d of v.registry.deposits) assert.equal(grainDeposit(d.slug), BigInt(d.deposit), d.slug);
  const chat = v.registry.transactions.find((t) => t.name === "register-chat");
  assert.equal(callAmount({ register: chat.call.manifest }), 10_000_000_000n, "chess-bot: 10 SALT");
  // A node that predates deposits by length takes 100 SALT for any slug: the CLI sends what the node quotes.
  const quoted = { register: chat.call.manifest, deposit: GRAIN_DEPOSIT };
  assert.equal(callAmount(quoted), GRAIN_DEPOSIT);
  const body = encodeGrainTx({ sender: toHex(ed25519.getPublicKey(secret)), nonce: 0, fee: 0, validUntilSlot: 0 }, quoted);
  assert.equal(toHex(body.subarray(body.length - 8)), "00e8764817000000", "the amount is the call's last field");
});

test("a username bound to a grain is the node's", () => {
  // The signer of every handle transaction: the payer key of access-v1.json (`SIGNER` of crates/saltix-types/src/vectors.rs).
  const signer = fromHex(access.keys.payer_private_hex, 32);
  assert.equal(toHex(accountId(ed25519.getPublicKey(signer))), handles.commit.sender_hex);
  for (const name of ["bind-handle", "unbind-handle"]) {
    const t = handles.transactions.find((x) => x.name === name);
    const call = { bind: { handle: { number: "7771234" }, slug: name === "bind-handle" ? "chess" : null } };
    const fields = { nonce: BigInt(t.nonce), fee: 3_000n, validUntilSlot: 200_000n };
    const body = encodeGrainTx({ ...fields, sender: toHex(ed25519.getPublicKey(signer)) }, call);
    assert.equal(toHex(body), t.transaction_hex, name);
    assert.equal(grainTxId(body, handles.chain.genesis_hash_hex), t.id_hex, name);
    assert.equal(signGrainTx(signer, fields, call, handles.chain.genesis_hash_hex).hex, t.signed_hex, name);
  }
});

test("handles read, print and encode as the node's", () => {
  for (const f of handles.forms) {
    const h = f.kind === "name" ? { name: f.text } : { number: f.text };
    assert.equal(handleProblem(h) === null, f.valid, `${f.kind} ${f.text}`);
    if (!f.valid) continue;
    assert.equal(displayHandle(h), f.display);
    assert.equal(toHex(encodeHandle(h)), f.borsh_hex);
  }
  for (const t of handles.typed) {
    const h = parseHandle(t.typed);
    if (t.kind === null) {
      assert.equal(h, null, t.typed);
      continue;
    }
    assert.deepEqual(h, t.kind === "name" ? { name: t.text } : { number: t.text }, t.typed);
    assert.equal(displayHandle(h), t.display);
  }
});

test("what the shard refuses is refused before a call is signed", () => {
  const owner = toHex(accountId(ed25519.getPublicKey(secret)));
  const key = v.app_key.server_public;
  const refused = (call) => grainCallProblem(call, owner);
  assert.equal(refused({ configure: { slug: "chess", servers: [key], category: 4 } }), null);
  assert.equal(refused({ configure: { slug: "chess", servers: [], category: 0 } }), null, "no keys: every key revoked");
  assert.match(refused({ configure: { slug: "chess", servers: [key, key], category: 4 } }), /servers/, "a key twice");
  const five = Array.from({ length: 5 }, (_, i) => toHex(ed25519.getPublicKey(fromHex((0x70 + i).toString(16).repeat(32), 32))));
  assert.match(refused({ configure: { slug: "chess", servers: five, category: 4 } }), /servers/, "five keys");
  assert.equal(refused({ configure: { slug: "chess", servers: five.slice(0, 4), category: 4 } }), null, "four keys");
  assert.match(refused({ configure: { slug: "chess", servers: ["00".repeat(32)], category: 4 } }), /servers/, "a point of small order");
  assert.match(refused({ configure: { slug: "chess", servers: [key.toUpperCase()], category: 4 } }), /servers/);
  assert.match(refused({ configure: { slug: "chess", servers: [key], category: 10 } }), /category/);
  assert.match(refused({ configure: { slug: "Chess", servers: [key], category: 1 } }), /slug/);
  const m = (account, roles) => ({ account, roles });
  assert.equal(refused({ access: { slug: "chess", public: false, members: [m("45".repeat(32), 3)] } }), null);
  assert.match(refused({ access: { slug: "chess", public: false, members: [m("45".repeat(32), 0)] } }), /members/, "no role");
  assert.match(refused({ access: { slug: "chess", public: false, members: [m("45".repeat(32), 8)] } }), /members/, "an unknown role");
  assert.match(refused({ access: { slug: "chess", public: false, members: [m(owner, 1)] } }), /members/, "the owner is no member");
  assert.match(refused({ access: { slug: "chess", public: false, members: [m("45".repeat(32), 1), m("45".repeat(32), 2)] } }), /members/, "twice");
  const many = Array.from({ length: 65 }, (_, i) => m(i.toString(16).padStart(64, "0"), 1));
  assert.match(refused({ access: { slug: "chess", public: true, members: many } }), /members/, "65 members");
  assert.equal(refused({ access: { slug: "chess", public: true, members: many.slice(0, 64) } }), null, "64 members");
  assert.equal(refused({ rate: { slug: "chess", score: 5, review: "x".repeat(140) } }), null);
  assert.equal(refused({ rate: { slug: "chess", score: 0, review: "" } }), null, "0 withdraws");
  assert.match(refused({ rate: { slug: "chess", score: 6, review: "" } }), /score/);
  assert.match(refused({ rate: { slug: "chess", score: 5, review: "x".repeat(141) } }), /review/);
  assert.match(refused({ rate: { slug: "chess", score: 5, review: "good\nbad" } }), /review/, "one line");
  assert.equal(refused({ rate: { slug: "chess", score: 5, review: "\u{1F600}".repeat(140) } }), null, "characters, not bytes");
  assert.match(refused({ bind: { handle: { name: "Anna" }, slug: "chess" } }), /handle/);
  assert.equal(refused({ bind: { handle: { name: "anna" }, slug: null } }), null);
  assert.throws(() => signGrainTx(secret, { nonce: 0, fee: 0, validUntilSlot: 1 }, { configure: { slug: "chess", servers: [key], category: 11 } }, v.registry.genesis_hash), /category/);
});

test("roles and categories read as the node's command line reads them", () => {
  assert.equal(parseRoles("user+developer"), ROLES.user | ROLES.developer);
  assert.equal(parseRoles("viewer"), 4);
  assert.equal(parseRoles("3"), 3);
  assert.equal(parseRoles("user,viewer"), 5);
  assert.equal(parseRoles("0"), null);
  assert.equal(parseRoles("8"), null);
  assert.equal(parseRoles("owner"), null);
  assert.equal(parseRoles("user+"), null);
  assert.deepEqual(roleNames(7), ["user", "developer", "viewer"]);
  assert.equal(categoryOf("games"), 4);
  assert.equal(categoryOf("9"), 9);
  assert.equal(categoryOf(10), null);
  assert.equal(categoryOf("toys"), null);
});

test("only the owner's manifest and a valid slug are signed", () => {
  const register = v.registry.transactions.find((t) => t.name === "register");
  const other = fromHex("62".repeat(32), 32);
  assert.throws(() => signGrainTx(other, { nonce: 0, fee: 0, validUntilSlot: 1 }, { register: register.call.manifest }, v.registry.genesis_hash), /owner_key/);
  assert.throws(() => signGrainTx(secret, { nonce: 0, fee: 0, validUntilSlot: 1 }, { retire: "Go" }, v.registry.genesis_hash), /slug/);
});

test("a wallet's manifest is the same but for its owner", () => {
  const m = v.manifests.find((c) => c.name === "hosted").json.manifest;
  assert.ok(sameManifest(m, { ...m, owner: "22".repeat(32), owner_key: { p256: "02" + "33".repeat(32) } }));
  assert.ok(!sameManifest(m, { ...m, version: m.version + 1 }));
});
