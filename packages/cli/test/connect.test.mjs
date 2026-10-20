// The Connect profile from the command line (Saltix 19-connect §11, 12-grains §10): connect.json in every project
// `grain init` makes, `grain lint`'s rules for it, the icon and permissions nothing uses, `grain profile` (the owner's
// QR code, or a key file and SetGrainProfile), `grain show`, and a website's profile from `grain connect-profile`.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import {
  accountId, derive, checkGrainProfile, checkSiteProfile, decodeSignedProfile, fromHex, iconHash, profileProblem, readProfileLink, signProfile,
  signedProfileFromJson, toHex, profileToJson,
} from "@saltix/grain-server";
import { CONNECT_FILE, TEMPLATE_RULE, lintConnect, lintIcon, lintPermissionsUse, placeholderLink, pngSize, profileOfProject, templateTexts } from "../dist/connect.js";
import { connectJson, connectTexts } from "../dist/template.js";
import { servedSiteRevision, siteProfile } from "../dist/profile.js";
import { scratch } from "../../../scripts/scratch.mjs";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const grain = (args, cwd) => spawnSync("node", [main, ...args], { cwd, encoding: "utf8", timeout: 20_000 });
const secret = fromHex("61".repeat(32), 32);
const ownerId = toHex(accountId(ed25519.getPublicKey(secret)));
const GENESIS = "5a".repeat(32);

/** A new project of `grain init`, page or chat-only. */
function project(chat = false, slug = "dice") {
  const dir = join(scratch("grain-connect-"), slug);
  const made = grain(["init", dir, "--slug", slug, "--name", "Dice roll", ...(chat ? ["--chat"] : [])], tmpdir());
  assert.equal(made.status, 0, made.stderr);
  return dir;
}
/** The app's own words in its project's connect.json, as a developer writes them over grain init's. */
const OWN = {
  en: { tagline: "Roll dice for board games", about: "Pick how many dice, tap Roll, and see the sum.", highlights: ["Up to 10 dice", "Works offline"], privacy: "Keeps your last roll on your phones, in your Saltix vault." },
  ru: { tagline: "Кубики для настольных игр", about: "Выберите число кубиков, нажмите Roll и увидите сумму.", highlights: ["До 10 кубиков", "Работает без сети"], privacy: "Хранит последний бросок в вашем хранилище Saltix." },
};
const written = (dir) => writeFileSync(join(dir, CONNECT_FILE), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, CONNECT_FILE), "utf8")), texts: OWN }));
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
const connectOf = (dir) => JSON.parse(readFileSync(join(dir, CONNECT_FILE), "utf8"));
const writeConnect = (dir, value) => writeFileSync(join(dir, CONNECT_FILE), JSON.stringify(value));
const change = (dir, f) => {
  const c = connectOf(dir);
  f(c);
  writeConnect(dir, c);
  return lintConnect(dir, manifestOf(dir));
};

test("every project grain init makes ships a Connect profile in English and Russian that lint passes", () => {
  for (const chat of [false, true]) {
    const dir = project(chat);
    const c = connectOf(dir);
    assert.deepEqual(c.subject, { grain: { slug: "dice" } });
    assert.deepEqual(Object.keys(c.texts).sort(), ["en", "ru"]);
    assert.ok(!("owner" in c) && !("revision" in c), "the wallet or grain profile fills them in");
    for (const lang of ["en", "ru"]) {
      const t = c.texts[lang];
      assert.ok(t.tagline && t.about && t.highlights.length >= 2 && t.privacy, `${chat ? "chat" : "page"} ${lang}`);
    }
    // It passes every rule of the format, and says it is the template's own: words about the counter (or the hello chat)
    // grain init makes, which a wallet would show as the app's.
    const { errors, warnings } = lintConnect(dir, manifestOf(dir));
    assert.deepEqual(errors, [], chat ? "chat-only" : "page");
    assert.deepEqual(warnings.map((w) => w.split(": texts.")[0]), [`${TEMPLATE_RULE}: connect.json`, `${TEMPLATE_RULE}: connect.json`]);
    assert.match(warnings[0], new RegExp(`texts\\.en: tagline, about, highlights and privacy are grain init's words for the ${chat ? "hello chat" : "counter"} it makes`));
    assert.deepEqual(lintPermissionsUse(dir, manifestOf(dir)), [], "the template uses what it asks for");
    const p = profileOfProject(c, ownerId, 1);
    assert.equal(profileProblem(p), null);
    const linted = grain(["lint"], dir);
    assert.equal(linted.status, 0, linted.stderr);
    assert.doesNotMatch(linted.stdout + linted.stderr, /permissions:/);
    // Written for the app: nothing to say.
    written(dir);
    assert.deepEqual(lintConnect(dir, manifestOf(dir)), { errors: [], warnings: [] });
  }
  // No placeholder link: a website, support and terms are the app's own, and none until it has them.
  for (const chat of [false, true]) {
    const c = JSON.parse(connectJson("dice", "Dice", chat));
    assert.deepEqual([c.website, c.support, c.terms], [null, null, null]);
  }
});

