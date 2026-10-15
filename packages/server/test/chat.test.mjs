// Grain chats as vectors/grain-chats-v1.json has them (Saltix 22-grain-chats, 24-app-studio, 09-relay §10.5.2): every
// object the protocol's generator builds, built here and compared byte for byte — specs signed by the owner and by a
// registered server key, messages under a certificate and under a registered key, a member's proof, the numbers an app
// reports —; what the file says is refused, refused; and the reference's own negative cases.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  fromHex, toHex, accountId, encodeAddress, issueInvoiceKeyCert, encodeCert, decodeCert, signInvoice,
  encodeChatSpec, encodeSignedChatSpec, decodeSignedChatSpec, chatSpecToSign, signChatSpec, chatSpecProblem, signedChatSpecProblem,
  chatCertHolds, encodeChatRequest, encodeSignedChatRequest, decodeSignedChatRequest, chatRequestToSign, signChatRequest,
  chatRequestProblem, requestFitProblem, requestLive, encodeSignedChatMessage, decodeSignedChatMessage, chatMessageToSign,
  signChatMessage, chatMessageProblem, chatMessageBoundsProblem, encodeChatFrame, decodeChatFrame, chatDocumentOf,
  chatSpecFromJson, chatSpecToJson, takesValue, dayToIso, isoToDay,
  encodeFileRef, decodeFileRef, fileRefProblem, fileRefToJson, fileRefFromJson, sealFile, openFile, relayOfEndpoint, fileRefEndpoint,
  CHAT_CERT_LIFE_MS, MAX_MESSAGE_AGE_MS, MAX_REQUEST_LIFE_MS, MESSAGE_AHEAD_MS, MAX_FRAME_BYTES, MAX_FILE_BYTES, STATUS,
  signChatSpecAsServer, serverKeyHolds, decodeChatDocument, signMemberProof, memberProofToSign, encodeSignedMemberProof,
  decodeSignedMemberProof, admits, signGrainStats, grainStatsToSign, encodeSignedGrainStats, decodeSignedGrainStats, grainStatsProblem,
  STATS_MAX_AGE_MS, MEMBER_PROOF_LIFE_MS,
} from "../dist/index.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/grain-chats-v1.json", import.meta.url), "utf8"));
const chain = { genesis: v.chain.genesis_hash_hex, network: v.chain.network };
const NOW = Number(v.now_ms);
const DAY = 86_400_000;
const OWNER = fromHex(v.keys.owner_secret_hex, 32);
const SERVER = fromHex(v.keys.server_secret_hex, 32);
const USER = fromHex(v.keys.user_secret_hex, 32);
const MEMBER = fromHex(v.keys.member_secret_hex, 32);
const ownerKey = { ed25519: v.keys.owner_public_hex };
/** The server keys the registry names, as the file says. */
const servers = v.keys.registered_servers;
/** The private access grain, as the file says. */
const access = { owner: v.access.owner_hex, public: v.access.public, members: v.access.members };
const address = (secret) => encodeAddress("devnet", accountId(ed25519.getPublicKey(secret)));
const userAddress = address(USER);
const serverAddress = address(SERVER);
const hex = (bytes) => toHex(bytes);
const repeat = (byte, n) => byte.repeat(n);

// What the protocol's generator builds (crates/saltix-types/src/grain_chat_vectors.rs), in this SDK's form.
const en = (text) => ({ en: text });
const site = (value, title) => ({ value, title: en(title) });
function spec() {
  return {
    slug: "access",
    version: 3,
    intro: { en: "One-time access keys for the closed sites.", ru: "Одноразовые ключи доступа к закрытым сайтам." },
    commands: [
      {
        name: "key", title: { en: "New key", ru: "Новый ключ" }, help: en("A key that opens a site once"),
        params: [
          { name: "duration", title: en("Access for"), kind: { duration: { options: [600, 86_400, 2_592_000] } }, required: true },
          { name: "note", title: en("Note"), kind: { text: { max: 40 } }, required: false },
          { name: "site", title: en("Site"), kind: { choice: { options: [site("saltix-io", "saltix.io"), site("web", "Web")] } }, required: true },
        ],
        confirm: false, price: 0n,
      },
      {
        name: "revoke", title: en("Revoke a key"), help: {},
        params: [{ name: "id", title: en("Key"), kind: { text: { max: 16 } }, required: true }],
        confirm: true, price: 0n,
      },
      {
        name: "report", title: en("Daily report"), help: {},
        params: [
          { name: "day", title: en("Day"), kind: { date: {} }, required: false },
          { name: "errors_only", title: en("Errors only"), kind: { flag: {} }, required: false },
          { name: "top", title: en("Top"), kind: { number: { min: 1n, max: 100n, decimals: 0 } }, required: false },
        ],
        confirm: false, price: 0n,
      },
    ],
    revoked: [repeat("ee", 32)],
    keeps: 30,
    ai: false,
  };
}
const CERT_EXPIRES = NOW + 30 * DAY;
const cert = () => issueInvoiceKeyCert(OWNER, "access", toHex(ed25519.getPublicKey(SERVER)), CERT_EXPIRES);
const request = () => ({
  slug: "access", id: repeat("11", 16), at: NOW, expires_at: NOW + DAY, via: null, command: "key",
  args: [["duration", { duration: 86_400 }], ["note", { text: "for the tester" }], ["site", { choice: "saltix-io" }]],
  text: "", member: null, lang: "ru",
});
const PROOF_EXPIRES = NOW + 30 * DAY;
const memberProof = () => ({
  slug: "access", account: toHex(accountId(ed25519.getPublicKey(MEMBER))), grain_key: toHex(ed25519.getPublicKey(USER)), expires_at: PROOF_EXPIRES,
});
const stats = () => ({ slug: "access", at: NOW, users_1d: 7, users_30d: 23, requests_30d: 312 });
const reportFile = () => ({
  relay: `wss://85.192.42.65:30335/#${repeat("5d", 32)}`, id: "q3Vb1Hk9xQ2mN0pL7rT4sw", key: repeat("44", 32), iv: repeat("55", 12),
  hash: repeat("66", 32), size: 18_432, name: "digest-2027-01-15.csv", mime: "text/csv",
});
const answer = () => ({
  slug: "access", id: repeat("22", 16), at: NOW + 1_000, answers: repeat("11", 16), replaces: null,
  blocks: [
    { secret: { label: "Key", value: "7KQ2-M9XA-4F", expires_at: NOW + DAY } },
    { fields: { rows: [["Site", "saltix.io"], ["Access", "1 day after it is used"]] } },
    { status: { state: STATUS.done, text: "Opens the site once" } },
  ],
  actions: [
    { label: "Revoke", kind: { run: { command: "revoke", args: [["id", { text: "k-0042" }]] } } },
    { label: "All keys", kind: { open: { start: "keys" } } },
  ],
});
const report = () => ({
  slug: "access", id: repeat("33", 16), at: NOW + 2_000, answers: null, replaces: repeat("34", 16),
  blocks: [
    { text: { text: "Yesterday: 41 sessions, 3 errors.\nThe file has every event." } },
    { file: { file: reportFile(), title: "Daily digest", format: "csv" } },
    { status: { state: STATUS.working, text: "" } },
  ],
  actions: [{ label: "Thanks", kind: { reply: { text: "Thanks" } } }],
});
const textRequest = () => ({ ...request(), id: repeat("12", 16), command: "", args: [], text: "Привет", lang: "" });

