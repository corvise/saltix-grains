// One strict Ed25519 check, the node's own (saltix-crypto `ed25519::verify`: ed25519-dalek 2's `verify_strict`): every
// signature the SDK takes goes through `verifyEd25519`, so a key of small order, a torsion part in R or in a key, or an
// s that is not reduced passes nowhere the node would refuse it, and nothing the node takes is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  SignIns, accountId, chatHelloProblem, chatRequestProblem, decodeChatFrame, decodeSignedChatRequest, decodeSignedChatSpec,
  decodeSignedGrainStats, decodeSponsorCert, ed25519KeyValid, encodeAddress, encodeSponsorCert, fromHex, grainStatsProblem,
  issueSponsorCert, recordProblem, signAddressRecord, signKeyBinding, sponsorCertProblem, toHex, verifyByDeviceKey, verifyEd25519,
  verifyLogin, verifyManifest,
} from "../dist/index.js";

const vectors = (name) => JSON.parse(readFileSync(new URL(`../../../vectors/${name}`, import.meta.url), "utf8"));

/**
 * Cases built to tell the checks apart, with ed25519-dalek 2.2.0's verdicts (`verify_strict`, and
 * `VerifyingKey::from_bytes(..).is_ok_and(|k| !k.is_weak())`, saltix-crypto's `is_valid_public_key`) for each: name,
 * key, message, signature, whether it verifies, whether the key is one the node takes. The key af06… is the fake secret
 * 0x61 × 32's. Decoding `R` or the key leniently changes no verdict (an encoding with y ≥ p is either of small order or
 * a point no one can sign for), so the node's lenient decoder and this canonical one agree on every signature.
 */