test("lint: a missing connect.json stops registering, as every rule of the format does, each naming its field", () => {
  const dir = project();
  rmSync(join(dir, CONNECT_FILE));
  const missing = grain(["lint"], dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^error: connect\.json: missing\. Every app ships a Connect profile/m);
  assert.doesNotMatch(missing.stdout, /ready to publish/);
  writeFileSync(join(dir, CONNECT_FILE), "{");
  assert.match(lintConnect(dir, manifestOf(dir)).errors[0], /connect\.json: not JSON/);
  writeFileSync(join(dir, CONNECT_FILE), connectJson("dice", "Dice", false));
  const cases = [
    [(c) => { c.version = 2; }, /version: 1/],
    [(c) => { c.subject = { grain: { slug: "other" } }; }, /subject\.grain\.slug "other" is not grain\.json's slug "dice"/],
    [(c) => { c.subject = { site: { origin: "https://a.example", name: "A", category: 0 } }; }, /subject: \{"grain": \{"slug": "dice"\}\}/],
    [(c) => { delete c.texts.en; }, /texts: 1 to 8 languages, "en" among them/],
    [(c) => { c.texts.RU = c.texts.ru; }, /texts\.RU: a language code is 2 to 8 of \[a-z-\]/],
    [(c) => { c.texts.en.tagline = ""; }, /texts\.en\.tagline: required, 1 to 80 characters: what the app is, in one line/],
    [(c) => { c.texts.en.tagline = "x".repeat(81); }, /texts\.en\.tagline: 81 characters, at most 80/],
    [(c) => { c.texts.en.tagline = "Two\nlines"; }, /texts\.en\.tagline: one line/],
    [(c) => { c.texts.en.tagline = "Split ‮bill"; }, /texts\.en\.tagline: U\+202E is refused/],
    [(c) => { c.texts.en.tagline = "Split "; }, /texts\.en\.tagline: no space or line break at its start or end/],
    [(c) => { c.texts.ru.about = "x".repeat(601); }, /texts\.ru\.about: 601 characters, at most 600/],
    [(c) => { c.texts.en.highlights = ["a", "b", "c", "d", "e"]; }, /texts\.en\.highlights: 5 of them, at most 4/],
    [(c) => { c.texts.en.highlights = [""]; }, /texts\.en\.highlights\[0\]: required/],
    [(c) => { c.texts.en.highlights = "one"; }, /texts\.en\.highlights: a list/],
    [(c) => { c.texts.en.privacy = "x".repeat(301); }, /texts\.en\.privacy: 301 characters, at most 300/],
    [(c) => { c.texts.en.privacy = ""; }, /texts\.en\.privacy: required: grain\.json asks for storage/],
    [(c) => { c.website = "http://dice.example"; }, /website: an https:\/\/ link of at most 256 bytes/],
    [(c) => { c.terms = "javascript:alert(1)"; }, /terms: an https:\/\/ link/],
    [(c) => { c.support = "mailto:help@dice.example?subject=hi"; }, /support: an https:\/\/ link, a mailto: address with nothing after it, or a Saltix username/],
    [(c) => { c.support = "@Dice"; }, /support:/],
  ];
  for (const [f, expected] of cases) {
    const { errors } = change(dir, f);
    assert.ok(errors.some((e) => expected.test(e)), `${expected}: ${errors.join(" | ")}`);
    writeFileSync(join(dir, CONNECT_FILE), connectJson("dice", "Dice", false));
  }
  // What a good profile may hold passes: an app's own links.
  assert.deepEqual(change(dir, (c) => {
    c.support = "@dice_help";
    c.terms = "https://saltix.io/terms?lang=en#top";
    c.texts.en.highlights = [];
  }).errors, []);
  // A link to a host reserved for examples leads nowhere: refused, by lint and by grain profile alike (grain init writes
  // none).
  for (const [field, link] of [["website", "https://dice.example/"], ["terms", "https://www.example.com/terms"], ["support", "mailto:help@dice.test"],
    ["website", "https://localhost/"], ["support", "https://help.dice.invalid/"]]) {
    const { errors } = change(dir, (c) => { c[field] = link; });
    assert.ok(errors.some((e) => e.startsWith(`connect.json: ${field}: ${link} is a placeholder that leads nowhere`)), `${field} ${link}: ${errors.join(" | ")}`);
    writeFileSync(join(dir, CONNECT_FILE), connectJson("dice", "Dice", false));
  }
  for (const link of ["https://saltix.io/", "https://example.org.saltix.io/", "https://myexample.com/", "@example"]) {
    assert.ok(!placeholderLink(link), link);
  }
});

test("lint: the privacy summary is required where the app asks for the address or storage, and only there", () => {
  const dir = project();
  const m = manifestOf(dir);
  const blank = (c) => { for (const lang of Object.keys(c.texts)) c.texts[lang].privacy = ""; };
  writeConnect(dir, (() => { const c = connectOf(dir); blank(c); return c; })());
  const lintWith = (permissions) => lintConnect(dir, { ...m, permissions }).errors;
  assert.equal(lintWith(1).filter((e) => /privacy: required: grain\.json asks for storage/.test(e)).length, 2, "every language");
  assert.ok(lintWith(64).some((e) => /asks for address,/.test(e)));
  assert.ok(lintWith(65).some((e) => /asks for address and storage/.test(e)));
  assert.deepEqual(lintWith(4 | 2 | 8), [], "notifications, relay and camera need none");
});

test("lint warns, and passes: about empty, English only, owner or revision given, a link too long for a QR code", () => {
  const dir = project();
  const w = (f) => change(dir, f);
  assert.match(w((c) => { c.texts.en.about = ""; }).warnings.join("\n"), /texts\.en\.about: empty: say what the app does/);
  writeFileSync(join(dir, CONNECT_FILE), connectJson("dice", "Dice", false));
  const english = w((c) => { delete c.texts.ru; });
  assert.deepEqual(english.errors, []);
  assert.match(english.warnings.join("\n"), /English only; add "ru"/);
  writeFileSync(join(dir, CONNECT_FILE), connectJson("dice", "Dice", false));
  assert.match(w((c) => { c.owner = "00".repeat(32); c.revision = 4; }).warnings.join("\n"), /owner and revision are filled in when it is set/);
  writeFileSync(join(dir, CONNECT_FILE), connectJson("dice", "Dice", false));
  // Six more languages of text that does not compress: within 8 KiB, too long for a QR code.
  const noise = (n, seed) => {
    let t = "";
    for (let i = 0; t.length < n; i++) t += toHex(derive("test noise", new TextEncoder().encode(`${seed} ${i}`)));
    return t.slice(0, n);
  };
  const long = w((c) => {
    for (const [i, lang] of ["de", "es", "fr", "it", "pt", "uk"].entries()) c.texts[lang] = { ...c.texts.en, tagline: noise(80, i), about: noise(600, i + 9) };
  });
  assert.deepEqual(long.errors, []);
  assert.match(long.warnings.join("\n"), /too long for a QR code; set it in Saltix's app studio .* or with a key file/);
  // Eight languages of every text at its longest: each field in bounds, the whole past 8 KiB.
  const big = w((c) => {
    const full = { tagline: "t".repeat(80), about: "a".repeat(600), highlights: Array(4).fill("h".repeat(60)), privacy: "p".repeat(300) };
    c.texts = Object.fromEntries(["de", "en", "es", "fr", "it", "pt", "ru", "uk"].map((l) => [l, full]));
  });
  assert.match(big.errors.join("\n"), /bytes in its Borsh form, at most 8192/);
});

test("lint checks the icon file a project keeps: one every wallet takes (32-images §2), whose hash grain.json names", () => {
  const dir = project();
  const vectors = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
  const standard = Buffer.from(vectors.images.find((i) => i.kind === "grain_icon" && i.width === 512).hex, "hex");
  const legacy = Buffer.from(vectors.images.find((i) => i.kind === "grain_icon" && i.width === 256).hex, "hex");
  const header = (w, h) => {
    const b = new Uint8Array(40);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  assert.deepEqual(pngSize(header(256, 256)), { width: 256, height: 256 });
  assert.equal(pngSize(new TextEncoder().encode("GIF89a, not a png at all")), null);
  const m = manifestOf(dir);
  assert.deepEqual(lintIcon(dir, m).errors, [], "no icon file: nothing to check");
  writeFileSync(join(dir, "icon.png"), header(512, 512));
  assert.match(lintIcon(dir, m).errors[0], /icon\.png: the image check: format/);
  writeFileSync(join(dir, "icon.png"), "GIF89a");
  assert.match(lintIcon(dir, m).errors[0], /icon\.png: the image check: format/);
  writeFileSync(join(dir, "icon.png"), standard);
  assert.match(lintIcon(dir, m).errors[0], /icon\.png: its hash is [0-9a-f]{64}, but grain\.json's "icon" is 0{64}/);
  assert.deepEqual(lintIcon(dir, { ...m, icon: iconHash(standard) }).errors, []);
  // 256 × 256, as manifests named before the standard: taken, with a warning.
  writeFileSync(join(dir, "icon.png"), legacy);
  const old = lintIcon(dir, { ...m, icon: iconHash(legacy) });
  assert.deepEqual(old.errors, []);
  assert.match(old.warnings.join("\n"), /256 × 256: wallets take it/);
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "icon.png"), header(255, 256));
  assert.match(lintIcon(dir, { ...m, icon: iconHash(legacy) }).errors[0], /public\/icon\.png: the image check/);
  const linted = grain(["lint"], dir);
  assert.equal(linted.status, 1, "the icon's errors stop registering");
});

test("lint warns about each permission nothing of the app's own uses", () => {
  const dir = project();
  const m = manifestOf(dir);
  const warned = (permissions) => lintPermissionsUse(dir, { ...m, permissions }).map((w) => /asks for "([a-z]+)"/.exec(w)[1]);
  assert.deepEqual(warned(1), [], "app.js uses grain.storage");
  assert.deepEqual(warned(1 | 64 | 32 | 8 | 16 | 2 | 4), ["relay", "notifications", "camera", "microphone", "location", "address"]);
  // The bridge names every call itself: it says nothing of what the app uses.
  assert.ok(readFileSync(join(dir, "public", "grain.js"), "utf8").includes("grain_requestAddress"));
  writeFileSync(join(dir, "public", "pay.js"), "const a = await grain.requestAddress();\nnavigator.geolocation.getCurrentPosition(() => {});\n");
  writeFileSync(join(dir, "public", "call.js"), "navigator.mediaDevices.getUserMedia({ audio: true });\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "server.ts"), "await chat.notify(user, card().text('Done'));\n");
  assert.deepEqual(warned(1 | 64 | 32 | 8 | 16 | 2 | 4), ["relay", "camera"]);
  // Dependencies, builds and tests are not the app's sources.
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", "index.js"), "grain.relay.open();");
  assert.deepEqual(warned(2), ["relay"]);
  // A chat-only app's server notifies through ChatServer (its errors reach the team unasked).
  const chat = project(true, "coach");
  assert.deepEqual(lintPermissionsUse(chat, manifestOf(chat)), []);
});

/** A node whose registry holds `state.grain` (and its profile), recording what is submitted. */
async function fakeNode(state) {
  const submitted = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const grainRecord = state.grain === null ? null : { slug: "dice", owner: ownerId, version: 1, retired: null, servers: [], category: 0, public: true, members: [], profile: state.profile ?? null, ...state.grain };
      const result = {
        node_status: { genesis: GENESIS, slot: 1000, network: "devnet", beacon: { height: 1, hash: "b1" } },
        account_get: { nonce: 4, salt: "200000000000", controller: null, shard: "" },
        grain_get: { grain: params.slug === "dice" ? grainRecord : null, deposit: "10000000000" },
        transaction_submit: { id: "ab".repeat(32) },
      }[method];
      if (method === "transaction_submit") submitted.push(params.transaction);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}`, submitted, state, close: () => http.close() };
}

const run = (args, cwd) => new Promise((resolve) => {
  const child = spawn("node", [main, ...args], { cwd });
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

/** The signed profile a SetGrainProfile transaction carries: after the sender (33), nonce, fee and slot (24), the action's
 *  tag (1), the call's tag (38) and the slug, the option's tag. */
function profileOf(txHex) {
  const b = fromHex(txHex);
  assert.equal(b[57], 1, "Action::Registry");
  assert.equal(b[58], 38, "SetGrainProfile");
  const slugLength = new DataView(b.buffer, 59, 4).getUint32(0, true);
  const at = 63 + slugLength;
  if (b[at] === 0) return null;
  // The signed profile, then the amount (8), the proof's tag (1) and signature (64).
  return decodeSignedProfile(b.slice(at + 1, b.length - 8 - 65));
}

test("the template's words: lint warns (connect-template), grain profile refuses them; any language left so is named", async () => {
  // Any name: the about carries the one grain init was given, which the app's may have changed since.
  for (const chat of [false, true]) {
    const template = JSON.parse(connectJson("dice", "Some other name", chat));
    assert.equal(templateTexts(template).length, 2, chat ? "chat" : "page");
    // One field left as the template's is still the template's.
    const half = { ...template, texts: { en: { ...OWN.en, tagline: connectTexts("x", chat).en.tagline }, ru: OWN.ru } };
    assert.deepEqual(templateTexts(half), [`texts.en: tagline is grain init's words for the ${chat ? "hello chat" : "counter"} it makes, not this app's`]);
  }
  assert.deepEqual(templateTexts({ ...JSON.parse(connectJson("dice", "Dice", false)), texts: OWN }), []);
  assert.deepEqual(templateTexts("not a profile"), []);
  // grain profile refuses the template's words before anything is signed or sent, and says why in the log.
  const dir = project();
  writeFileSync(join(dir, "owner.key"), "61".repeat(32) + "\n", { mode: 0o600 });
  const node = await fakeNode({ grain: {} });
  const refused = await run(["profile", "--node", node.url], dir);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^error: connect\.json: texts\.en: tagline, about, highlights and privacy are grain init's words for the counter it makes, not this app's; texts\.ru: .*: rewrite it for this app/m);
  assert.deepEqual(node.submitted, []);
  assert.match(readFileSync(join(dir, ".grain", "log.jsonl"), "utf8"), /"step":"profile","outcome":"refused","reason":"connect_template"/);
  // Rewritten: it goes.
  written(dir);
  const set = await run(["profile", "--node", node.url], dir);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(node.submitted.length, 1);
  node.close();
});

test("grain profile --key: signed by the key file, the registry's revision and one, sent as SetGrainProfile", async () => {
  const dir = project();
  written(dir);
  writeFileSync(join(dir, "owner.key"), "61".repeat(32) + "\n", { mode: 0o600 });
  // The registry holds revision 4 of other words.
  const earlier = { ...connectOf(dir), texts: { ...connectOf(dir).texts, en: { ...connectOf(dir).texts.en, tagline: "An older tagline" } } };
  const before = signProfile(profileOfProject(earlier, ownerId, 4), secret);
  const node = await fakeNode({ grain: {}, profile: before });
  const r = await run(["profile", "--node", node.url], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /profile: transaction (ab){32} \(fee \d+(\.\d+)? SALT\)/);
  const sent = profileOf(node.submitted[0]);
  assert.equal(sent.profile.revision, 5);
  assert.equal(sent.profile.owner, ownerId);
  assert.equal(checkGrainProfile(sent, "dice", ownerId), null);
  assert.deepEqual(sent.profile.texts, connectOf(dir).texts);
  // Once the registry holds these words, asking again changes nothing and sends nothing, whoever signs.
  node.state.profile = sent;
  const same = await run(["profile", "--node", node.url], dir);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /^nothing to change: the registry holds dice's Connect profile with these words already; nothing signed or sent$/m);
  assert.equal(node.submitted.length, 1);
  node.state.profile = before;
  // Cleared, and refused for another owner's grain or a broken profile before anything is sent.
  const cleared = await run(["profile", "--clear", "--node", node.url], dir);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.equal(profileOf(node.submitted[1]), null);
  // Another owner's app (one made in Saltix): owner.key here never signs for it. Without --key the owner's Saltix is
  // asked, the owner said first; --key naming it is refused before anything is sent.
  node.state.grain = { owner: "77".repeat(32) };
  const theirs = await run(["profile", "--key", "owner.key", "--node", node.url], dir);
  assert.equal(theirs.code, 1);
  assert.match(theirs.stderr, /dice: the registry names another owner \(7{64}\) than owner\.key's account/);
  const asked = await run(["profile", "--timeout", "1", "--node", node.url], dir);
  assert.match(asked.stdout, /^owner: dsalt1\S+, as the registry names it: its Saltix signs \(owner\.key here is another account's\)$/m);
  assert.match(asked.stdout, /salt:grain-profile\?p=/);
  assert.equal(node.submitted.length, 2, "nothing sent for another owner's app");
  node.state.grain = {};
  writeConnect(dir, { ...connectOf(dir), website: "http://dice.example" });
  const broken = await run(["profile", "--node", node.url], dir);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /website/);
  assert.equal(node.submitted.length, 2);
  node.state.profile = null;
  const none = await run(["profile", "--clear", "--node", node.url], dir);
  assert.match(none.stderr, /has no Connect profile to clear/);
  // A link that leads nowhere (grain init's placeholders were such) is refused before anything is signed.
  writeConnect(dir, { ...connectOf(dir), website: "https://dice.example/" });
  const placeholder = await run(["profile", "--node", node.url], dir);
  assert.equal(placeholder.code, 1);
  assert.match(placeholder.stderr, /connect\.json: website: https:\/\/dice\.example\/ is a placeholder that leads nowhere/);
  assert.equal(node.submitted.length, 2);
  // Cleared at revision 5: the next is 6, never an older one the registry would refuse.
  writeConnect(dir, { ...connectOf(dir), website: "https://saltix.io/" });
  node.state.grain = { profile_revision: 5 };
  const again = await run(["profile", "--node", node.url], dir);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(profileOf(node.submitted[2]).profile.revision, 6);
  node.close();
});

test("grain profile without a key: a QR code and the link for the owner's Saltix, then the registry's word", async () => {
  const dir = project();
  written(dir);
  rmSync(join(dir, "owner.key"));
  const node = await fakeNode({ grain: {} });
  const child = spawn("node", [main, "profile", "--node", node.url, "--timeout", "20"], { cwd: dir });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const link = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no link: ${out}`)), 15_000);
    child.stdout.on("data", () => {
      const m = /The link: (salt:grain-profile\?p=\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const unowned = readProfileLink(link);
  assert.equal(unowned.owner, "00".repeat(32));
  assert.equal(unowned.revision, 0);
  assert.deepEqual(unowned.texts, connectOf(dir).texts);
  // The owner's wallet signs it with a key of its own and the next revision.
  const phone = fromHex("62".repeat(32), 32);
  node.state.profile = signProfile({ ...unowned, owner: ownerId, revision: 1 }, phone);
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, out);
  assert.match(out, /the registry has it: revision 1/);
  assert.equal(node.submitted.length, 0, "nothing signed here");
  node.close();
});