test("the keys and addresses are the vectors'", () => {
  assert.equal(toHex(accountId(ed25519.getPublicKey(MEMBER))), v.keys.member_account_hex);
  assert.equal(toHex(accountId(ed25519.getPublicKey(OWNER))), v.access.owner_hex);
  assert.deepEqual(servers, [v.keys.server_public_hex]);
  assert.equal(toHex(ed25519.getPublicKey(OWNER)), v.keys.owner_public_hex);
  assert.equal(toHex(ed25519.getPublicKey(SERVER)), v.keys.server_public_hex);
  assert.equal(toHex(ed25519.getPublicKey(USER)), v.keys.user_public_hex);
  assert.equal(toHex(accountId(ed25519.getPublicKey(SERVER))), v.keys.server_address_hex);
  assert.equal(toHex(accountId(ed25519.getPublicKey(USER))), v.keys.user_address_hex);
});

test("the spec, its signature and the well-known document are the node's", () => {
  const signed = signChatSpec(spec(), OWNER);
  assert.equal(hex(chatSpecToSign(spec())), v.spec_doc.message_hex);
  assert.equal(hex(encodeSignedChatSpec(signed)), v.spec_doc.signed_hex);
  assert.equal(chatSpecProblem(spec()), null);
  assert.deepEqual(decodeSignedChatSpec(v.spec_doc.signed_hex), signed, "read back as built");
  assert.equal(signedChatSpecProblem(decodeSignedChatSpec(v.spec_doc.signed_hex), "access", ownerKey), null);
  assert.equal(encodeCert(cert()), v.cert.borsh_hex);
  assert.equal(cert().expires_at, Number(v.cert.expires_at_ms));
  assert.deepEqual(decodeCert(v.cert.borsh_hex), cert());
  const signedStats = signGrainStats(stats(), SERVER, chain.genesis);
  assert.deepEqual(chatDocumentOf(signed, cert(), signedStats), v.spec_doc.well_known);
  const read = decodeChatDocument(v.spec_doc.well_known);
  assert.deepEqual(read, { spec: signed, cert: cert(), stats: signedStats });
  assert.deepEqual(decodeChatDocument({ spec: v.spec_doc.well_known.spec, cert: null }), { spec: signed, cert: null, stats: null }, "cert and stats optional");
  assert.throws(() => decodeChatDocument({ cert: v.cert.borsh_hex }), /spec/);
  assert.throws(() => decodeChatDocument({ spec: v.spec_doc.well_known.spec, stats: 7 }), /stats/);

  // Signed by the registered server key: the same spec, the key named, its own signature.
  const byServer = signChatSpecAsServer(spec(), SERVER);
  assert.equal(byServer.server, v.keys.server_public_hex);
  assert.equal(hex(encodeSignedChatSpec(byServer)), v.server_spec.signed_hex);
  assert.deepEqual(decodeSignedChatSpec(v.server_spec.signed_hex), byServer);
  assert.equal(hex(encodeChatFrame({ spec: { spec: byServer, cert: null } })), v.server_spec.frame_hex);
  assert.equal(signedChatSpecProblem(byServer, "access", ownerKey, servers), null);
  // The JSON form a developer writes round-trips to the same bytes.
  const json = JSON.parse(JSON.stringify(chatSpecToJson(spec())));
  assert.equal(hex(encodeChatSpec(chatSpecFromJson(json))), hex(encodeChatSpec(spec())));
});

test("requests, answers, reports and frames are the node's", () => {
  const signed = signChatRequest(request(), USER, chain.genesis);
  assert.equal(hex(chatRequestToSign(request(), chain.genesis)), v.request.message_hex);
  assert.equal(hex(encodeSignedChatRequest(signed)), v.request.signed_hex);
  assert.equal(hex(encodeChatFrame({ request: signed })), v.request.frame_hex);
  assert.deepEqual(decodeSignedChatRequest(fromHex(v.request.signed_hex)), signed);

  const text = signChatRequest(textRequest(), USER, chain.genesis);
  assert.equal(hex(encodeSignedChatRequest(text)), v.text_request.signed_hex);
  assert.equal(hex(encodeChatFrame({ request: text })), v.text_request.frame_hex);

  const signedAnswer = signChatMessage(answer(), SERVER, chain.genesis, cert());
  assert.equal(hex(chatMessageToSign(answer(), chain.genesis)), v.answer.message_hex);
  assert.equal(hex(encodeSignedChatMessage(signedAnswer)), v.answer.signed_hex);
  assert.equal(hex(encodeChatFrame({ message: signedAnswer })), v.answer.frame_hex);
  assert.deepEqual(decodeSignedChatMessage(fromHex(v.answer.signed_hex)), signedAnswer);

  // The report is signed by the registered key: no certificate, the key itself.
  const signedReport = signChatMessage(report(), SERVER, chain.genesis);
  assert.deepEqual(signedReport.server, { registered: v.keys.server_public_hex });
  assert.equal(hex(encodeSignedChatMessage(signedReport)), v.report.signed_hex);
  assert.equal(hex(encodeChatFrame({ message: signedReport })), v.report.frame_hex);
  assert.deepEqual(decodeSignedChatMessage(fromHex(v.report.signed_hex)), signedReport);

  const specFrame = { spec: { spec: signChatSpec(spec(), OWNER), cert: cert() } };
  assert.equal(hex(encodeChatFrame(specFrame)), v.spec_frame_hex);

  // A member's proof, and the request that carries it.
  const proof = signMemberProof(memberProof(), MEMBER, chain.genesis);
  assert.equal(hex(memberProofToSign(memberProof(), chain.genesis)), v.member_proof.message_hex);
  assert.equal(hex(encodeSignedMemberProof(proof)), v.member_proof.signed_hex);
  assert.equal(proof.proof.expires_at, Number(v.member_proof.expires_at_ms));
  assert.deepEqual(decodeSignedMemberProof(fromHex(v.member_proof.signed_hex)), proof);
  const memberRequest = signChatRequest({ ...request(), id: repeat("13", 16), member: proof }, USER, chain.genesis);
  assert.equal(hex(encodeSignedChatRequest(memberRequest)), v.member_request.signed_hex);
  assert.equal(hex(encodeChatFrame({ request: memberRequest })), v.member_request.frame_hex);
  assert.deepEqual(decodeSignedChatRequest(fromHex(v.member_request.signed_hex)), memberRequest);

  // The numbers the app reports.
  const signedStats = signGrainStats(stats(), SERVER, chain.genesis);
  assert.equal(hex(grainStatsToSign(stats(), chain.genesis)), v.stats.message_hex);
  assert.equal(hex(encodeSignedGrainStats(signedStats)), v.stats.signed_hex);
  assert.equal(hex(encodeChatFrame({ stats: signedStats })), v.stats.frame_hex);
  assert.deepEqual(decodeSignedGrainStats(v.stats.signed_hex), signedStats);

  // Every frame reads back to the same bytes.
  const frames = [
    v.request.frame_hex, v.text_request.frame_hex, v.answer.frame_hex, v.report.frame_hex, v.spec_frame_hex, v.server_spec.frame_hex,
    v.member_request.frame_hex, v.stats.frame_hex,
  ];
  for (const frame of frames) assert.equal(hex(encodeChatFrame(decodeChatFrame(fromHex(frame)))), frame);
  assert.ok("request" in decodeChatFrame(fromHex(v.request.frame_hex)));
  assert.ok("message" in decodeChatFrame(fromHex(v.answer.frame_hex)));
  assert.ok("spec" in decodeChatFrame(fromHex(v.spec_frame_hex)));
  assert.equal(decodeChatFrame(fromHex(v.server_spec.frame_hex)).spec.cert, null, "a registered key's spec frame carries no certificate");
  assert.ok("stats" in decodeChatFrame(fromHex(v.stats.frame_hex)));
});

