// vectors/connect-profiles-v1.json (Saltix 19-connect §11): the Connect profile as the node encodes, signs and refuses
// it, its link for the owner's wallet, and the owner's SetGrainProfile — reproduced byte for byte, every refusal for its
// reason. The `key` refusals need the owner's key event log: this SDK checks it offline (`keylog.ts`), so every one of
// them is checked here too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import {
  encodeProfile, encodeSignedProfile, decodeSignedProfile, decodeProfile, profileMessage, profileProblem, verifyProfile, signProfile,
  checkGrainProfile, checkSiteProfile, checkProfileOwner, profileFromJson, signedProfileFromJson, profileToJson, profileText, plainOwnerOf,
  httpsLinkOk, supportOk, connectOriginOk, refusedChar, profileTextOk, readProfileLink, profileLink, unownedProfile, ProfileError, ProfileLinkError,
  MAX_PROFILE_BYTES, MAX_PROFILE_LINK, PROFILE_LINK_PREFIX, PROFILE_DOMAIN, CONNECT_PROFILE_PATH, PROFILE_LIMITS, policyOf,
  encodeGrainTx, signGrainTx, grainCallProblem, minimumFee, toHex, fromHex, toBase64, derive,
} from "../dist/index.js";
import * as web from "../dist/web.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/connect-profiles-v1.json", import.meta.url), "utf8"));
const genesis = fromHex(v.chain.genesis_hash_hex, 32);
const policy = policyOf(v.chain.account_policy);
const events = (name) => (name === null ? null : v.logs[name].map((e) => fromHex(e.event_hex)));
const ownerSecret = fromHex(v.keys.owner_secret_hex, 32);
const siteSecret = fromHex(v.keys.site_secret_hex, 32);

/** What a reader does with a profile's bytes: decode strictly, verify, check it is the service's, then (a site's) that
 *  its key speaks for the owner. The first reason, or "taken". */
function read(bytes, checkedFor, log) {
  let s;
  try {
    s = decodeSignedProfile(bytes);
  } catch (e) {
    assert.ok(e instanceof ProfileError, String(e));
    return e.reason;
  }
  const problem = "grain" in checkedFor
    ? checkGrainProfile(s, checkedFor.grain.slug, checkedFor.grain.owner_hex)
    : checkSiteProfile(s, checkedFor.site.origin);
  if (problem) return problem;
  if (log !== null) return checkProfileOwner(s, events(log), genesis, policy) ?? "taken";
  return "taken";
}

test("the constants are the format's", () => {
  assert.equal(PROFILE_DOMAIN, v.domain);
  assert.equal(CONNECT_PROFILE_PATH, v.well_known_path);
  assert.equal(MAX_PROFILE_BYTES, v.limits.max_profile_bytes);
  assert.deepEqual(
    [PROFILE_LIMITS.languages, PROFILE_LIMITS.tagline, PROFILE_LIMITS.about, PROFILE_LIMITS.highlights, PROFILE_LIMITS.highlight, PROFILE_LIMITS.privacy, PROFILE_LIMITS.linkBytes, PROFILE_LIMITS.siteName],
    [v.limits.max_languages, v.limits.tagline, v.limits.about, v.limits.highlights, v.limits.highlight, v.limits.privacy, v.limits.link_bytes, v.limits.site_name],
  );
  assert.equal(PROFILE_LINK_PREFIX, v.profile_link.prefix);
  assert.equal(MAX_PROFILE_LINK, v.profile_link.max_characters);
  assert.equal(plainOwnerOf(ownerSecret), v.keys.owner_hex);
  assert.equal(plainOwnerOf(siteSecret), v.keys.site_owner_hex);
});

test("every accepted profile: Borsh, message, signature, JSON form, and the reader takes it", () => {
  assert.equal(v.accepted.length, 3);
  for (const a of v.accepted) {
    const s = signedProfileFromJson(a.json);
    assert.equal(toHex(encodeProfile(s.profile)), a.profile_borsh_hex, a.name);
    assert.equal(toHex(profileMessage(s.profile)), a.message_hex, a.name);
    assert.equal(toHex(encodeSignedProfile(s)), a.signed_borsh_hex, a.name);
    assert.deepEqual(decodeSignedProfile(fromHex(a.signed_borsh_hex)), s, a.name);
    assert.equal(profileProblem(s.profile), null, a.name);
    assert.equal(verifyProfile(s), null, a.name);
    assert.equal(read(fromHex(a.signed_borsh_hex), a.for, a.log), "taken", a.name);
    // The JSON form: the same object back, whatever the order of its keys.
    assert.deepEqual(profileToJson(s), s, a.name);
    assert.deepEqual(signedProfileFromJson(JSON.parse(JSON.stringify(profileToJson(s)))), s, a.name);
    // Ed25519 is deterministic: the vectors' keys sign the same bytes again. The managed phone signs P-256 in its wallet.
    if ("ed25519" in s.key) {
      const secret = s.profile.owner === v.keys.owner_hex ? ownerSecret : siteSecret;
      assert.deepEqual(signProfile(s.profile, secret), s, a.name);
    } else {
      assert.equal(s.profile.owner, v.keys.managed_owner_hex);
    }
  }
  const grain = signedProfileFromJson(v.accepted[0].json);
  assert.equal(profileText(grain.profile, "ru").tagline, grain.profile.texts.ru.tagline);
  assert.equal(profileText(grain.profile, "de").tagline, grain.profile.texts.en.tagline, "else English");
});