const CASES = [
  ["honest", "af06a3e3291714e4f356c19c9b15cd1951ec6e6662aa77be07547f289383341d", "0707070707070707070707070707070707070707070707070707070707070707",
    "d12bae9994b1896ca58dcb649a77292e87be3a9721667664bb83e881371c42241321fbe7092dfb0490b29935bd51e4325e404608d099bb9aa9b4d646e0d26003", true, true],
  ["another_message", "af06a3e3291714e4f356c19c9b15cd1951ec6e6662aa77be07547f289383341d", "0808080808080808080808080808080808080808080808080808080808080808",
    "d12bae9994b1896ca58dcb649a77292e87be3a9721667664bb83e881371c42241321fbe7092dfb0490b29935bd51e4325e404608d099bb9aa9b4d646e0d26003", false, true],
  // The identity point as the key, R the identity and s = 0: a permissive check takes it for any message.
  ["identity_key_forged", "0100000000000000000000000000000000000000000000000000000000000000", "0707070707070707070707070707070707070707070707070707070707070707",
    "01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", false, false],
  // The identity as the key, R = B and s = 1: [s]B − [k]A is R exactly, for any message; only the key's order refuses it.
  ["identity_key_r_is_b", "0100000000000000000000000000000000000000000000000000000000000000", "0707070707070707070707070707070707070707070707070707070707070707",
    "58666666666666666666666666666666666666666666666666666666666666660100000000000000000000000000000000000000000000000000000000000000", false, false],
  // R the identity, s = k·a: the equation holds, R is of small order.
  ["small_order_r", "af06a3e3291714e4f356c19c9b15cd1951ec6e6662aa77be07547f289383341d", "0707070707070707070707070707070707070707070707070707070707070707",
    "01000000000000000000000000000000000000000000000000000000000000005d712a52ead1a37e29805d6c768dc5641e133dc5d3b63e7ca463af544607280c", false, true],
  // R = rB + T (T of order 8), s = r + k·a: [8]R = [8]([s]B − [k]A), but R ≠ [s]B − [k]A.
  ["mixed_order_r", "af06a3e3291714e4f356c19c9b15cd1951ec6e6662aa77be07547f289383341d", "0707070707070707070707070707070707070707070707070707070707070707",
    "e9a2682b08eb9f2473372b17535c7ef9e7ca6240804bd9ff9f9d6b599c974d76478ba23024839c739d64aa0ddca439c6c306262531999ba5928ca7442171d703", false, true],
  // A key with a torsion part, A' = A + T: a key the node takes; R = [s]B − [k]A' only when k·T is the identity.
  ["mixed_order_key_k_nonzero", "fe138c89028acc5146dec5ec6f4d3933b0d0c1b32d8f4e8ec38c68f7e523d005", "0707070707070707070707070707070707070707070707070707070707070707",
    "6e719081265dbf2466f63c1aad36615d9f0b5a3577eaa89f131a602901def916a27bc13f3fccdf1d553e561884d7735654a97e47f05cf30a9573fa614165f60f", false, true],
  ["mixed_order_key_k_zero", "fe138c89028acc5146dec5ec6f4d3933b0d0c1b32d8f4e8ec38c68f7e523d005", "0707070707070707070707070707070707070707070707070707070707070707",
    "ffea88733a5011a8382c371495f49dd114222cc68d4e1ab6eae4d0a37766649864492c93713db7d0723b790d24c9ece6bbbbaaf7b543acb8e815a9fafac21d0e", true, true],
  // The honest signature with s + L.
  ["s_plus_l", "af06a3e3291714e4f356c19c9b15cd1951ec6e6662aa77be07547f289383341d", "0707070707070707070707070707070707070707070707070707070707070707",
    "d12bae9994b1896ca58dcb649a77292e87be3a9721667664bb83e881371c422400f5f04424900d5d664f91d89b4bc3475e404608d099bb9aa9b4d646e0d26013", false, true],
  // R the identity written with y = p + 1.
  ["noncanonical_small_order_r", "af06a3e3291714e4f356c19c9b15cd1951ec6e6662aa77be07547f289383341d", "0707070707070707070707070707070707070707070707070707070707070707",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7ff3723b51da023271bde5cad81a929ac842ff35ebfdbc0c08a36e8ee33e007503", false, true],
  // A key written with y = p + 3: the node's decoder takes it, a point not of small order whose secret nobody knows.
  ["noncanonical_key", "f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "0707070707070707070707070707070707070707070707070707070707070707",
    "d12bae9994b1896ca58dcb649a77292e87be3a9721667664bb83e881371c42241321fbe7092dfb0490b29935bd51e4325e404608d099bb9aa9b4d646e0d26003", false, true],
  ["noncanonical_key_sign_bit", "f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "0707070707070707070707070707070707070707070707070707070707070707",
    "d12bae9994b1896ca58dcb649a77292e87be3a9721667664bb83e881371c42241321fbe7092dfb0490b29935bd51e4325e404608d099bb9aa9b4d646e0d26003", false, true],
  // The identity with its sign bit set (x = 0, x₀ = 1).
  ["identity_key_sign_bit", "0100000000000000000000000000000000000000000000000000000000000080", "0707070707070707070707070707070707070707070707070707070707070707",
    "01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", false, false],
];

test("each case is decided as the node decides it", () => {
  for (const [name, key, message, signature, verifies, validKey] of CASES) {
    assert.equal(verifyEd25519(fromHex(key, 32), fromHex(message, 32), fromHex(signature, 64)), verifies, name);
    assert.equal(verifyByDeviceKey({ ed25519: key }, fromHex(message, 32), signature), verifies, name);
    assert.equal(ed25519KeyValid(fromHex(key, 32)), validKey, `${name}: the key`);
  }
  // The cases tell the checks apart: a permissive (cofactored) check takes the forged ones.
  const permissive = (name) => {
    const [, key, message, signature] = CASES.find((c) => c[0] === name);
    return ed25519.verify(fromHex(signature, 64), fromHex(message, 32), fromHex(key, 32));
  };
  for (const name of ["identity_key_forged", "identity_key_r_is_b", "mixed_order_r", "mixed_order_key_k_nonzero"]) {
    assert.equal(permissive(name), true, name);
  }
  // What is not 32 and 64 bytes verifies nothing.
  const [, key, message, signature] = CASES[0];
  assert.equal(verifyEd25519(fromHex(key, 32).subarray(1), fromHex(message, 32), fromHex(signature, 64)), false);
  assert.equal(verifyEd25519(fromHex(key, 32), fromHex(message, 32), fromHex(signature, 64).subarray(1)), false);
});

test("no point of small order is a key, however it is written", () => {
  const small = [
    "0100000000000000000000000000000000000000000000000000000000000000", "0100000000000000000000000000000000000000000000000000000000000080",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "0000000000000000000000000000000000000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000080",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  ];
  for (const k of small) {
    assert.ok(ed25519.ExtendedPoint.fromHex(k, true).isSmallOrder(), `${k} is a point of small order`);
    assert.equal(ed25519KeyValid(fromHex(k, 32)), false, k);
  }
  // Not a point at all.
  assert.equal(ed25519KeyValid(fromHex("02" + "00".repeat(31), 32)), false);
});

// The key of small order and the "signature" that a permissive check takes for any message.
const IDENTITY = "01" + "00".repeat(31);
const FORGED = "01" + "00".repeat(63);

test("a key of small order signs nothing in, wherever the SDK checks a signature", async () => {
  const t = Date.now();
  // A page's login (the review's proof of concept).
  const login = { slug: "chess-club", origin: "https://chess.example", challenge: "ab".repeat(32), now: t };
  assert.equal(verifyLogin({ key: IDENTITY, signature: FORGED, at: t }, login), false);
  const signIns = new SignIns({ slug: "chess-club", origin: "https://chess.example", network: "devnet", now: () => t });
  const challenge = signIns.challenge();
  assert.deepEqual(await signIns.check({ challenge, key: IDENTITY, signature: FORGED, at: t, origin: "https://chess.example", member: null }),
    { ok: false, reason: "login" });

  // A chat's request and a team member's hello, from the small-order key's own address.
  const chats = vectors("grain-chats-v1.json");
  const chain = { genesis: chats.chain.genesis_hash_hex, network: chats.chain.network };
  const now = Number(chats.now_ms);
  const from = encodeAddress("devnet", accountId(fromHex(IDENTITY, 32)));
  const spec = decodeSignedChatSpec(chats.spec_doc.signed_hex).spec;
  const request = { ...decodeSignedChatRequest(fromHex(chats.request.signed_hex)), key: IDENTITY, signature: FORGED };
  assert.equal(chatRequestProblem(request, { chain, spec, from, now }), "signature");
  const hello = decodeChatFrame(fromHex(chats.hello.frame_hex)).hello;
  assert.equal(chatHelloProblem({ ...hello, key: IDENTITY, signature: FORGED }, { chain, slug: "access", from, now }), "signature");

  // An app's numbers, from a server key of small order the registry would never name.
  const stats = decodeSignedGrainStats(chats.stats.signed_hex);
  assert.equal(grainStatsProblem({ ...stats, key: IDENTITY, signature: FORGED }, { genesis: chain.genesis, slug: "access", servers: [IDENTITY], now }),
    "signature");

  // A sponsor's certificate under a sponsor key of small order.
  const genesis = "5a".repeat(32);
  const { cert } = decodeSponsorCert(issueSponsorCert(fromHex("61".repeat(32), 32), {
    user_key: "62".repeat(32), per_day: 10n, services: 1, issued: 1_000, expires: 9_000,
  }, genesis));
  const forgedCert = toHex(encodeSponsorCert({ ...cert, sponsor: IDENTITY })) + FORGED;
  assert.equal(sponsorCertProblem(forgedCert, toHex(accountId(fromHex(IDENTITY, 32))), genesis), "signature");

  // A relay's address record whose key binding names the small-order key.
  const secret = fromHex("61".repeat(32), 32);
  const binding = { ...signKeyBinding(secret, new Uint8Array(32).fill(9), t), accountKey: fromHex(IDENTITY, 32), signature: fromHex(FORGED, 64) };
  const record = { ...signAddressRecord(secret, binding, new Uint8Array(32).fill(3), new Uint8Array(16), t), signature: fromHex(FORGED, 64) };
  assert.equal(recordProblem(record, t), "binding");
});

test("the golden vectors' signatures verify strictly, and a changed byte verifies nothing", () => {
  const grains = vectors("grains-v1.json");
  const l = grains.login;
  assert.equal(verifyEd25519(fromHex(l.key, 32), fromHex(l.message, 32), fromHex(l.signature, 64)), true);
  assert.equal(verifyLogin({ key: l.key, signature: l.signature, at: l.at, origin: l.origin },
    { slug: l.slug, origin: l.origin, challenge: l.challenge, now: l.at }), true);
  const changed = fromHex(l.message, 32);
  changed[0] ^= 1;
  assert.equal(verifyEd25519(fromHex(l.key, 32), changed, fromHex(l.signature, 64)), false);
  for (const m of grains.manifests) {
    assert.equal(verifyByDeviceKey(m.json.manifest.owner_key, fromHex(m.message, 32), m.signature), true, m.name);
    assert.ok(verifyManifest(m.json), m.name);
  }
  const connect = vectors("connect-v1.json");
  for (const g of connect.grants) {
    assert.equal(verifyByDeviceKey(g.signer, fromHex(g.message_hex, 32), g.signature_hex), true, g.name);
    const flipped = fromHex(g.signature_hex, 64);
    flipped[1] ^= 1;
    assert.equal(verifyByDeviceKey(g.signer, fromHex(g.message_hex, 32), toHex(flipped)), false, g.name);
  }
  assert.ok(connect.grants.some((g) => "ed25519" in g.signer) && connect.grants.some((g) => "p256" in g.signer));
});

test("verifyEd25519 is the one Ed25519 check: no other module calls a library's", () => {
  const roots = ["../src/", "../../connect/src/", "../../grain/src/", "../../cli/src/", "../../../simulator/"];
  const found = [];
  for (const root of roots) {
    const dir = new URL(root, import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, dir), "utf8");
      if (/\bed25519\.verify\s*\(/.test(source) && !(root === "../src/" && file === "keys.ts")) found.push(`${root}${file}`);
    }
  }
  assert.deepEqual(found, []);
});