test("a client checks everything from the file alone", () => {
  const signedSpec = decodeSignedChatSpec(v.spec_doc.signed_hex);
  const s = signedSpec.spec;
  for (const name of ["request", "text_request"]) {
    const r = decodeSignedChatRequest(fromHex(v[name].signed_hex));
    assert.equal(chatRequestProblem(r, { chain, spec: s, from: userAddress, now: NOW }), null, name);
  }
  assert.equal(decodeSignedChatRequest(fromHex(v.request.signed_hex)).request.lang, "ru", "the user's language");
  assert.equal(decodeSignedChatRequest(fromHex(v.text_request.signed_hex)).request.lang, "", "an app that does not say");
  for (const name of ["answer", "report"]) {
    const m = decodeSignedChatMessage(fromHex(v[name].signed_hex));
    assert.equal(chatMessageProblem(m, { chain, ownerKey, servers, spec: s, from: serverAddress, now: NOW + 5_000 }), null, name);
  }
  assert.equal(signedChatSpecProblem(decodeSignedChatSpec(v.server_spec.signed_hex), "access", ownerKey, servers), null);
  const member = decodeSignedChatRequest(fromHex(v.member_request.signed_hex));
  assert.deepEqual(member.request.member, decodeSignedMemberProof(fromHex(v.member_proof.signed_hex)));
  assert.equal(chatRequestProblem(member, { chain, spec: s, from: userAddress, now: NOW }), null);
  const admitted = (r, a = access, now = NOW) => admits(a, { genesis: chain.genesis, slug: "access", requestKey: r.key, proof: r.request.member, controller: null, now });
  assert.equal(admitted(member), null);
  assert.equal(grainStatsProblem(decodeSignedGrainStats(v.stats.signed_hex), { genesis: chain.genesis, slug: "access", servers, now: NOW }), null);
});

test("the file reference is the node's, in Borsh and JSON", () => {
  assert.equal(hex(encodeFileRef(reportFile())), v.file_ref.borsh_hex);
  assert.deepEqual(decodeFileRef(fromHex(v.file_ref.borsh_hex)), reportFile());
  assert.deepEqual(fileRefToJson(reportFile()), v.file_ref.json);
  assert.deepEqual(fileRefFromJson(v.file_ref.json), reportFile());
  assert.equal(fileRefProblem(reportFile()), null);
  const own = { ...reportFile(), relay: null };
  assert.equal(fileRefToJson(own).relay, undefined, "the reader's own relay: no field");
  assert.deepEqual(fileRefFromJson(fileRefToJson(own)), own);
  assert.deepEqual(fileRefFromJson({ ...v.file_ref.json, relay: null }), own);
  assert.deepEqual(fileRefFromJson({ ...v.file_ref.json, hash: v.file_ref.json.hash.toUpperCase() }), reportFile(), "hex of either case");
});