test("grain show checks the registry's profile as a wallet does", async () => {
  const dir = project();
  const p = signProfile(profileOfProject(connectOf(dir), ownerId, 2), secret);
  const node = await fakeNode({ grain: {}, profile: p });
  const shown = await run(["show", "--slug", "dice", "--node", node.url], dir);
  // A summary first, in words; the record as JSON only with --json.
  assert.match(shown.stdout, /^dice on devnet 5a5a5a5a5a5a5a5a: v1, public\n {2}owner {4}dsalt1\S+\n/);
  assert.match(shown.stdout, /^ {2}profile {2}Connect profile revision 2: "A counter that follows you to every phone" \(en, ru\); it checks$/m);
  assert.match(shown.stdout, /^grain show --slug dice --json prints the registry's whole record$/m);
  assert.doesNotMatch(shown.stdout, /^\{/m);
  const json = await run(["show", "--slug", "dice", "--json", "--node", node.url], dir);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).profile.profile.revision, 2, "only the record on stdout");
  node.state.grain = { owner: "77".repeat(32) };
  assert.match((await run(["show", "--slug", "dice", "--node", node.url], dir)).stdout, /a wallet refuses it: owner/);
  node.state.grain = {};
  node.state.profile = null;
  assert.match((await run(["show", "--slug", "dice", "--node", node.url], dir)).stdout, /^ {2}profile {2}none: grain profile sets it from connect\.json$/m);
  node.close();
});

