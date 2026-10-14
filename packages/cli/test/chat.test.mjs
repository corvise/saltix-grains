// grain chat-spec and grain cert: a chat spec linted with its faults located, signed by the owner key into the
// document a grain serves, and the server key certified for at most 31 days.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import {
  fromHex, toHex, chatSpecFromJson, decodeSignedChatSpec, signedChatSpecProblem, chatCertHolds, decodeCert, CHAT_CERT_LIFE_MS,
} from "@saltix/grain-server";
import { lintChatSpec, signedChatDocument, issueCert, explainChatSpec } from "../dist/chat.js";
import { readKey } from "../dist/project.js";

const secret = fromHex("61".repeat(32), 32);
const owner = toHex(ed25519.getPublicKey(secret));
const json = () => ({
  slug: "dice", version: 1, intro: { en: "Rolls dice for you.", ru: "Бросает кости." }, keeps: 0, ai: false,
  commands: [
    { name: "roll", title: { en: "Roll" }, help: { en: "Roll some dice" }, params: [
      { name: "sides", title: { en: "Sides" }, kind: { choice: { options: [{ value: "d6", title: { en: "Six" } }, { value: "d20", title: { en: "Twenty" } }] } }, required: true },
      { name: "count", title: { en: "How many" }, kind: { number: { min: 1, max: 10 } } },
    ] },
  ],
});
const manifest = { slug: "dice", owner_key: { ed25519: owner } };

test("lint locates what is out of bounds and says what a wallet would miss", () => {
  assert.deepEqual(lintChatSpec(chatSpecFromJson(json()), manifest, owner), { errors: [], warnings: [] });
  const bad = json();
  bad.commands[0].params[0].kind.choice.options[0].value = "D6";
  assert.match(explainChatSpec(chatSpecFromJson(bad)), /^command roll, parameter sides: a choice's value/);
  const priced = json();
  priced.commands[0].price = 1;
  assert.match(lintChatSpec(chatSpecFromJson(priced)).errors[0], /^command roll: price: 0 in this version/);
  const noEn = json();
  noEn.intro = { ru: "Кости" };
  assert.match(lintChatSpec(chatSpecFromJson(noEn)).errors[0], /"en" among them/);
  assert.match(lintChatSpec(chatSpecFromJson(json()), { ...manifest, slug: "dice-2" }).errors[0], /manifest is dice-2's/);
  assert.match(lintChatSpec(chatSpecFromJson(json()), manifest, "22".repeat(32)).errors[0], /owner_key/);
  const terse = json();
  terse.intro = { en: "Dice." };
  delete terse.commands[0].help;
  assert.deepEqual(lintChatSpec(chatSpecFromJson(terse)).warnings, ["intro: no Russian text (wallets show the English one)", "command roll: no help"]);
});

test("the document is signed by the owner key, and a changed spec needs a higher version", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-spec-"));
  const out = join(dir, "chat.signed.json");
  const spec = chatSpecFromJson(json());
  const doc = signedChatDocument(spec, secret, null, out);
  assert.equal(doc.cert, undefined);
  assert.equal(signedChatSpecProblem(decodeSignedChatSpec(doc.spec), "dice", { ed25519: owner }), null);
  writeFileSync(out, JSON.stringify(doc));
  assert.deepEqual(signedChatDocument(spec, secret, null, out), doc, "the same spec again");
  const changed = chatSpecFromJson({ ...json(), keeps: 30 });
  assert.throws(() => signedChatDocument(changed, secret, null, out), /raise "version"/);
  assert.ok(signedChatDocument({ ...changed, version: 2 }, secret, null, out).spec);
  const { cert } = issueCert(secret, "dice", "33".repeat(32), 30);
  assert.equal(signedChatDocument(spec, secret, cert).cert, cert.hex);
  assert.throws(() => signedChatDocument(spec, secret, { ...cert, slug: "chess" }), /chess's/);
});

test("a certificate is the owner key's for the server key, 31 days at most for chats", () => {
  const now = 1_800_000_000_000;
  const server = "33".repeat(32);
  const { cert, warnings } = issueCert(secret, "dice", server, 30, now);
  assert.deepEqual(warnings, []);
  assert.deepEqual(decodeCert(cert.hex), { slug: "dice", key: server, expires_at: cert.expires_at, signature: cert.signature });
  const spec = chatSpecFromJson(json());
  assert.ok(chatCertHolds(cert, "dice", { ed25519: owner }, spec, now));
  const long = issueCert(secret, "dice", server, 90, now);
  assert.match(long.warnings[0], /31 days/);
  assert.ok(!chatCertHolds(long.cert, "dice", { ed25519: owner }, spec, now));
  assert.ok(long.cert.expires_at > now + CHAT_CERT_LIFE_MS);
  assert.throws(() => issueCert(secret, "dice", owner, 30), /owner key off servers/);
  assert.throws(() => issueCert(secret, "dice", "zz", 30), /64 hex/);
  assert.throws(() => issueCert(secret, "dice", server, 0), /positive/);
});

test("the commands make a server key, its certificate and the document to serve", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "grain-chat-")), "dice");
  const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const grain = (...args) => execFileSync("node", [main, ...args], { cwd: dir, stdio: "pipe" }).toString();
  execFileSync("node", [main, "init", dir, "--name", "Dice"], { stdio: "pipe" });
  writeFileSync(join(dir, "chat.json"), JSON.stringify(json()));
  grain("cert", "init");
  assert.equal(statSync(join(dir, "server.key")).mode & 0o777, 0o600, "owner-only");
  grain("cert", "--days", "30");
  const cert = JSON.parse(readFileSync(join(dir, "cert.json"), "utf8"));
  assert.equal(cert.key, toHex(ed25519.getPublicKey(readKey(join(dir, "server.key")))));
  grain("chat-spec", "--cert", "cert.json");
  const doc = JSON.parse(readFileSync(join(dir, "chat.signed.json"), "utf8"));
  const m = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
  const signed = decodeSignedChatSpec(doc.spec);
  assert.equal(signedChatSpecProblem(signed, m.slug, m.owner_key), null);
  assert.ok(chatCertHolds(decodeCert(doc.cert), m.slug, m.owner_key, signed.spec, Date.now()));
  // A spec with a fault is not signed, and the error names it.
  writeFileSync(join(dir, "chat.json"), JSON.stringify({ ...json(), version: 2, commands: [{ name: "Roll", title: { en: "Roll" } }] }));
  assert.throws(() => grain("chat-spec"), (e) => /command Roll: a name/.test(e.stderr.toString()));
  writeFileSync(join(dir, "chat.json"), JSON.stringify({ ...json(), keps: 3 }));
  assert.throws(() => grain("chat-spec"), (e) => /keps: not a field/.test(e.stderr.toString()));
});