test("what the file says is refused is refused", () => {
  const s = decodeSignedChatSpec(v.spec_doc.signed_hex).spec;
  const signed = decodeSignedChatRequest(fromHex(v.request.signed_hex));
  const base = signed.request;
  const resigned = (r) => signChatRequest(r, USER, chain.genesis);
  const check = (r, over = {}) => chatRequestProblem(r, { chain, spec: s, from: userAddress, now: NOW, ...over });
  const refused = new Map(v.refused.map((r) => [r.change, r]));
  assert.equal(v.refused.length, 17);

  // A request in a language no reader takes: built here byte for byte, and refused as it is read. With the code in
  // lower case the same bytes read, and the signature, made over "RU", then fails.
  const badLang = refused.get('lang = "RU", id = 14…14');
  const badSigned = signChatRequest({ ...base, id: repeat("14", 16), lang: "RU" }, USER, chain.genesis);
  assert.equal(hex(encodeChatFrame({ request: badSigned })), badLang.frame_hex, badLang.why);
  assert.throws(() => decodeChatFrame(fromHex(badLang.frame_hex)), /language/, badLang.why);
  const lowered = fromHex(badLang.frame_hex);
  const at = lowered.length - 64 - 32 - 2;
  assert.equal(new TextDecoder().decode(lowered.subarray(at, at + 2)), "RU", "lang is the request's last field");
  lowered.set(new TextEncoder().encode("ru"), at);
  assert.equal(check(decodeChatFrame(lowered).request), "signature");

  const short = structuredClone(base);
  short.args[0][1] = { duration: 3_600 };
  assert.equal(check(resigned(short)), "argument:duration", refused.get("args.duration = 3600").why);
  const missing = { ...base, args: base.args.filter(([name]) => name !== "site") };
  assert.equal(check(resigned(missing)), "argument:site", refused.get("args without site").why);
  const unsorted = { ...base, args: [...base.args].reverse() };
  assert.match(check(resigned(unsorted)), /^argument:/, refused.get("site before duration").why);
  assert.equal(check(signed, { from: serverAddress }), "sender", refused.get("from = the server's address").why);
  assert.equal(check(signed, { now: base.expires_at }), "time", refused.get("now = expires_at").why);

  const answerSigned = decodeSignedChatMessage(fromHex(v.answer.signed_hex));
  const answerCert = answerSigned.server.certified;
  const show = (m, over = {}) => chatMessageProblem(m, { chain, ownerKey, servers, spec: s, from: serverAddress, now: NOW, ...over });
  assert.equal(show(answerSigned, { spec: { ...s, revoked: [answerCert.key] } }), "cert", refused.get("spec.revoked += the server key").why);
  const longCert = issueInvoiceKeyCert(OWNER, "access", answerCert.key, NOW + CHAT_CERT_LIFE_MS + 1);
  assert.equal(show(signChatMessage(answerSigned.message, SERVER, chain.genesis, longCert)), "cert", refused.get("cert.expires_at = now + 31 days + 1 ms").why);
  const old = { ...answerSigned.message, at: NOW - MAX_MESSAGE_AGE_MS - 1 };
  assert.equal(show(signChatMessage(old, SERVER, chain.genesis, answerCert)), "time", refused.get("at = now - 30 days - 1 ms").why);
  const priced = structuredClone(s);
  priced.commands[0].price = 1n;
  assert.equal(chatSpecProblem(priced), "price", refused.get("commands.key.price = 1").why);
  // A server key signs no price, whatever this version's price rule says; the owner key's spec with a price is refused
  // by the rule itself.
  const pricedByServer = { spec: priced, server: v.keys.server_public_hex, signature: toHex(ed25519.sign(chatSpecToSign(priced), SERVER)) };
  assert.equal(signedChatSpecProblem(pricedByServer, "access", ownerKey, servers), "server_price", refused.get("server_spec with commands.key.price = 1").why);
  assert.throws(() => signChatSpecAsServer(priced, SERVER), /free/);
  assert.equal(signedChatSpecProblem(signChatSpecAsServer(s, SERVER), "access", ownerKey, []), "cert", "a key the registry does not name");
  assert.equal(signedChatSpecProblem(signChatSpecAsServer({ ...s, revoked: [v.keys.server_public_hex] }, SERVER), "access", ownerKey, servers), "cert", "a key the spec revokes");
  const reportSigned = decodeSignedChatMessage(fromHex(v.report.signed_hex));
  assert.equal(show(reportSigned, { servers: [] }), "cert", refused.get("registered_servers = []").why);
  assert.equal(show(reportSigned, { servers: ["77".repeat(32)] }), "cert", "another key is registered");
  assert.equal(show(reportSigned, { spec: { ...s, revoked: [v.keys.server_public_hex] } }), "cert", "a registered key the spec revokes");

  const member = decodeSignedChatRequest(fromHex(v.member_request.signed_hex));
  const proof = member.request.member.proof;
  const withProof = (p) => signChatRequest({ ...member.request, member: p === null ? null : signMemberProof(p, MEMBER, chain.genesis) }, USER, chain.genesis);
  const admitted = (r, a = access, now = NOW) => admits(a, { genesis: chain.genesis, slug: "access", requestKey: r.key, proof: r.request.member, controller: null, now });
  assert.equal(admitted(withProof(null)), "missing", refused.get("member = none").why);
  assert.equal(admitted(withProof({ ...proof, grain_key: v.keys.server_public_hex })), "mismatch", refused.get("member_proof.grain_key = the server's key").why);
  assert.equal(admitted(withProof({ ...proof, expires_at: NOW + 30 * DAY + 1 })), "expired", refused.get("member_proof.expires_at = now + 30 days + 1 ms").why);
  assert.equal(proof.expires_at, NOW + MEMBER_PROOF_LIFE_MS);
  assert.equal(admitted(member, { ...access, members: [] }), "not_member", refused.get("access.members = []").why);

  const signedStats = decodeSignedGrainStats(v.stats.signed_hex);
  const shown = (over = {}) => grainStatsProblem(signedStats, { genesis: chain.genesis, slug: "access", servers, now: NOW, ...over });
  assert.equal(shown({ now: NOW + STATS_MAX_AGE_MS + 1 }), "time", refused.get("now = at + 2 days + 1 ms").why);
  assert.equal(shown({ now: NOW + STATS_MAX_AGE_MS }), null, "2 days exactly");
});

// The reference's own unit tests (crates/saltix-types/src/grain/chat/tests.rs), the negative cases included.
function smallSpec() {
  return {
    slug: "access", version: 1, intro: en("Access keys for the closed sites."),
    commands: [
      {
        name: "key", title: en("New key"), help: en("A one-time key"),
        params: [
          { name: "duration", title: en("For"), kind: { duration: { options: [3_600, 86_400] } }, required: true },
          { name: "site", title: en("Site"), kind: { choice: { options: [site("saltix-io", "saltix.io")] } }, required: true },
          { name: "note", title: en("Note"), kind: { text: { max: 20 } }, required: false },
        ],
        confirm: false, price: 0n,
      },
      { name: "keys", title: en("My keys"), help: {}, params: [], confirm: false, price: 0n },
    ],
    revoked: [], keeps: 30, ai: false,
  };
}
const smallRequest = () => ({
  slug: "access", id: repeat("07", 16), at: NOW, expires_at: NOW + 60_000, via: null, command: "key",
  args: [["duration", { duration: 3_600 }], ["site", { choice: "saltix-io" }]], text: "", member: null, lang: "en",
});

test("a spec is signed by the owner key, and a spec out of bounds is refused", () => {
  const signed = signChatSpec(smallSpec(), OWNER);
  assert.equal(signedChatSpecProblem(signed, "access", ownerKey), null);
  assert.equal(signedChatSpecProblem(signed, "other", ownerKey), "slug");
  assert.equal(signedChatSpecProblem(signed, "access", { ed25519: v.keys.server_public_hex }), "signature", "a server key cannot sign the spec");
  const forged = structuredClone(signed);
  forged.spec.commands[0].confirm = true;
  assert.equal(signedChatSpecProblem(forged, "access", ownerKey), "signature");

  const refused = (change) => {
    const s = smallSpec();
    change(s);
    return chatSpecProblem(s);
  };
  assert.equal(refused((s) => (s.version = 0)), "version");
  assert.equal(refused((s) => (s.slug = "-x")), "slug");
  assert.equal(refused((s) => (s.intro = { ru: "Ключи" })), "bounds:languages");
  assert.equal(refused((s) => (s.intro = {})), "bounds:languages");
  assert.equal(refused((s) => (s.intro = { EN: "x", en: "x" })), "language");
  assert.equal(refused((s) => (s.intro = { en: "x".repeat(301) })), "bounds:text");
  assert.equal(refused((s) => (s.intro = { en: "a\nb" })), "bounds:text", "no line breaks in a title or intro");
  assert.equal(refused((s) => (s.commands[0].price = 1n)), "price");
  assert.equal(refused((s) => (s.commands[1].name = "key")), "name");
  assert.equal(refused((s) => (s.commands[0].name = "1key")), "name");
  assert.equal(refused((s) => (s.commands[0].name = "Key")), "name");
  assert.equal(refused((s) => (s.commands[0].params[1].name = "duration")), "name");
  assert.equal(refused((s) => (s.commands[0].params[0].kind = { duration: { options: [86_400, 3_600] } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].params[0].kind = { duration: { options: [0] } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].params[1].kind = { choice: { options: [] } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].params[1].kind = { choice: { options: [site("Saltix", "x")] } })), "bounds:choice");
  assert.equal(refused((s) => (s.commands[0].params[2].kind = { text: { max: 2_001 } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].params[2].kind = { number: { min: 2n, max: 1n, decimals: 0 } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].params[2].kind = { number: { min: 1n, max: 2n, decimals: 10 } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].params[2].kind = { file: { max: MAX_FILE_BYTES + 1, mimes: [] } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].params[2].kind = { file: { max: 10, mimes: ["csv"] } })), "bounds:parameter kind");
  assert.equal(refused((s) => (s.commands[0].title = en("x".repeat(33)))), "bounds:text");
  assert.equal(refused((s) => (s.commands = Array.from({ length: 33 }, (_, i) => ({ ...s.commands[1], name: `c${i}` })))), "name");
  assert.equal(refused((s) => (s.revoked = Array(17).fill(repeat("01", 32)))), "bounds:revoked");
  assert.equal(refused((s) => (s.commands[0].help = { en: "x".repeat(120) })), null, "120 characters of help");
  assert.equal(refused((s) => (s.commands[0].title = en("\u{1F600}".repeat(32)))), null, "characters, not bytes");
});