test("grain connect-profile: a website's profile signed by its operator, for /.well-known/saltix-connect", async () => {
  const dir = scratch("grain-site-");
  writeFileSync(join(dir, "site.key"), "64".repeat(32) + "\n", { mode: 0o600 });
  const site = JSON.parse(connectJson("dex", "Example DEX", false));
  delete site.subject;
  site.texts = {
    en: { tagline: "Swap SALT and WORK at the best price", about: "Every swap is a transaction you sign in Saltix.", highlights: ["You sign every swap"], privacy: "Keeps nothing about you." },
  };
  site.support = "mailto:help@dex.example";
  writeFileSync(join(dir, "connect.json"), JSON.stringify(site));
  const args = ["connect-profile", "--origin", "https://dex.example", "--name", "Example DEX", "--category", "finance", "--key", "site.key"];
  const out = join(dir, ".well-known", "saltix-connect");
  // The first time, with no file of it here and the site not answering (dex.example is no host), the revision a
  // wallet would take is unknown: a wallet keeps a higher one, so the command asks for it rather than guess 1.
  const unknown = grain(args, dir);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /could not read the profile https:\/\/dex\.example serves now[^]*--revision N/);
  assert.ok(!existsSync(out));
  const made = grain([...args, "--revision", "1"], dir);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /serve it at https:\/\/dex\.example\/\.well-known\/saltix-connect as application\/json/);
  const signed = signedProfileFromJson(JSON.parse(readFileSync(out, "utf8")));
  assert.equal(checkSiteProfile(signed, "https://dex.example"), null);
  assert.deepEqual(signed.profile.subject, { site: { origin: "https://dex.example", name: "Example DEX", category: 2 } });
  assert.equal(signed.profile.owner, toHex(accountId(ed25519.getPublicKey(fromHex("64".repeat(32), 32)))));
  assert.equal(signed.profile.revision, 1);
  // Again: above the file written before, while the site cannot be read; --revision names one.
  const again = grain(args, dir);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /revision 2/);
  assert.equal(signedProfileFromJson(JSON.parse(readFileSync(out, "utf8"))).profile.revision, 2);
  assert.equal(grain([...args, "--revision", "9"], dir).status, 0);
  assert.equal(signedProfileFromJson(JSON.parse(readFileSync(out, "utf8"))).profile.revision, 9);
  // What a wallet refuses is refused here, and nothing is written.
  const other = join(dir, "other.json");
  for (const [bad, expected] of [
    [["--origin", "https://Dex.example"], /subject/],
    [["--origin", "https://dex.example/app"], /subject/],
    [["--category", "10"], /--category: 0 to 9/],
    [["--name", "x".repeat(33)], /subject/],
  ]) {
    const flags = [...args];
    flags[flags.indexOf(bad[0]) + 1] = bad[1];
    const r = grain([...flags, "--out", other], dir);
    assert.equal(r.status, 1, bad.join(" "));
    assert.match(r.stderr, expected);
    assert.ok(!existsSync(other));
  }
  assert.equal(grain(["connect-profile", "--origin", "https://dex.example", "--name", "X", "--category", "1"], dir).status, 1, "--key is needed");
  // A managed operator's Ed25519 device key signs for the account --owner names (its key event log says whether it may).
  const managed = "dsalt1q" + "q".repeat(52);
  const { encodeAddress } = await import("@saltix/grain-server");
  const account = encodeAddress("devnet", fromHex("77".repeat(32), 32), 5);
  assert.equal(grain([...args, "--owner", account, "--out", other, "--revision", "1"], dir).status, 0);
  // Offline (an operator's machine without the network): above the file written before, never a guess.
  const offline = grain([...args, "--owner", account, "--out", other, "--offline"], dir);
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /revision 2/);
  const device = signedProfileFromJson(JSON.parse(readFileSync(other, "utf8")));
  assert.equal(device.profile.owner, "77".repeat(32));
  assert.equal(device.key.ed25519, toHex(ed25519.getPublicKey(fromHex("64".repeat(32), 32))));
  assert.equal(checkSiteProfile(device, "https://dex.example"), null);
  assert.equal(grain([...args, "--owner", managed, "--out", join(dir, "x.json")], dir).status, 1, "not an address");
  assert.equal(grain([...args, "--revision", "0"], dir).status, 2);
});