test("every refused profile fails for its reason, in the readers' order", () => {
  assert.ok(v.refused.length >= 30);
  const reasons = new Set();
  for (const r of v.refused) {
    assert.equal(read(fromHex(r.signed_borsh_hex), r.for, r.log), r.reason, r.name);
    reasons.add(r.reason);
  }
  for (const reason of ["encoding", "version", "subject", "revision", "languages", "tagline", "about", "highlights", "privacy", "website", "support", "terms", "size", "signature", "service", "owner", "key"]) {
    assert.ok(reasons.has(reason), `a vector refused for ${reason}`);
  }
});

test("a site's key is checked against the owner's key event log", () => {
  const plain = signedProfileFromJson(v.accepted.find((a) => a.name === "site-plain-key").json);
  const managed = signedProfileFromJson(v.accepted.find((a) => a.name === "site-managed-phone").json);
  assert.equal(checkProfileOwner(plain, [], genesis, policy), null);
  assert.equal(checkProfileOwner(managed, events("managed"), genesis, policy), null);
  // A managed account's phone with no log, a plain key with the managed log, the log on another chain or cut short.
  assert.equal(checkProfileOwner(managed, [], genesis, policy), "key");
  assert.equal(checkProfileOwner(plain, events("managed"), genesis, policy), "key");
  assert.equal(checkProfileOwner(managed, events("managed"), new Uint8Array(32).fill(1), policy), "key");
  assert.equal(checkProfileOwner(managed, events("managed").slice(1), genesis, policy), "key");
  assert.equal(checkProfileOwner({ ...managed, profile: { ...managed.profile, owner: v.keys.site_owner_hex } }, events("managed"), genesis, policy), "key");
});

test("links: what a website or terms link and a support contact may be", () => {
  assert.ok(v.links.length > 20);
  for (const l of v.links) {
    assert.equal(httpsLinkOk(l.text), l.link, `link ${l.text}`);
    assert.equal(supportOk(l.text), l.support, `support ${l.text}`);
  }
  assert.equal(httpsLinkOk(`https://a.example/${"x".repeat(256 - 18)}`), true, "256 bytes");
  assert.equal(httpsLinkOk(`https://a.example/${"x".repeat(256 - 17)}`), false, "257 bytes");
  assert.equal(supportOk(`mailto:${"a".repeat(65)}@b.example`), false, "a local part of 65");
  assert.equal(supportOk("mailto:a..b@b.example"), false);
  assert.equal(supportOk("mailto:help@-b.example"), false);
  assert.equal(supportOk(null), false);
  for (const o of ["https://a.example:", "https://[::1]x", "https://[]", "https://a.example:0", "https://a.example:65536", "http://a.example:80", "https://a..example", `https://${"a".repeat(64)}.example`]) {
    assert.equal(connectOriginOk(o), false, o);
  }
  for (const o of ["http://localhost:5173", "https://[::1]:8443", "https://xn--80ak6aa92e.example"]) assert.equal(connectOriginOk(o), true, o);
});

test("texts: characters, lines and spaces as the node counts them", () => {
  for (const c of [0, 9, 10, 0x7f, 0x85, 0xad, 0x61c, 0x200b, 0x202e, 0x2066, 0x2028, 0x2029, 0xfeff, 0xe0001]) assert.ok(refusedChar(c), c.toString(16));
  for (const c of ["a", "я", " ", "…", "😀"]) assert.ok(!refusedChar(c.codePointAt(0)), c);
  assert.ok(profileTextOk("😀".repeat(80), 1, 80, false), "80 characters of two UTF-16 units each");
  assert.ok(!profileTextOk("😀".repeat(81), 1, 80, false));
  assert.ok(profileTextOk("one\ntwo", 0, 600, true));
  assert.ok(!profileTextOk("one\ntwo", 0, 300, false), "a line feed only in about");
  assert.ok(!profileTextOk("one\n", 0, 600, true), "nor at the end");
  assert.ok(!profileTextOk(" one", 1, 80, false));
  assert.ok(!profileTextOk("\ud800", 1, 80, false), "a lone surrogate is no character");
  assert.ok(profileTextOk("", 0, 600, true));
  assert.ok(!profileTextOk("", 1, 80, false));
});