test("a request fits its command", () => {
  const s = smallSpec();
  assert.equal(requestFitProblem(smallRequest(), s), null);
  const withNote = { ...smallRequest(), args: [["duration", { duration: 86_400 }], ["note", { text: "for Ann" }], ["site", { choice: "saltix-io" }]] };
  assert.equal(requestFitProblem(withNote, s), null, "an optional argument");
  assert.equal(requestFitProblem({ ...smallRequest(), command: "", args: [], text: "hello" }, s), null, "text alone");
  const refused = (change) => {
    const r = smallRequest();
    change(r);
    return requestFitProblem(r, s);
  };
  assert.equal(refused((r) => (r.command = "delete")), "unknown_command");
  assert.equal(refused((r) => (r.slug = "other")), "slug");
  assert.equal(refused((r) => r.args.splice(1, 1)), "argument:site", "a required argument is missing");
  assert.equal(refused((r) => r.args.push(["zz", { flag: true }])), "argument:zz", "an argument the command does not have");
  assert.equal(refused((r) => (r.args[0][1] = { duration: 60 })), "argument:duration", "a duration not offered");
  assert.equal(refused((r) => (r.args[1][1] = { choice: "web" })), "argument:site", "a choice not offered");
  assert.equal(refused((r) => (r.args[1][1] = { text: "saltix-io" })), "argument:site", "a value of another kind");
  assert.equal(refused((r) => r.args.reverse()), "argument:site", "arguments out of order");
  assert.equal(refused((r) => r.args.push(["note", { text: "x".repeat(21) }])), "argument:duration", "out of order after a push");
  assert.equal(refused((r) => (r.args = [r.args[0], ["note", { text: "x".repeat(21) }], r.args[1]])), "argument:note", "too long");
  assert.equal(refused((r) => (r.args = [r.args[0], r.args[0], r.args[1]])), "argument:duration", "an argument twice");
  assert.equal(refused((r) => { r.command = ""; r.text = "hi"; }), "bounds:text", "text alone carries no arguments");
  assert.equal(refused((r) => { r.command = ""; r.args = []; }), "bounds:text", "text alone is not empty");
  assert.equal(refused((r) => { r.command = ""; r.args = []; r.text = "x".repeat(2_001); }), "bounds:text");
  assert.equal(refused((r) => { r.command = ""; r.args = []; r.text = "a\nb"; }), null, "line breaks in text");
  assert.equal(refused((r) => { r.command = ""; r.args = []; r.text = "a\u0000b"; }), "bounds:text", "no other control characters");
});

test("a request names the user's language or none", () => {
  const s = smallSpec();
  for (const lang of ["", "en", "ru", "pt-br", "zh-hant", "--"]) {
    const r = { ...smallRequest(), lang };
    assert.equal(requestFitProblem(r, s), null, lang);
    const signed = signChatRequest(r, USER, chain.genesis);
    assert.equal(chatRequestProblem(signed, { chain, spec: s, from: userAddress, now: NOW }), null, lang);
    assert.deepEqual(decodeChatFrame(encodeChatFrame({ request: signed })), { request: signed }, lang);
  }
  for (const lang of ["RU", "En", "x", "abcdefghi", "r_u", "r1", "ру", " en", "en\n"]) {
    const r = { ...smallRequest(), lang };
    assert.equal(requestFitProblem(r, s), "language", JSON.stringify(lang));
    // Signed, it is still refused: by the server's check...
    const signed = signChatRequest(r, USER, chain.genesis);
    assert.equal(chatRequestProblem(signed, { chain, spec: s, from: userAddress, now: NOW }), "language", JSON.stringify(lang));
    // ...and by every reader, as bytes that are not canonical are.
    assert.throws(() => decodeChatFrame(encodeChatFrame({ request: signed })), /language/, JSON.stringify(lang));
    assert.throws(() => decodeSignedChatRequest(encodeSignedChatRequest(signed)), /language/, JSON.stringify(lang));
  }
  assert.equal(requestFitProblem({ ...smallRequest(), lang: undefined }, s), "language", "a client that forgot it");
  // The last field, signed: a u32 length and the code's bytes, after `member`.
  const ru = encodeChatRequest({ ...smallRequest(), lang: "ru" });
  const none = encodeChatRequest({ ...smallRequest(), lang: "" });
  assert.deepEqual([...none.subarray(none.length - 4)], [0, 0, 0, 0]);
  assert.deepEqual([...ru], [...none.subarray(0, none.length - 4), 2, 0, 0, 0, 0x72, 0x75]);
  const forged = signChatRequest({ ...smallRequest(), lang: "ru" }, USER, chain.genesis);
  forged.request = { ...forged.request, lang: "en" };
  assert.equal(chatRequestProblem(forged, { chain, spec: s, from: userAddress, now: NOW }), "signature", "the language is signed");
});

test("every kind takes its own values within bounds", () => {
  const file = { max: 1_000, mimes: ["text/csv"] };
  const ref = { ...reportFile(), size: 1_000 };
  assert.ok(takesValue({ file }, { file: ref }));
  assert.ok(!takesValue({ file }, { file: { ...ref, size: 1_001 } }), "over the parameter's max");
  assert.ok(!takesValue({ file }, { file: { ...ref, mime: "text/plain" } }), "a media type not named");
  assert.ok(takesValue({ file: { max: 1_000, mimes: [] } }, { file: { ...ref, mime: "text/plain" } }), "none named: any");
  assert.ok(!takesValue({ file }, { file: { ...ref, id: "short" } }), "a reference out of bounds");
  const number = { number: { min: -5n, max: 9_000_000_000_000_000_000n, decimals: 9 } };
  assert.ok(takesValue(number, { number: -5n }) && takesValue(number, { number: 9_000_000_000_000_000_000n }));
  assert.ok(!takesValue(number, { number: -6n }));
  assert.ok(takesValue({ date: {} }, { date: 20_000 }) && takesValue({ flag: {} }, { flag: false }));
  assert.ok(!takesValue({ date: {} }, { flag: true }) && !takesValue({ flag: {} }, { date: 1 }));
  assert.ok(takesValue({ text: { max: 3 } }, { text: "\u{1F600}\u{1F600}\u{1F600}" }), "characters, not bytes");
  assert.ok(!takesValue({ text: { max: 3 } }, { text: "" }), "at least one character");
  assert.equal(dayToIso(20_468), "2026-01-15");
  assert.equal(isoToDay("2026-01-15"), 20_468);
  assert.equal(isoToDay("2026-02-30"), null);
  assert.equal(isoToDay("15.01.2026"), null);
});

