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
  encodeGrainTx, signGrainTx, grainCallProblem, minimumFee, toHex, fromHex, toBase64, derive, Writer,
  PROFILE_VERSION_2, SUPPORT_ADDRESS_VERSION, SUPPORT_CONSENT_DOMAIN, supportAddress, supportKind, supportAccount, supportProblem, supportConsentAccount,
  supportConsentMessage, signSupportConsent, verifySupportConsent, encodeSupportConsent, grainOwnerPayload, serverKeyProofPayload, offlineOwner,
  callVersions, supportConsentFromEnvironment, SUPPORT_KEY_ENV, accountId, encodeAddress,
} from "../dist/index.js";
import { ed25519 } from "@noble/curves/ed25519";
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

test("one signed profile has one encoding: languages out of order or repeated are refused", () => {
  const s = signedProfileFromJson(v.accepted[0].json);
  // The profile's Borsh with its languages in the order given, not the node's (sorted), and its signature after it.
  const encodeAs = (langs) => {
    const p = s.profile;
    const w = new Writer().u8(p.version).u8(0).string(p.subject.grain.slug).fixed(fromHex(p.owner, 32), 32).u32(p.revision).u32(langs.length);
    for (const lang of langs) {
      const t = p.texts[lang];
      w.string(lang).string(t.tagline).string(t.about).u32(t.highlights.length);
      t.highlights.forEach((h) => w.string(h));
      w.string(t.privacy);
    }
    const link = (w, x) => w.string(x);
    w.option(p.website, link).option(p.support, link).option(p.terms, link).u8(0).fixed(fromHex(s.key.ed25519, 32), 32);
    return w.fixed(fromHex(s.signature, 64), 64).done();
  };
  assert.equal(toHex(encodeAs(["en", "ru"])), v.accepted[0].signed_borsh_hex, "the node's order");
  for (const langs of [["ru", "en"], ["en", "en", "ru"], ["en", "ru", "ru"]]) {
    assert.throws(() => decodeSignedProfile(encodeAs(langs)), (e) => e instanceof ProfileError && e.reason === "encoding", langs.join(","));
  }
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

// ── Format 2: a support address with its holder's consent (19-connect §11.1, protocol version 9) ─────────────────────

const sa = v.support_address;
const caseOf = (name) => signedProfileFromJson(sa.cases.find((c) => c.name === name).json);
const genesisHex = v.chain.genesis_hash_hex;
/** A block of protocol `version` on the vectors' network. */
const block = (version) => ({ version, network: v.chain.network, genesis: genesisHex });

test("support addresses: every case byte for byte, and as a block of version 8 and one of version 9 reads it", () => {
  assert.equal(sa.format, PROFILE_VERSION_2);
  assert.equal(sa.from_version, SUPPORT_ADDRESS_VERSION);
  assert.ok(sa.cases.length >= 12);
  const reasons = new Set();
  for (const c of sa.cases) {
    const s = signedProfileFromJson(c.json);
    assert.equal(toHex(encodeProfile(s.profile)), c.profile_borsh_hex, c.name);
    assert.equal(toHex(profileMessage(s.profile)), c.message_hex, c.name);
    assert.equal(toHex(encodeSignedProfile(s)), c.signed_borsh_hex, c.name);
    assert.deepEqual(decodeSignedProfile(fromHex(c.signed_borsh_hex)), s, c.name);
    assert.deepEqual(profileToJson(s), s, `${c.name}: the JSON form back`);
    assert.equal("support_consent" in profileToJson(s).profile, s.profile.version >= 2, `${c.name}: format 1's form has no such key`);
    const reason = (version) => checkGrainProfile(s, c.for.grain.slug, c.for.grain.owner_hex, block(version));
    assert.equal(reason(SUPPORT_ADDRESS_VERSION - 1), c.at_version_8, `${c.name} at version 8`);
    assert.equal(reason(SUPPORT_ADDRESS_VERSION), c.at_version_9, `${c.name} at version 9`);
    assert.equal(supportAccount(s.profile), c.support_account_hex, `${c.name}: whom a wallet opens a chat with`);
    reasons.add(c.at_version_9);
  }
  for (const reason of [null, "support", "consent_missing", "consent_unneeded", "consent_key", "consent_slug", "consent_owner", "consent_signature"]) {
    assert.ok(reasons.has(reason), `a case refused at version 9 for ${reason}`);
  }
});

test("support contacts in the address form: the canonical text of a kind people write from, any network", () => {
  assert.ok(sa.contacts.length >= 8);
  for (const c of sa.contacts) {
    const a = supportAddress(c.text);
    assert.equal(a?.network ?? null, c.network, c.name);
    assert.equal(a?.account ?? null, c.account_hex, c.name);
    assert.equal(supportOk(c.text), false, `${c.name}: no form of format 1`);
    assert.equal(supportKind(c.text), a === null ? null : "address", c.name);
  }
  assert.equal(supportAddress(sa.contacts.find((c) => c.name === "managed").text).kind, 5);
  for (const [text, kind] of [["@splitbill_help", "username"], ["mailto:help@splitbill.example", "email"], ["https://splitbill.example", "link"], ["tel:+100", null], [null, null]]) {
    assert.equal(supportKind(text), kind, String(text));
  }
});

test("the consent: payload, message, Borsh and signature as the node's, signed again by the agent's key, and held to them", () => {
  const c = sa.consent;
  assert.equal(SUPPORT_CONSENT_DOMAIN, c.domain);
  const consent = caseOf("consented").profile.support_consent;
  assert.equal(toHex(grainOwnerPayload(genesisHex, consent.slug, consent.owner)), c.payload_hex);
  // The payload a server key's proof signs too (24-app-studio §2), each in a domain of its own.
  assert.equal(toHex(serverKeyProofPayload(genesisHex, consent.slug, consent.owner)), c.payload_hex);
  assert.equal(toHex(supportConsentMessage(genesisHex, consent.slug, consent.owner)), c.message_hex);
  assert.equal(toHex(encodeSupportConsent(consent)), c.borsh_hex);
  assert.deepEqual([consent.key, consent.signature], [c.key_hex, c.signature_hex]);
  // Ed25519 is deterministic: the agent's key signs the same consent again.
  assert.deepEqual(signSupportConsent(fromHex(sa.agent_secret_hex, 32), genesisHex, consent.slug, consent.owner), consent);
  assert.ok(verifySupportConsent(consent, genesisHex));
  assert.ok(!verifySupportConsent(consent, "5b".repeat(32)), "another network");
  assert.ok(!verifySupportConsent({ ...consent, slug: "split-bills" }, genesisHex), "another app");
  assert.ok(!verifySupportConsent({ ...consent, owner: "77".repeat(32) }, genesisHex), "another owner");
  assert.ok(!verifySupportConsent({ ...consent, signature: "zz" }, genesisHex), "no signature at all");
  // A personal address is its key's; a managed one is its first root key's root digest, kind 5.
  const agent = toHex(ed25519.getPublicKey(fromHex(sa.agent_secret_hex, 32)));
  assert.equal(supportConsentAccount(0, agent), supportAddress(caseOf("consented").profile.support).account);
  const managed = caseOf("managed-address-consented-by-its-first-root").profile;
  assert.equal(toHex(ed25519.getPublicKey(fromHex(sa.root_secret_hex, 32))), managed.support_consent.key);
  assert.equal(supportConsentAccount(5, managed.support_consent.key), supportAddress(managed.support).account);
  assert.notEqual(supportConsentAccount(0, managed.support_consent.key), supportAddress(managed.support).account);
  assert.equal(supportConsentAccount(2, agent), null, "a contract's address has no such key");
  assert.equal(supportConsentAccount(0, "ab"), null);
});

test("a reading: format 2 from version 9, an address of the reader's network, a consent signed on it, and the contact's rules alone", () => {
  const consented = caseOf("consented");
  assert.equal(verifyProfile(consented), null, "every format, any network, the consent's signature unchecked: the bounds alone");
  assert.equal(verifyProfile(consented, { version: 8 }), "version");
  assert.equal(verifyProfile(consented, { version: 9 }), null);
  assert.equal(verifyProfile(consented, { network: "testnet" }), "support", "a devnet address on a testnet");
  assert.equal(verifyProfile(consented, { genesis: "5b".repeat(32) }), "consent_signature", "the consent of another network");
  assert.equal(verifyProfile(caseOf("consent-on-another-network")), null, "unchecked without the genesis hash");
  assert.equal(verifyProfile(caseOf("consent-on-another-network"), { genesis: genesisHex }), "consent_signature");
  // Format 1 has no room for a consent: one in memory is a format the node would not encode.
  assert.equal(profileProblem({ ...consented.profile, version: 1 }), "version");
  // A wallet opens a chat with an address of format 2 alone: format 1 names none, not even the owner's own.
  const ownersOwn = caseOf("owners-own-address").profile;
  assert.equal(supportAccount(ownersOwn), v.keys.owner_hex);
  assert.equal(supportAccount({ ...ownersOwn, version: 1 }), null);
  // The contact's rules alone, whatever the rest of the profile says: what grain support checks.
  const broken = { ...consented.profile, texts: {} };
  assert.equal(profileProblem(broken), "languages");
  assert.equal(supportProblem(broken), null);
  assert.equal(supportProblem(broken, { genesis: genesisHex }), null);
  assert.equal(supportProblem({ ...broken, support_consent: null }), "consent_missing");
  assert.equal(supportProblem({ ...broken, support: "@splitbill_help" }), "consent_unneeded");
  assert.equal(supportProblem(broken, { genesis: "5b".repeat(32) }), "consent_signature");
  assert.equal(supportProblem({ ...broken, support_consent: { ...broken.support_consent, key: "zz" } }), "consent_key", "never throws");
  assert.equal(supportProblem({ ...broken, support_consent: { ...broken.support_consent, signature: "zz" } }), "consent_signature", "never throws");
  // A site's profile names its owner's own address alone: a consent binds an app.
  const site = signedProfileFromJson(v.accepted.find((a) => a.name === "site-plain-key").json).profile;
  const own = encodeAddress("devnet", fromHex(site.owner, 32));
  assert.equal(profileProblem({ ...site, version: 2, support: own, support_consent: null }), null, "a site's operator's own address");
  assert.equal(profileProblem({ ...site, version: 2, support: own, support_consent: null }, { version: 8 }), "version");
  assert.equal(profileProblem({ ...site, version: 2, support: supportOf("consented"), support_consent: consented.profile.support_consent }), "consent_slug");
});

/** A case's support contact. */
function supportOf(name) {
  return caseOf(name).profile.support;
}

test("the JSON form reads a consent strictly, and writes format 2's key only for format 2", () => {
  const json = sa.cases.find((c) => c.name === "consented").json;
  const bad = (change, what) => {
    const copy = structuredClone(json);
    change(copy.profile.support_consent);
    assert.throws(() => signedProfileFromJson(copy), (e) => e instanceof ProfileError && e.reason === "json", what);
  };
  bad((c) => { c.key = c.key.toUpperCase(); }, "an uppercase key");
  bad((c) => { c.signature = c.signature.slice(2); }, "a short signature");
  bad((c) => { c.slug = 7; }, "a slug that is no text");
  bad((c) => { delete c.owner; }, "no owner");
  const copy = structuredClone(json);
  copy.profile.support_consent = "yes";
  assert.throws(() => signedProfileFromJson(copy), (e) => e.reason === "json", "a consent that is no object");
  const none = structuredClone(json);
  none.profile.support_consent = null;
  assert.equal(signedProfileFromJson(none).profile.support_consent, null);
  // Format 1's form keeps its keys: no support_consent, as every reader before format 2 wrote it.
  assert.ok(!("support_consent" in profileToJson(signedProfileFromJson(v.accepted[0].json)).profile));
});

test("SetGrainProfile with a consented support address: the node's bytes, a call of protocol version 9, checked on the network it is signed for", () => {
  const t = sa.transaction;
  const s = caseOf("consented");
  const call = { profile: { slug: "split-bill", profile: s } };
  const fields = { nonce: BigInt(t.nonce), fee: BigInt(t.fee), validUntilSlot: BigInt(t.valid_until_slot) };
  const body = encodeGrainTx({ ...fields, sender: s.key.ed25519 }, call);
  assert.equal(toHex(body), t.transaction_hex);
  assert.equal(toHex(body).slice(2 * (1 + 32 + 24), -16), "01" + t.call_borsh_hex);
  const signed = signGrainTx(ownerSecret, fields, call, genesisHex);
  assert.equal(signed.hex, t.signed_hex);
  assert.equal(signed.id, t.id_hex);
  assert.deepEqual(callVersions(call), { since: SUPPORT_ADDRESS_VERSION, until: null }, "windowFor refuses it before version 9");
  assert.deepEqual(callVersions({ profile: { slug: "split-bill", profile: signedProfileFromJson(v.accepted[0].json) } }), { since: 1, until: null });
  assert.deepEqual(callVersions({ profile: { slug: "split-bill", profile: null } }), { since: 1, until: null });
  // The shard checks the consent on its network: signing for another refuses it before it leaves.
  assert.throws(() => signGrainTx(ownerSecret, fields, call, "5b".repeat(32)), /consent_signature/);
  assert.match(grainCallProblem({ profile: { slug: "split-bill", profile: caseOf("consent-missing") } }, v.keys.owner_hex), /consent_missing/);
});

test("the owner a project's profile is checked for offline: the consent's, the address's own, else the manifest's", () => {
  const consented = caseOf("consented").profile;
  const manifestOwner = "33".repeat(32);
  assert.equal(offlineOwner({ support: "@splitbill_help" }, manifestOwner), manifestOwner);
  assert.equal(offlineOwner({ support: consented.support, support_consent: consented.support_consent }, manifestOwner), consented.support_consent.owner);
  assert.equal(offlineOwner({ support: consented.support, support_consent: null }, manifestOwner), supportAddress(consented.support).account, "with no consent, the owner's own");
  assert.equal(offlineOwner({ support: consented.support, support_consent: { owner: "zz" } }, manifestOwner), manifestOwner);
  assert.equal(offlineOwner(null, manifestOwner), manifestOwner);
});

test("the consent from the environment: SALTIX_SUPPORT_KEY signs it, and nothing else reads a key", () => {
  const consent = caseOf("consented").profile.support_consent;
  const env = { [SUPPORT_KEY_ENV]: sa.agent_secret_hex.toUpperCase() };
  assert.equal(SUPPORT_KEY_ENV, "SALTIX_SUPPORT_KEY");
  assert.deepEqual(supportConsentFromEnvironment({ genesis: genesisHex, slug: consent.slug, owner: consent.owner }, env), consent);
  const refused = (e, o, re) => assert.throws(() => supportConsentFromEnvironment({ genesis: genesisHex, slug: consent.slug, owner: consent.owner, ...o }, e), re);
  refused({}, {}, /no SALTIX_SUPPORT_KEY/);
  refused({ [SUPPORT_KEY_ENV]: "12" }, {}, /not an Ed25519 secret/);
  refused(env, { slug: "Split" }, /the slug/);
  refused(env, { owner: "dsalt1q" }, /the owner/);
  refused(env, { genesis: "5a" }, /the genesis hash/);
  // The message names the variable, never its value.
  assert.throws(() => supportConsentFromEnvironment({ genesis: genesisHex, slug: consent.slug, owner: consent.owner }, { [SUPPORT_KEY_ENV]: `${sa.agent_secret_hex}0` }),
    (e) => /SALTIX_SUPPORT_KEY: not an Ed25519 secret/.test(e.message) && !e.message.includes(sa.agent_secret_hex));
  // The address the consent is for: the key's personal one.
  assert.equal(toHex(accountId(fromHex(consent.key, 32))), supportAddress(caseOf("consented").profile.support).account);
});