test("a website's next revision goes above the one the site serves now, read as a wallet reads it", async () => {
  const site = signProfile({
    version: 1, subject: { site: { origin: "https://dex.example", name: "Example DEX", category: 2 } }, owner: ownerId, revision: 7,
    texts: { en: { tagline: "Swap SALT and WORK", about: "", highlights: [], privacy: "" } }, website: null, support: null, terms: null,
  }, secret);
  const asked = [];
  const answer = (status, body, headers = {}) => async (url, init) => {
    asked.push({ url: String(url), init });
    return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
  };
  const json = JSON.stringify(profileToJson(site));
  assert.equal(await servedSiteRevision("https://dex.example", answer(200, json)), 7);
  assert.equal(asked[0].url, "https://dex.example/.well-known/saltix-connect");
  assert.equal(asked[0].init.redirect, "manual", "no redirect is followed, as a wallet follows none");
  assert.equal(asked[0].init.credentials, "omit");
  assert.equal(await servedSiteRevision("https://other.example", answer(200, json)), 0, "another origin's profile is none of this one's");
  assert.equal(await servedSiteRevision("https://dex.example", answer(404, "not found")), 0, "nothing served yet");
  assert.equal(await servedSiteRevision("https://dex.example", answer(302, "", { location: "https://dex.example/x" })), null, "a redirect a wallet does not follow");
  assert.equal(await servedSiteRevision("https://dex.example", answer(503, "")), null);
  assert.equal(await servedSiteRevision("https://dex.example", answer(200, "<html>")), null, "something that is no profile");
  assert.equal(await servedSiteRevision("https://dex.example", async () => { throw new TypeError("fetch failed"); }), null);
  // Above both the site's and the file's.
  const value = { texts: site.profile.texts, website: null, support: null, terms: null };
  const input = { value, origin: "https://dex.example", name: "Example DEX", category: "2" };
  assert.equal((await siteProfile({ ...input, served: async () => 7 }, secret)).profile.revision, 8);
  assert.equal((await siteProfile({ ...input, served: async () => 0 }, secret)).profile.revision, 1, "a site that serves none yet");
  await assert.rejects(siteProfile({ ...input, served: async () => null }, secret), /--revision N/);
  assert.equal((await siteProfile({ ...input, served: async () => null, revision: 3 }, secret)).profile.revision, 3);
});
