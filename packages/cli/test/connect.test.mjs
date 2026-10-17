// The Connect profile from the command line (Saltix 19-connect §11, 12-grains §10): connect.json in every project
// `grain init` makes, `grain lint`'s rules for it, the icon and permissions nothing uses, `grain profile` (the owner's
// QR code, or a key file and SetGrainProfile), `grain show`, and a website's profile from `grain connect-profile`.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import {
  accountId, derive, checkGrainProfile, checkSiteProfile, decodeSignedProfile, fromHex, iconHash, profileProblem, readProfileLink, signProfile,
  signedProfileFromJson, toHex, profileToJson,
} from "@saltix/grain-server";
import { CONNECT_FILE, lintConnect, lintIcon, lintPermissionsUse, pngSize, profileOfProject } from "../dist/connect.js";
import { connectJson } from "../dist/template.js";
import { servedSiteRevision, siteProfile } from "../dist/profile.js";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const grain = (args, cwd) => spawnSync("node", [main, ...args], { cwd, encoding: "utf8", timeout: 20_000 });
const secret = fromHex("61".repeat(32), 32);
const ownerId = toHex(accountId(ed25519.getPublicKey(secret)));
const GENESIS = "5a".repeat(32);

/** A new project of `grain init`, page or chat-only. */
function project(chat = false, slug = "dice") {
  const dir = join(mkdtempSync(join(tmpdir(), "grain-connect-")), slug);
  const made = grain(["init", dir, "--slug", slug, "--name", "Dice roll", ...(chat ? ["--chat"] : [])], tmpdir());
  assert.equal(made.status, 0, made.stderr);
  return dir;
}
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
    assert.deepEqual(lintConnect(dir, manifestOf(dir)), { errors: [], warnings: [] }, chat ? "chat-only" : "page");
    assert.deepEqual(lintPermissionsUse(dir, manifestOf(dir)), [], "the template uses what it asks for");
    const p = profileOfProject(c, ownerId, 1);
    assert.equal(profileProblem(p), null);
    const linted = grain(["lint"], dir);
    assert.equal(linted.status, 0, linted.stderr);
    assert.doesNotMatch(linted.stdout + linted.stderr, /connect\.json|permissions:/);
  }
  // A slug that makes no host gets no website: the profile still passes.
  assert.equal(JSON.parse(connectJson("dice-", "Dice", false)).website, null);
  assert.equal(JSON.parse(connectJson("dice", "Dice", false)).website, "https://dice.example/");
});

test("lint: a missing connect.json stops registering, as every rule of the format does, each naming its field", () => {
  const dir = project();
  rmSync(join(dir, CONNECT_FILE));
  const missing = grain(["lint"], dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^error: connect\.json: missing\. Every app ships a Connect profile/m);
  assert.doesNotMatch(missing.stdout, /ready to register/);
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
  // What a good profile may hold passes.
  assert.deepEqual(change(dir, (c) => {
    c.support = "@dice_help";
    c.terms = "https://dice.example/terms?lang=en#top";
    c.texts.en.highlights = [];
  }).errors, []);
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

test("lint checks the icon file a project keeps: a 256×256 PNG whose hash grain.json names", () => {
  const dir = project();
  const png = (w, h) => {
    const b = new Uint8Array(40);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  assert.deepEqual(pngSize(png(256, 256)), { width: 256, height: 256 });
  assert.equal(pngSize(new TextEncoder().encode("GIF89a, not a png at all")), null);
  const m = manifestOf(dir);
  assert.deepEqual(lintIcon(dir, m).errors, [], "no icon file: nothing to check");
  writeFileSync(join(dir, "icon.png"), png(512, 512));
  assert.match(lintIcon(dir, m).errors[0], /icon\.png: 512×512; Saltix shows a 256×256 PNG/);
  writeFileSync(join(dir, "icon.png"), "GIF89a");
  assert.match(lintIcon(dir, m).errors[0], /icon\.png: not a PNG/);
  const icon = png(256, 256);
  writeFileSync(join(dir, "icon.png"), icon);
  assert.match(lintIcon(dir, m).errors[0], /icon\.png: its hash is [0-9a-f]{64}, but grain\.json's "icon" is 0{64} \(grain icon icon\.png gives the hash\)/);
  assert.deepEqual(lintIcon(dir, { ...m, icon: iconHash(icon) }).errors, []);
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", "icon.png"), png(255, 256));
  assert.match(lintIcon(dir, { ...m, icon: iconHash(icon) }).errors[0], /public\/icon\.png: 255×256/);
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

test("grain profile --key: signed by the key file, the registry's revision and one, sent as SetGrainProfile", async () => {
  const dir = project();
  writeFileSync(join(dir, "owner.key"), "61".repeat(32) + "\n", { mode: 0o600 });
  const before = signProfile(profileOfProject(connectOf(dir), ownerId, 4), secret);
  const node = await fakeNode({ grain: {}, profile: before });
  const r = await run(["profile", "--node", node.url], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /profile: transaction (ab){32} \(fee \d+\)/);
  const sent = profileOf(node.submitted[0]);
  assert.equal(sent.profile.revision, 5);
  assert.equal(sent.profile.owner, ownerId);
  assert.equal(checkGrainProfile(sent, "dice", ownerId), null);
  assert.deepEqual(sent.profile.texts, connectOf(dir).texts);
  // Cleared, and refused for another owner's grain or a broken profile before anything is sent.
  const cleared = await run(["profile", "--clear", "--node", node.url], dir);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.equal(profileOf(node.submitted[1]), null);
  node.state.grain = { owner: "77".repeat(32) };
  const theirs = await run(["profile", "--node", node.url], dir);
  assert.equal(theirs.code, 1);
  assert.match(theirs.stderr, /registered by another owner/);
  node.state.grain = {};
  writeConnect(dir, { ...connectOf(dir), website: "http://dice.example" });
  const broken = await run(["profile", "--node", node.url], dir);
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /website/);
  assert.equal(node.submitted.length, 2);
  node.state.profile = null;
  const none = await run(["profile", "--clear", "--node", node.url], dir);
  assert.match(none.stderr, /has no Connect profile to clear/);
  // Cleared at revision 5: the next is 6, never an older one the registry would refuse.
  writeConnect(dir, { ...connectOf(dir), website: "https://dice.example/" });
  node.state.grain = { profile_revision: 5 };
  const again = await run(["profile", "--node", node.url], dir);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(profileOf(node.submitted[2]).profile.revision, 6);
  node.close();
});

test("grain profile without a key: a QR code and the link for the owner's Saltix, then the registry's word", async () => {
  const dir = project();
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
  assert.match(shown.stdout, /Connect profile, revision 2: "A counter that follows you to every phone" \(en, ru\); it checks/);
  node.state.grain = { owner: "77".repeat(32) };
  assert.match((await run(["show", "--slug", "dice", "--node", node.url], dir)).stdout, /a wallet refuses it: owner/);
  node.state.grain = {};
  node.state.profile = null;
  assert.match((await run(["show", "--slug", "dice", "--node", node.url], dir)).stdout, /dice has no Connect profile: grain profile sets it/);
  node.close();
});

test("grain connect-profile: a website's profile signed by its operator, for /.well-known/saltix-connect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grain-site-"));
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