test("the profile link: written, read back, and every refused link for its reason", () => {
  const grain = signedProfileFromJson(v.accepted[0].json).profile;
  assert.equal(toHex(encodeProfile(unownedProfile(grain))), v.profile_link.unowned_borsh_hex);
  // The vector's link (miniz) and this SDK's (zlib) read back to the same profile: a reader never compresses again.
  assert.deepEqual(readProfileLink(v.profile_link.link), unownedProfile(grain));
  const ours = profileLink(grain);
  assert.ok(ours.startsWith(PROFILE_LINK_PREFIX) && ours.length <= MAX_PROFILE_LINK);
  assert.deepEqual(readProfileLink(ours), unownedProfile(grain));
  assert.deepEqual(readProfileLink(PROFILE_LINK_PREFIX + toBase64(new Uint8Array(deflateRawSync(encodeProfile(unownedProfile(grain)), { level: 0 })), true)), unownedProfile(grain));
  assert.ok(v.profile_link.refused.length >= 10);
  for (const r of v.profile_link.refused) {
    assert.throws(() => readProfileLink(r.link), (e) => e instanceof ProfileLinkError && e.problem === r.reason, r.name);
  }
  // No link for a site's profile, nor for one too long for a QR code (within its 8 KiB: six more languages of noise).
  const site = signedProfileFromJson(v.accepted[1].json).profile;
  assert.throws(() => profileLink(site), (e) => e.problem === "subject");
  const long = structuredClone(grain);
  // Hex of hashes: text that does not compress, as the node's test makes it.
  const noise = (lang, what, chars) => {
    let t = "";
    for (let n = 0; t.length < chars; n++) t += toHex(derive("test noise", new TextEncoder().encode(`${lang} ${what} ${n}`)));
    return t.slice(0, chars);
  };
  for (const lang of ["de", "es", "fr", "it", "pt", "uk"]) long.texts[lang] = { ...long.texts.en, tagline: noise(lang, "tagline", 80), about: noise(lang, "about", 600) };
  assert.equal(profileProblem(long), null, "within its bounds");
  assert.throws(() => profileLink(long), (e) => e instanceof ProfileLinkError && e.problem === "size");
});

test("SetGrainProfile: the owner's transactions byte for byte", () => {
  const s = signedProfileFromJson(v.accepted[0].json);
  assert.equal(v.transactions.length, 2);
  for (const t of v.transactions) {
    const call = { profile: { slug: "split-bill", profile: t.name === "set" ? s : null } };
    const fields = { nonce: BigInt(t.nonce), fee: BigInt(t.fee), validUntilSlot: BigInt(t.valid_until_slot) };
    const body = encodeGrainTx({ ...fields, sender: s.key.ed25519 }, call);
    assert.equal(toHex(body), t.transaction_hex, t.name);
    // Action::Registry's tag 1 and the call, then the amount (0).
    assert.equal(toHex(body).slice(2 * (1 + 32 + 24), -16), "01" + t.call_borsh_hex, t.name);
    assert.equal(t.amount, "0");
    const signed = signGrainTx(ownerSecret, fields, call, v.chain.genesis_hash_hex);
    assert.equal(signed.hex, t.signed_hex, t.name);
    assert.equal(signed.id, t.id_hex, t.name);
    assert.ok(minimumFee(call) > 0n);
  }
});

test("SetGrainProfile is refused before it leaves for another grain, another owner or a broken profile", () => {
  const s = signedProfileFromJson(v.accepted[0].json);
  const owner = v.keys.owner_hex;
  const call = (profile, slug = "split-bill") => ({ profile: { slug, profile } });
  assert.equal(grainCallProblem(call(s), owner), null);
  assert.equal(grainCallProblem(call(null), owner), null, "clearing");
  assert.match(grainCallProblem(call(s, "split-bills"), owner), /service/);
  assert.match(grainCallProblem(call(s), "77".repeat(32)), /owner/);
  assert.match(grainCallProblem(call({ ...s, signature: "00".repeat(64) }), owner), /signature/);
  assert.match(grainCallProblem(call(null, "-x"), owner), /slug/);
  // Signed by the vectors' site operator: not this key's account.
  assert.throws(() => signGrainTx(siteSecret, { nonce: 1, fee: 1, validUntilSlot: 1 }, call(s), v.chain.genesis_hash_hex), /owner/);
});