test("a server takes a request from its signer while it lives", () => {
  const s = smallSpec();
  const signed = signChatRequest(smallRequest(), USER, chain.genesis);
  const check = (r, over = {}) => chatRequestProblem(r, { chain, spec: s, from: userAddress, now: NOW, ...over });
  assert.equal(check(signed), null);
  assert.equal(check(signed, { from: serverAddress }), "sender", "another address relayed it");
  assert.equal(check(signed, { from: encodeAddress("testnet", accountId(ed25519.getPublicKey(USER))) }), "sender", "another network's address");
  assert.equal(check(signed, { from: encodeAddress("devnet", accountId(ed25519.getPublicKey(USER), 5)) }), "sender", "not the personal kind");
  assert.equal(check(signed, { from: "not an address" }), "sender");
  const forged = structuredClone(signed);
  forged.request.args[0][1] = { duration: 86_400 };
  assert.equal(check(forged), "signature");
  assert.equal(check(signed, { chain: { ...chain, genesis: repeat("6d", 32) } }), "signature", "a request of another network");
  assert.equal(check({ ...signed, signature: "00".repeat(64) }), "signature");
  assert.equal(check(signed, { now: NOW + 60_000 }), "time", "expired");
  assert.equal(check(signed, { now: NOW + 59_999 }), null, "a millisecond before it expires");
  const long = signChatRequest({ ...smallRequest(), expires_at: NOW + MAX_REQUEST_LIFE_MS + 1 }, USER, chain.genesis);
  assert.equal(check(long), "time", "longer than 7 days");
  const week = signChatRequest({ ...smallRequest(), expires_at: NOW + MAX_REQUEST_LIFE_MS }, USER, chain.genesis);
  assert.equal(check(week), null, "7 days exactly");
  const ahead = signChatRequest({ ...smallRequest(), at: NOW + MESSAGE_AHEAD_MS + 1, expires_at: NOW + 3_600_000 }, USER, chain.genesis);
  assert.equal(check(ahead), "time", "dated ahead");
  const backwards = signChatRequest({ ...smallRequest(), expires_at: NOW }, USER, chain.genesis);
  assert.equal(check(backwards, { now: NOW - 1 }), "time", "expires before it is made");
  assert.ok(requestLive(smallRequest(), NOW) && !requestLive(smallRequest(), NOW + 60_000));
  const unknown = signChatRequest({ ...smallRequest(), command: "delete" }, USER, chain.genesis);
  assert.equal(check(unknown), "unknown_command", "signed and live, but not the spec's");
});

function smallMessage() {
  return {
    slug: "access", id: repeat("08", 16), at: NOW, answers: repeat("07", 16), replaces: null,
    blocks: [
      { secret: { label: "Key", value: "ABCDE12345", expires_at: NOW + 3_600_000 } },
      { status: { state: STATUS.done, text: "Good for an hour" } },
    ],
    actions: [{ label: "Revoke", kind: { run: { command: "revoke", args: [["id", { text: "k1" }]] } } }],
  };
}

test("a spec signed by a registered key is free, and checked against the keys the registry names", () => {
  const s = smallSpec();
  const other = toHex(ed25519.getPublicKey(fromHex("40".repeat(32), 32)));
  const registered = [other, v.keys.server_public_hex];
  const signed = signChatSpecAsServer(s, SERVER);
  assert.equal(signedChatSpecProblem(signed, "access", ownerKey, registered), null);
  assert.equal(signedChatSpecProblem(signed, "access", ownerKey, [other]), "cert", "a key the registry does not name, or no longer");
  assert.equal(signedChatSpecProblem(signed, "access", ownerKey), "cert", "no keys named at all");
  assert.equal(signedChatSpecProblem(signChatSpecAsServer({ ...s, revoked: [v.keys.server_public_hex] }, SERVER), "access", ownerKey, registered), "cert", "a key its own spec revokes");
  const priced = structuredClone(s);
  priced.commands[1].price = 1n;
  const pricedByServer = { spec: priced, server: v.keys.server_public_hex, signature: toHex(ed25519.sign(chatSpecToSign(priced), SERVER)) };
  assert.equal(signedChatSpecProblem(pricedByServer, "access", ownerKey, registered), "server_price", "a price needs the owner key");
  const pricedByOwner = { spec: priced, server: null, signature: toHex(ed25519.sign(chatSpecToSign(priced), OWNER)) };
  assert.equal(signedChatSpecProblem(pricedByOwner, "access", ownerKey, registered), "price", "the owner's priced spec waits for paid actions");
  assert.equal(signedChatSpecProblem({ ...signed, server: other }, "access", ownerKey, registered), "signature", "named as another registered key");
  assert.equal(signedChatSpecProblem({ ...signed, server: null }, "access", ownerKey, registered), "signature", "a server key's signature is not the owner's");
  assert.equal(signedChatSpecProblem({ ...signed, spec: { ...s, slug: "other" } }, "access", ownerKey, registered), "slug");
});

test("a wallet shows a message signed by a registered key while the registry names it", () => {
  const s = smallSpec();
  const other = toHex(ed25519.getPublicKey(fromHex("40".repeat(32), 32)));
  const registered = [other, v.keys.server_public_hex];
  const signed = signChatMessage(smallMessage(), SERVER, chain.genesis);
  assert.deepEqual(signed.server, { registered: v.keys.server_public_hex });
  const show = (m, over = {}) => chatMessageProblem(m, { chain, ownerKey, servers: registered, spec: s, from: serverAddress, now: NOW, ...over });
  assert.equal(show(signed), null);
  assert.equal(show(signed, { servers: [other] }), "cert", "the owner removed the key: refused from that block on");
  assert.equal(show(signed, { servers: [] }), "cert", "revoked: no key at all");
  assert.equal(show(signed, { servers: undefined }), "cert", "a wallet that knows no registered key");
  assert.equal(show(signed, { from: userAddress }), "sender");
  assert.equal(show(signed, { spec: { ...s, revoked: [v.keys.server_public_hex] } }), "cert", "the spec revoked the key");
  const forged = structuredClone(signed);
  forged.message.blocks.pop();
  assert.equal(show(forged), "signature");
  const strangerSecret = fromHex("41".repeat(32), 32);
  const stranger = signChatMessage(smallMessage(), strangerSecret, chain.genesis);
  assert.equal(show(stranger, { from: address(strangerSecret) }), "cert", "a key nobody registered");
  assert.ok(serverKeyHolds(signed.server, "access", ownerKey, registered, s, NOW));
  assert.ok(!serverKeyHolds(signed.server, "access", ownerKey, [other], s, NOW));
  // A certificate still works beside registered keys.
  const day = issueInvoiceKeyCert(OWNER, "access", v.keys.server_public_hex, NOW + DAY);
  assert.equal(show(signChatMessage(smallMessage(), SERVER, chain.genesis, day), { servers: [] }), null);
});