test("the JSON form is read as the node reads it", () => {
  const json = v.accepted[0].json;
  const bad = (change, what) => {
    const copy = structuredClone(json);
    change(copy);
    assert.throws(() => signedProfileFromJson(copy), (e) => e instanceof ProfileError && e.reason === "json", what);
  };
  bad((j) => { j.profile.owner = j.profile.owner.toUpperCase(); }, "an uppercase owner");
  bad((j) => { j.profile.subject = { grain: { slug: "a" }, site: {} }; }, "two subjects");
  bad((j) => { j.profile.subject = { app: { slug: "split-bill" } }; }, "another subject");
  bad((j) => { j.profile.revision = 2 ** 32; }, "a revision beyond u32");
  bad((j) => { j.profile.version = 1.5; }, "a version that is no integer");
  bad((j) => { j.profile.texts.en.highlights = "one"; }, "highlights not a list");
  bad((j) => { j.profile.texts.en.tagline = "\ud800"; }, "a lone surrogate");
  bad((j) => { j.profile.website = 7; }, "a link that is no text");
  bad((j) => { j.key = { ed25519: j.key.ed25519.toUpperCase() }; }, "an uppercase key");
  bad((j) => { j.signature = j.signature.slice(2); }, "a short signature");
  const absent = structuredClone(json);
  delete absent.profile.website;
  assert.equal(signedProfileFromJson(absent).profile.website, null, "an absent link is null");
  // `__proto__` as a language is a language (refused by its code), never the object's prototype.
  const proto = JSON.parse(JSON.stringify(json.profile).replace('"ru":', '"__proto__":'));
  const p = profileFromJson(proto);
  assert.ok(Object.hasOwn(p.texts, "__proto__"));
  assert.equal(profileProblem(p), "languages");
});

test("profileProblem never throws, and the encoding refuses what Borsh cannot hold", () => {
  const p = signedProfileFromJson(v.accepted[0].json).profile;
  for (const broken of [null, {}, { ...p, subject: null }, { ...p, texts: null }, { ...p, texts: { en: null } }, { ...p, owner: "zz" }, { ...p, revision: -1 }, { ...p, website: undefined }]) {
    assert.notEqual(profileProblem(broken), null);
  }
  assert.throws(() => encodeProfile({ ...p, revision: 2 ** 32 }), TypeError);
  assert.throws(() => decodeProfile(new Uint8Array([1, 2])), (e) => e.reason === "encoding");
  // A leading U+FEFF stays in the text, as the node reads it: refused by the text's rule, not taken as another text.
  const bom = { ...p, texts: { ...p.texts, en: { ...p.texts.en, tagline: "﻿Split" } } };
  const signed = { profile: bom, key: { ed25519: "00".repeat(32) }, signature: "00".repeat(64) };
  assert.equal(decodeSignedProfile(encodeSignedProfile(signed)).profile.texts.en.tagline, "﻿Split");
  assert.equal(profileProblem(bom), "tagline");
});

test("the web entry runs without Node's built-ins and has the profile", async () => {
  const text = readFileSync(new URL("../dist/web.js", import.meta.url), "utf8");
  assert.doesNotMatch(text, /node:/);
  for (const name of ["profileProblem", "checkSiteProfile", "checkProfileOwner", "readProfileLink", "checkLog", "verifyByDeviceKey"]) {
    assert.equal(typeof web[name], "function", name);
  }
  assert.equal(web.profileLink, undefined, "the link's writer needs zlib: Node only");
  // Nothing it imports reaches Node either.
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(new URL(file, new URL("../dist/", import.meta.url)), "utf8");
    assert.doesNotMatch(source, /from "node:/, file);
    for (const m of source.matchAll(/from "\.\/([a-z-]+\.js)"/g)) walk(m[1]);
  };
  walk("web.js");
  assert.ok(seen.has("profile.js") && seen.has("keylog.js"));
});

test("Ed25519 is verified strictly, as the node does: a small-order key verifies nothing", async () => {
  const { ed25519 } = await import("@noble/curves/ed25519");
  const { verifyByDeviceKey, verifyEd25519 } = await import("../dist/index.js");
  const identity = fromHex("01" + "00".repeat(31), 32);
  const signature = fromHex("01" + "00".repeat(63), 64);
  const message = new Uint8Array(32).fill(7);
  assert.equal(ed25519.verify(signature, message, identity), true, "a permissive check takes it");
  assert.equal(verifyEd25519(identity, message, signature), false);
  assert.equal(verifyByDeviceKey({ ed25519: toHex(identity) }, message, toHex(signature)), false);
  // A profile "signed" so is refused for its signature.
  const p = signedProfileFromJson(v.accepted[0].json).profile;
  assert.equal(verifyProfile({ profile: p, key: { ed25519: toHex(identity) }, signature: toHex(signature) }), "signature");
});