test("a wallet shows a message signed by a certified key", () => {
  const s = smallSpec();
  const day = issueInvoiceKeyCert(OWNER, "access", v.keys.server_public_hex, NOW + DAY);
  const signed = signChatMessage(smallMessage(), SERVER, chain.genesis, day);
  const show = (m, over = {}) => chatMessageProblem(m, { chain, ownerKey, spec: s, from: serverAddress, now: NOW, ...over });
  assert.equal(show(signed), null);
  assert.equal(show(signed, { from: userAddress }), "sender");
  const forged = structuredClone(signed);
  forged.message.blocks.pop();
  assert.equal(show(forged), "signature");
  assert.equal(show(signed, { chain: { ...chain, genesis: repeat("6d", 32) } }), "signature");
  assert.equal(show(signed, { spec: { ...s, slug: "other" } }), "slug");
  assert.equal(show(signed, { now: NOW + DAY }), "cert", "an expired certificate");
  assert.equal(show(signed, { ownerKey: { ed25519: v.keys.user_public_hex } }), "cert", "not the owner's certificate");
  const otherSlug = issueInvoiceKeyCert(OWNER, "other", v.keys.server_public_hex, NOW + DAY);
  assert.equal(show(signChatMessage(smallMessage(), SERVER, chain.genesis, otherSlug)), "cert", "another grain's certificate");
  const ahead = signChatMessage({ ...smallMessage(), at: NOW + MESSAGE_AHEAD_MS + 1 }, SERVER, chain.genesis, day);
  assert.equal(show(ahead), "time", "dated ahead");
  const edge = signChatMessage({ ...smallMessage(), at: NOW + MESSAGE_AHEAD_MS }, SERVER, chain.genesis, day);
  assert.equal(show(edge), null, "5 minutes ahead exactly");
  assert.ok(chatCertHolds(day, "access", ownerKey, s, NOW));
  assert.ok(!chatCertHolds(day, "access", ownerKey, s, NOW + DAY), "expires at its time");
  const month = issueInvoiceKeyCert(OWNER, "access", v.keys.server_public_hex, NOW + CHAT_CERT_LIFE_MS);
  assert.ok(chatCertHolds(month, "access", ownerKey, s, NOW), "31 days exactly");
  assert.throws(() => signChatMessage(smallMessage(), USER, chain.genesis, day), /server key/, "signs only with the certified key");
});

test("a message out of bounds is refused", () => {
  const refused = (change) => {
    const m = smallMessage();
    change(m);
    return chatMessageBoundsProblem(m);
  };
  const ref = reportFile();
  const invoice = (slug) => signInvoice({ slug, to: repeat("aa", 32), asset: "SALT", amount: 1n, memo: "", reference: repeat("01", 16), expires_at: NOW + DAY }, SERVER, chain.genesis, cert());
  assert.equal(refused(() => {}), null);
  assert.equal(refused((m) => (m.slug = "A")), "slug");
  assert.equal(refused((m) => (m.blocks = [])), "bounds:blocks and actions");
  assert.equal(refused((m) => (m.blocks = Array(17).fill(m.blocks[1]))), "bounds:blocks and actions");
  assert.equal(refused((m) => (m.actions = Array(9).fill(m.actions[0]))), "bounds:blocks and actions");
  assert.equal(refused((m) => m.blocks.push({ text: { text: "" } })), "bounds:block");
  assert.equal(refused((m) => m.blocks.push({ text: { text: "x".repeat(4_001) } })), "bounds:block");
  assert.equal(refused((m) => m.blocks.push({ text: { text: "lines\nkept\r\n" } })), null);
  assert.equal(refused((m) => m.blocks.push({ fields: { rows: [] } })), "bounds:block");
  assert.equal(refused((m) => m.blocks.push({ fields: { rows: [["", "x"]] } })), "bounds:block", "a label is 1 to 40 characters");
  assert.equal(refused((m) => m.blocks.push({ fields: { rows: [["a", "x".repeat(201)]] } })), "bounds:block");
  assert.equal(refused((m) => m.blocks.push({ secret: { label: "", value: "", expires_at: 0 } })), "bounds:block");
  assert.equal(refused((m) => m.blocks.push({ secret: { label: "", value: "x", expires_at: 0 } })), null, "no label, never expires");
  assert.equal(refused((m) => m.blocks.push({ file: { file: ref, title: "", format: "csv" } })), null);
  assert.equal(refused((m) => m.blocks.push({ file: { file: ref, title: "", format: "CSV" } })), "bounds:block");
  assert.equal(refused((m) => m.blocks.push({ file: { file: { ...ref, size: 0 }, title: "", format: "csv" } })), "bounds:block");
  assert.equal(refused((m) => m.blocks.push({ invoice: { invoice: invoice("access") } })), null);
  assert.equal(refused((m) => m.blocks.push({ invoice: { invoice: invoice("other") } })), "bounds:block", "another grain's invoice");
  assert.equal(refused((m) => m.blocks.push({ status: { state: 4, text: "" } })), "bounds:block");
  assert.equal(refused((m) => m.actions.push({ label: "", kind: { reply: { text: "x" } } })), "bounds:action");
  assert.equal(refused((m) => m.actions.push({ label: "x", kind: { reply: { text: "x".repeat(201) } } })), "bounds:action");
  assert.equal(refused((m) => m.actions.push({ label: "x", kind: { open: { start: "a b" } } })), "bounds:action");
  assert.equal(refused((m) => m.actions.push({ label: "x", kind: { run: { command: "Key", args: [] } } })), "bounds:action");
  assert.equal(refused((m) => m.actions.push({ label: "x", kind: { run: { command: "key", args: [["b", { flag: true }], ["a", { flag: true }]] } } })), "bounds:action");
  assert.throws(() => signChatMessage({ ...smallMessage(), blocks: [] }, SERVER, chain.genesis, cert()), /blocks and actions/);
  // An invoice block reads back as the bytes it was given.
  const withInvoice = { ...smallMessage(), blocks: [{ invoice: { invoice: invoice("access") } }] };
  const signed = signChatMessage(withInvoice, SERVER, chain.genesis, cert());
  assert.deepEqual(decodeSignedChatMessage(encodeSignedChatMessage(signed)), signed);
});

test("frames: the magic, the size, and nothing but a frame", () => {
  const frame = fromHex(v.request.frame_hex);
  assert.throws(() => decodeChatFrame(frame.subarray(4)), /grain-chat frame/, "no magic");
  const other = frame.slice();
  other[3] = 0x32;
  assert.throws(() => decodeChatFrame(other), /grain-chat frame/, "SGC2");
  const tag = frame.slice();
  tag[4] = 4;
  assert.throws(() => decodeChatFrame(tag), /grain-chat frame/, "no such frame");
  assert.throws(() => decodeChatFrame(Uint8Array.of(...frame, 0)), /left over/);
  assert.throws(() => decodeChatFrame(frame.subarray(0, frame.length - 1)), /short/);
  const big = new Uint8Array(MAX_FRAME_BYTES + 1);
  big.set(frame);
  assert.throws(() => decodeChatFrame(big), /grain-chat frame/, "over 48 000 bytes");
  // Strictly canonical: an option's tag, a bool, a texts map out of order.
  const via = frame.slice();
  via[4 + 1 + 4 + 6 + 16 + 16] = 2;
  assert.throws(() => decodeChatFrame(via), /option/);
  const specBytes = fromHex(v.spec_doc.signed_hex);
  const intro = new TextEncoder().encode("ru");
  const at = specBytes.findIndex((_, i) => intro.every((b, j) => specBytes[i + j] === b) && specBytes[i - 4] === 2);
  const swapped = specBytes.slice();
  swapped.set(new TextEncoder().encode("aa"), at);
  assert.throws(() => decodeSignedChatSpec(swapped), /sorted/, "a language before \"en\" written after it");
});

test("the JSON form refuses typos and states what the wallet shows", () => {
  const json = chatSpecToJson(spec());
  assert.throws(() => chatSpecFromJson({ ...json, keeps: undefined }), /keeps: missing/);
  assert.throws(() => chatSpecFromJson({ ...json, ai: undefined }), /ai: missing/);
  assert.throws(() => chatSpecFromJson({ ...json, comands: [] }), /comands: not a field/);
  const typo = structuredClone(json);
  typo.commands[0].params[0].requird = true;
  assert.throws(() => chatSpecFromJson(typo), /requird: not a field/);
  const kind = structuredClone(json);
  kind.commands[0].params[0].kind = { durations: { options: [1] } };
  assert.throws(() => chatSpecFromJson(kind), /one of text/);
  const short = { slug: "a-b-c", version: 1, intro: { en: "Hi" }, commands: [{ name: "go", title: { en: "Go" }, params: [{ name: "when", title: { en: "When" }, kind: "date" }] }], keeps: 0, ai: true };
  const read = chatSpecFromJson(short);
  assert.deepEqual(read.commands[0], { name: "go", title: { en: "Go" }, help: {}, params: [{ name: "when", title: { en: "When" }, kind: { date: {} }, required: false }], confirm: false, price: 0n });
  assert.equal(chatSpecProblem(read), null);
});

test("files seal and open under their reference, and a reference names its relay", async () => {
  const plain = new TextEncoder().encode("day,sessions\n2027-01-15,41\n");
  const sealed = await sealFile(plain);
  assert.equal(sealed.ciphertext.length, plain.length + 16);
  const ref = { relay: null, id: "A".repeat(22), key: sealed.key, iv: sealed.iv, hash: sealed.hash, size: sealed.size, name: "r.csv", mime: "text/csv" };
  assert.deepEqual(await openFile(sealed.ciphertext, ref), plain);
  const flipped = sealed.ciphertext.slice();
  flipped[0] ^= 1;
  await assert.rejects(openFile(flipped, ref), /does not open/);
  await assert.rejects(openFile(sealed.ciphertext, { ...ref, hash: repeat("00", 32) }), /hash/);
  await assert.rejects(openFile(sealed.ciphertext.subarray(1), ref), /size/);
  await assert.rejects(sealFile(new Uint8Array(0)), /1 byte/);
  assert.notEqual((await sealFile(plain)).key, sealed.key, "a fresh key per file");

  const pin = repeat("ab", 32);
  assert.equal(relayOfEndpoint({ url: "wss://85.192.42.65:30335/", cert_sha256: pin.toUpperCase() }), `wss://85.192.42.65:30335/#${pin}`);
  assert.equal(relayOfEndpoint({ url: "wss://relay.example/", cert_sha256: null }), "wss://relay.example/");
  assert.equal(relayOfEndpoint({ url: "ws://127.0.0.1:8090/relay", cert_sha256: null }), null, "a developer's relay: the reader's own");
  assert.deepEqual(fileRefEndpoint(reportFile()), { url: "wss://85.192.42.65:30335/", cert_sha256: repeat("5d", 32) });
});

test("a file reference out of bounds is refused", () => {
  const refused = (change) => {
    const f = reportFile();
    change(f);
    return fileRefProblem(f);
  };
  assert.equal(refused((f) => (f.relay = "https://x")), "relay");
  assert.equal(refused((f) => (f.relay = "wss://x#AB")), "relay");
  assert.equal(refused((f) => (f.relay = `wss://x#${repeat("AB", 32)}`)), "relay", "a pin in lowercase hex");
  assert.equal(refused((f) => (f.relay = "wss://")), "relay");
  assert.equal(refused((f) => (f.relay = "wss://a b")), "relay");
  assert.equal(refused((f) => (f.relay = "wss://a b")), "relay", "Unicode whitespace");
  assert.equal(refused((f) => (f.relay = "wss://" + "a".repeat(507))), "relay");
  assert.equal(refused((f) => (f.relay = "wss://" + "a".repeat(506))), null, "512 bytes");
  assert.equal(refused((f) => (f.id = "short")), "id");
  assert.equal(refused((f) => (f.id = "AAAAAAAAAAAAAAAAAAAAA=")), "id");
  assert.equal(refused((f) => (f.size = 0)), "size");
  assert.equal(refused((f) => (f.size = MAX_FILE_BYTES + 1)), "size");
  assert.equal(refused((f) => (f.size = MAX_FILE_BYTES)), null);
  assert.equal(refused((f) => (f.name = "a/b")), "name");
  assert.equal(refused((f) => (f.name = "a\\b")), "name");
  assert.equal(refused((f) => (f.name = "")), "name");
  assert.equal(refused((f) => (f.name = "a\nb")), "name");
  assert.equal(refused((f) => (f.name = "я".repeat(128))), "name", "255 bytes, not characters");
  assert.equal(refused((f) => (f.mime = "csv")), "mime");
  assert.equal(refused((f) => (f.mime = "text/ csv")), "mime");
  assert.equal(refused((f) => (f.mime = "text/")), "mime");
  assert.equal(refused((f) => (f.mime = "text/csv/x")), "mime");
  assert.equal(refused((f) => (f.mime = "application/vnd.ms-excel+x^y")), null);
  const json = v.file_ref.json;
  assert.throws(() => fileRefFromJson({ ...json, cmd: "msg" }), /cmd/);
  assert.throws(() => fileRefFromJson({ ...json, key: "REREREREREREREREREREREREREREREREREREREREREQ" }), /key/, "standard base64 with its padding");
  assert.throws(() => fileRefFromJson({ ...json, key: "REREREREREREREREREREREREREREREREREREREREREREREREQ==" }), /key/, "32 bytes");
  assert.throws(() => fileRefFromJson({ ...json, key: json.key.slice(0, -2) + "R=" }), /key/, "canonical base64 only: no stray bits");
  assert.throws(() => fileRefFromJson({ ...json, size: -1 }), /size/);
  assert.throws(() => fileRefFromJson({ ...json, relay: 7 }), /relay/);
  assert.throws(() => fileRefFromJson({ ...json, name: "a/b" }), /name/);
  assert.throws(() => fileRefFromJson([]), /object/);
});
