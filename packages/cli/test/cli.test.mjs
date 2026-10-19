// The grain command line: projects, checks, the dev server and the registry calls against a fake node.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { UNOWNED, accountId, toHex, fromHex, verifyManifest } from "@saltix/grain-server";
import { lint, sign, forOrigin, readKey, signedFor } from "../dist/project.js";
import { publish, retire, walletLink, waitForPublished } from "../dist/registry.js";
import { serve, simulatorFor } from "../dist/dev.js";
import { lintPages, TOP_BAR_RULE, COVER_RULE, GATE_RULE, shownBeforeSignIn } from "../dist/pages.js";
import { FULL_SCREEN_RULE } from "../dist/template.js";
import { publishLink, publishLinkManifest } from "../dist/publish.js";
import { encodeManifest } from "@saltix/grain-server";

const secret = fromHex("61".repeat(32), 32);
const owner = toHex(ed25519.getPublicKey(secret));
const ownerId = toHex(accountId(fromHex(owner, 32)));
const manifest = (over = {}) => ({
  slug: "chess", version: 1, owner: ownerId, owner_key: { ed25519: owner }, name: { en: "Chess", ru: "Шахматы" }, description: {},
  icon: "11".repeat(32), entry: { hosted: { url: "https://chess.example/", origins: ["https://chess.example"] } },
  permissions: 1, sponsor: null, min_host: 1, ...over,
});

test("lint says what stops a registration", () => {
  assert.deepEqual(lint(manifest(), owner), { errors: [], warnings: [] });
  const dev = lint(manifest({ entry: { hosted: { url: "http://10.0.2.2:8090/", origins: ["http://10.0.2.2:8090"] } } }));
  assert.match(dev.errors[0], /developer origins/);
  assert.match(lint(manifest({ slug: "Chess" })).errors[0], /^slug/);
  assert.match(lint(manifest(), "22".repeat(32)).errors[0], /owner_key/);
  // The key file's own account owns it: a managed account publishes from its wallet.
  assert.match(lint(manifest({ owner: "77".repeat(32) }), owner).errors[0], /^owner:/);
  assert.match(lint(manifest({ owner_key: { p256: "02" + "33".repeat(32) } }), owner).errors[0], /owner_key/);
  const languages = ["en", "ru", "de", "fr", "es", "it", "pt", "pl", "uk", "kk", "tr", "ja", "zh", "ko", "ar", "hi"];
  // Every text at its longest, in four-byte characters, and a long URL: in bounds, but too large to register.
  const texts = (n) => Object.fromEntries(languages.map((l) => [l, "\u{1F600}".repeat(n)]));
  const url = "https://chess.example/" + "a".repeat(2000);
  const huge = manifest({ name: texts(32), description: texts(200), entry: { hosted: { url, origins: ["https://chess.example"] } } });
  assert.match(lint(huge).errors[0], /^size/, "a manifest too large for a transaction");
  assert.equal(lint(manifest({ icon: "00".repeat(32), name: { en: "Chess" } })).warnings.length, 2);
});

test("a manifest is signed for its owner, and for a developer's origin", () => {
  const signed = sign(manifest(), secret);
  assert.ok(verifyManifest(signed));
  const local = forOrigin(manifest(), "http://10.0.2.2:8090");
  assert.deepEqual(local.entry, { hosted: { url: "http://10.0.2.2:8090/", origins: ["http://10.0.2.2:8090"] } });
  assert.ok(verifyManifest(sign(local, secret, true), true));
  assert.throws(() => sign(manifest({ owner_key: { ed25519: "22".repeat(32) } }), secret), /owner_key/);
});

/** A node that answers the wallet interface from `state` and records what was submitted. */
async function fakeNode(state) {
  const submitted = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const result = {
        node_status: { genesis: "5a".repeat(32), slot: 1000, network: "devnet" },
        account_get: { nonce: 4, salt: state.salt ?? "200000000000" },
        grain_get: { grain: state.grain ?? null },
        transaction_submit: { id: "ab".repeat(32) },
      }[method];
      if (method === "transaction_submit") submitted.push(params.transaction);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, submitted, close: () => server.close() };
}

const signing = (node) => ({ node, validFor: 600 });
// After sender (32), nonce, fee and valid_until_slot (8 each): Action::Registry (1), then the call's tag.
// Transaction v3: the sender's tag and key (33), nonce, fee, last slot (24), the action's tag, then the call's.
const callTag = (hex) => fromHex(hex)[58];

test("publish registers a new slug and updates the owner's", async () => {
  const fresh = await fakeNode({});
  const sent = await publish(sign(manifest(), secret), secret, signing(fresh.url));
  assert.equal(sent.call, "register");
  assert.equal(callTag(fresh.submitted[0]), 7);
  fresh.close();

  const grain = (over) => ({ slug: "chess", owner: ownerId, version: 1, retired: null, ...over });
  const mine = await fakeNode({ grain: grain() });
  assert.equal((await publish(sign(manifest({ version: 2 }), secret), secret, signing(mine.url))).call, "update");
  assert.equal(callTag(mine.submitted[0]), 8);
  await assert.rejects(publish(sign(manifest(), secret), secret, signing(mine.url)), /raise "version"/);
  mine.close();

  const theirs = await fakeNode({ grain: grain({ owner: "99".repeat(32) }) });
  // Another account's slug: often an app made in Saltix, whose owner is the phone, beside the owner.key grain init made.
  await assert.rejects(publish(sign(manifest({ version: 2 }), secret), secret, signing(theirs.url)), /another owner .*add --wallet/);
  theirs.close();
  const retired = await fakeNode({ grain: grain({ retired: 5 }) });
  await assert.rejects(publish(sign(manifest({ version: 2 }), secret), secret, signing(retired.url)), /never used again/);
  await assert.rejects(retire("chess", secret, signing(retired.url)), /retired already/);
  retired.close();
  const poor = await fakeNode({ salt: "99000000000" });
  await assert.rejects(publish(sign(manifest(), secret), secret, signing(poor.url)), /needs/);
  assert.equal(poor.submitted.length, 0);
  poor.close();
  const other = await fakeNode({});
  await assert.rejects(publish(sign(manifest(), secret), secret, { ...signing(other.url), genesis: "00".repeat(32) }), /genesis/);
  assert.equal(other.submitted.length, 0);
  other.close();
});

test("retire closes the owner's slug", async () => {
  const node = await fakeNode({ grain: { slug: "chess", owner: ownerId, version: 1, retired: null } });
  assert.equal((await retire("chess", secret, signing(node.url))).call, "retire");
  assert.equal(callTag(node.submitted[0]), 9);
  node.close();
});

test("grain dev serves public/ and the manifest for the asking origin only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grain-dev-"));
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "secret.txt"), "no");
  const server = await serve(dir, () => manifest(), secret, 0, "127.0.0.1");
  const port = server.address().port;
  // fetch() keeps its own Host header: a plain request names the one a phone would send.
  const get = (path, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject).end();
  });
  try {
    assert.equal((await get("/")).body, "<h1>hi</h1>");
    const signed = JSON.parse((await get("/.well-known/saltix-grain", `10.0.2.2:${port}`)).body);
    assert.equal(signed.manifest.entry.hosted.origins[0], `http://10.0.2.2:${port}`);
    assert.ok(verifyManifest(signed, true));
    assert.equal((await get("/.well-known/saltix-grain", "evil.example")).status, 400);
    assert.equal((await get("/%2e%2e/secret.txt")).status, 404);
    assert.equal((await get("/../secret.txt")).status, 404);
    // The simulator, built into the package: the page full screen as Saltix shows it.
    const page = await get("/_simulator/");
    assert.equal(page.status, 200);
    assert.match(page.body, /name="saltix-simulator"/);
    assert.match(page.body, /id="capsule"/);
    assert.match(page.body, /src="\.\/dist\/simulator\.js"/);
    const script = await get("/_simulator/dist/simulator.js");
    assert.equal(script.status, 200);
    assert.match(script.body, /grain_info/);
    assert.equal((await get("/_simulator")).status, 302);
    assert.equal((await get("/_simulator/../dev.js")).status, 404);
    assert.equal((await get("/_simulator/%2e%2e/main.js")).status, 404);
    assert.equal(simulatorFor("http://localhost:8090"), "http://localhost:8090/_simulator/?manifest=%2F.well-known%2Fsaltix-grain");
  } finally {
    server.close();
  }
});

/** A `public/` with these files. */
function pages(files) {
  const dir = mkdtempSync(join(tmpdir(), "grain-pages-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("lint: a page inside the safe area needs nothing; one that declares viewport-fit=cover must read the insets", () => {
  const warned = (files) => lintPages(pages(files));
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
  const bar = "<style>header { position: sticky; top: 0; background: #2f6bff }</style><header>Dice</header>";
  // No viewport-fit=cover: Saltix lays the page out inside the safe area, a bar at its top included.
  assert.deepEqual(warned({ "index.html": bar }), []);
  assert.deepEqual(warned({ "index.html": '<meta name="viewport" content="width=device-width, viewport-fit=auto">' + bar }), []);
  assert.deepEqual(warned({ "index.html": `<!-- ${meta} -->` + bar }), [], "a comment declares nothing");
  // Declared, and nothing reads the insets: both warnings, each with its fix.
  const [cover, top] = warned({ "index.html": meta + bar });
  assert.ok(cover.startsWith(`${COVER_RULE}: index.html declares viewport-fit=cover`), cover);
  assert.match(cover, /--saltix-safe-/);
  assert.match(cover, /drop viewport-fit=cover/);
  assert.ok(top.startsWith(`${TOP_BAR_RULE}: `), top);
  assert.match(top, /index\.html \(header\)/);
  assert.match(top, /heuristic/);
  // Read the insets anywhere, and the bar keeps clear in its own rule: nothing to say.
  assert.deepEqual(warned({ "index.html": meta + bar.replace("top: 0;", "top: 0; padding-top: var(--saltix-safe-top);") }), []);
  assert.deepEqual(warned({ "index.html": meta + bar.replace("top: 0;", "top: 0; padding-top: env(safe-area-inset-top);") }), []);
  // A script that lays out by the safe area places the bar itself.
  assert.deepEqual(warned({ "index.html": meta + bar, "app.js": "const { safeArea } = await grain.layout(); bar.style.paddingTop = safeArea.top + 'px';" }), []);
  // The insets read elsewhere, but the bar's own rule ignores them: the bar is warned about, not the page.
  const elsewhere = warned({ "index.html": meta + bar, "css/app.css": "main { padding-bottom: var(--saltix-safe-bottom) }" });
  assert.equal(elsewhere.length, 1);
  assert.ok(elsewhere[0].startsWith(`${TOP_BAR_RULE}: `));
  // Keeping clear of the controls alone keeps a bar clear, not the page: the status bar is still over it.
  const controls = warned({ "index.html": meta + bar.replace("top: 0;", "top: 0; padding-right: calc(var(--saltix-controls-right) + var(--saltix-controls-width));") });
  assert.deepEqual(controls.map((w) => w.split(":")[0]), [COVER_RULE]);
  // The bridge names the variables itself (and so does a bundle of it): that is not the page using them.
  const bridge = readFileSync(fileURLToPath(import.meta.resolve("@saltix/grain")), "utf8");
  assert.equal(warned({ "index.html": meta + bar, "grain.js": bridge }).length, 2);
  assert.equal(warned({ "index.html": meta + bar, "assets/app-1f2e.js": `const x = 1;\n${bridge}` }).length, 2);
  // The meta as pages write it: any order and case of attributes, single quotes, none; the last one decides.
  for (const m of ["<meta content='viewport-fit=cover' name='viewport'>", "<META NAME=viewport CONTENT=viewport-fit=cover>",
    '<meta name="viewport" content="width=device-width"><meta name="viewport" content="viewport-fit=cover">']) {
    assert.equal(warned({ "index.html": m + bar }).length, 2, m);
  }
  assert.deepEqual(warned({ "index.html": '<meta name="viewport" content="viewport-fit=cover"><meta name="viewport" content="width=device-width">' + bar }), []);
  // Found wherever it is, in an app that declared it: a stylesheet, inside @media, a style attribute, utility classes,
  // `inset`, a few pixels down.
  const bars = (files) => warned({ "index.html": meta + "<p>x</p>", "x.js": "safeArea", ...files });
  assert.equal(bars({ "css/bar.css": "@media (min-width: 1px) { .bar { position: fixed !important; top: 0px } }" }).length, 0, "a script lays out");
  const top1 = (files) => warned({ "index.html": meta, "css/pad.css": "main { padding: var(--saltix-safe-top) }", ...files });
  assert.equal(top1({ "css/bar.css": "@media (min-width: 1px) { .bar { position: fixed !important; top: 0px } }" }).length, 1);
  assert.match(top1({ "css/bar.css": ".bar { position:fixed;top:0 }" })[0], /css\/bar\.css \(\.bar\)/);
  assert.match(top1({ "index.html": meta + '<div style="position: fixed; top: 0">x</div>' })[0], /<div style>/);
  assert.match(top1({ "index.html": meta + '<nav class="sticky top-0 bg-white">x</nav>' })[0], /class="sticky top-0"/);
  assert.deepEqual(top1({ "index.html": meta + '<nav class="sticky top-0 pt-[var(--saltix-safe-top)]">x</nav>' }), []);
  assert.equal(top1({ "index.html": meta + "<style>.sheet { position: fixed; inset: 0 }</style>" }).length, 1);
  assert.equal(top1({ "index.html": meta + "<style>.bar { position: fixed; top: 8px }</style>" }).length, 1);
  // A page that does not declare it is not read for bars; a stylesheet always is.
  assert.deepEqual(top1({ "other.html": '<div style="position: fixed; top: 0">x</div>' }), []);
  // Not a top bar: in the flow, at the bottom, or placed by the variables.
  assert.deepEqual(top1({ "index.html": meta + "<style>header { position: relative; top: 0 }</style>" }), []);
  assert.deepEqual(top1({ "index.html": meta + "<style>footer { position: fixed; bottom: 0 }</style>" }), []);
  assert.deepEqual(top1({ "index.html": meta + "<style>.fab { position: fixed; top: 120px }</style>" }), []);
  assert.deepEqual(top1({ "index.html": meta + "<style>/* header { position: fixed; top: 0 } */</style>" }), [], "a comment is not CSS");
  assert.deepEqual(lintPages(join(tmpdir(), "no-such-public-dir")), []);
  const many = top1(Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [`${n}.css`, `.${n} { position: fixed; top: 0 }`])));
  assert.match(many[0], /and 2 more/);
  // Two pages that declare it are named.
  assert.match(warned({ "index.html": meta, "b.html": meta })[0], /^cover-without-insets: b\.html, index\.html declare viewport-fit=cover/);
});

test("lint: a page that signs in shows only its splash until the gate decides (check first, render after)", () => {
  const warned = (files) => lintPages(pages(files));
  const splash = '<div class="splash" data-grain-splash><img src="icon.png" alt=""><strong>Pass</strong></div>';
  const app = '<div id="app" hidden><header><h1>Keys</h1></header><nav class="tabs"><button>Keys</button></nav></div>';
  const signsIn = { "app.js": "const s = await grain.signIn({ url }); if (gateOf(s, TEAM) === 'open') draw();" };
  // An app that never signs in has nothing to gate.
  assert.deepEqual(warned({ "index.html": "<body><header>Dice</header><main><button>Roll</button></main></body>" }), []);
  // A splash and the rest hidden, or drawn later from an empty mount point: nothing to say.
  assert.deepEqual(warned({ "index.html": `<body>${splash}${app}<div id="toast"></div><script src="app.js"></script></body>`, ...signsIn }), []);
  assert.deepEqual(warned({ "index.html": `<body>${splash}<div id="root"></div><template><p>Keys</p></template></body>`, ...signsIn }), []);
  // The app's UI in the HTML, a skeleton of it (empty boxes in a layout), text or a control: each is warned about.
  for (const [body, what] of [
    ['<header class="head"><div class="sk line"></div></header><div class="tabs"><div class="tab"></div></div>', /<header\.head>, <div\.tabs>/],
    ["<main><p>Your keys</p></main>", /<main>/],
    ["Loading your keys…", /"Loading your keys…"/],
    ["<button>New key</button>", /<button>/],
  ]) {
    const w = warned({ "index.html": `<body>${splash}${body}</body>`, ...signsIn });
    assert.equal(w.length, 1, body);
    assert.ok(w[0].startsWith(`${GATE_RULE}: index.html shows `), w[0]);
    assert.match(w[0], what);
    assert.match(w[0], /data-grain-splash/);
  }
  // No splash marked anywhere: what shows first cannot be told, and the page is told how.
  const none = warned({ "index.html": '<body><div id="root"></div></body>', ...signsIn });
  assert.equal(none.length, 1);
  assert.match(none[0], new RegExp(`^${GATE_RULE}: the app signs in, and no page marks its splash`));
  // Signing in by the bridge's method or grain.login counts; the bridge itself (it names the method) does not.
  assert.equal(warned({ "index.html": "<body><main>x</main></body>", "a.js": 'saltix.request({ method: "grain_login" })' }).length, 2);
  assert.equal(warned({ "index.html": "<body><main>x</main></body>", "a.js": "await grain.login(challenge)" }).length, 2);
  const bridge = readFileSync(fileURLToPath(import.meta.resolve("@saltix/grain")), "utf8");
  assert.deepEqual(warned({ "index.html": "<body><main>x</main></body>", "grain.js": bridge }), []);
  // Read as HTML is written: comments, scripts and styles show nothing; a hidden attribute anywhere in the tag hides.
  assert.deepEqual(shownBeforeSignIn("<!-- <main>x</main> --><body><script>document.write('x')</script><style>p{}</style></body>"), []);
  assert.deepEqual(shownBeforeSignIn('<body><section class="a" hidden data-x="1"><p>x</p></section></body>'), []);
  assert.deepEqual(shownBeforeSignIn('<body><section class="hidden"><p>x</p></section></body>'), ["<section.hidden>"], "a class named hidden hides nothing");
  assert.deepEqual(shownBeforeSignIn('<body><div title="a > b"><span>x</span></div></body>'), ["<div>"]);
});

test("init makes a project the owner alone can sign for", () => {
  const dir = mkdtempSync(join(tmpdir(), "grain-init-"));
  const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  execFileSync("node", [main, "init", join(dir, "dice"), "--name", "Dice"], { stdio: "pipe" });
  for (const f of ["grain.json", "owner.key", "public/index.html", "public/app.js", "public/grain.js", ".gitignore", "AGENTS.md", "CLAUDE.md"]) {
    assert.ok(existsSync(join(dir, "dice", f)), f);
  }
  // Edge to edge (it declares viewport-fit=cover), laid out by the variables Saltix and grain.layout() set, and nothing
  // lint warns about.
  assert.match(readFileSync(join(dir, "dice", "public", "index.html"), "utf8"), /viewport-fit=cover/);
  const html = readFileSync(join(dir, "dice", "public", "index.html"), "utf8");
  for (const v of ["--saltix-safe-top", "--saltix-safe-bottom", "--saltix-safe-left", "--saltix-safe-right", "--saltix-controls-right", "--saltix-controls-width"]) {
    assert.ok(html.includes(`var(${v})`), v);
  }
  assert.match(readFileSync(join(dir, "dice", "public", "app.js"), "utf8"), /grain\.layout\(\)/);
  // Check first, render after: the HTML shows its splash alone; the app and the refusal wait for the gate.
  assert.match(html, /<div class="splash" data-grain-splash>/);
  assert.match(html, /<div id="app" hidden>/);
  assert.deepEqual(shownBeforeSignIn(html), []);
  const js = readFileSync(join(dir, "dice", "public", "app.js"), "utf8");
  for (const words of ["grain.signIn({ url: SIGN_IN })", "gateOf(s, FOR)", 'document.querySelector("[data-grain-splash]").remove()']) assert.ok(js.includes(words), words);
  assert.deepEqual(lintPages(join(dir, "dice", "public")), []);
  const linted = execFileSync("node", [main, "lint"], { cwd: join(dir, "dice"), stdio: "pipe" }).toString();
  assert.ok(!linted.includes(TOP_BAR_RULE), linted);
  // The page's script reads as a module, and the bridge it imports has the layout.
  writeFileSync(join(dir, "app.mjs"), readFileSync(join(dir, "dice", "public", "app.js")));
  execFileSync("node", ["--check", join(dir, "app.mjs")], { stdio: "pipe" });
  assert.match(readFileSync(join(dir, "dice", "public", "grain.js"), "utf8"), /--saltix-controls-height/);
  // The rules a coding agent follows; Claude Code reads them through CLAUDE.md.
  const agents = readFileSync(join(dir, "dice", "AGENTS.md"), "utf8");
  assert.ok(agents.includes(FULL_SCREEN_RULE));
  assert.equal(FULL_SCREEN_RULE, "Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).");
  for (const words of ["--saltix-controls-top", "No close button of your own", "475×751", "light and dark", "viewport-fit=cover", "Safe by default"]) assert.ok(agents.includes(words), words);
  assert.match(readFileSync(join(dir, "dice", "CLAUDE.md"), "utf8"), /^@AGENTS\.md$/m);
  // A bar that ignores them is warned about, and lint still passes.
  writeFileSync(join(dir, "dice", "public", "index.html"),
    '<meta name="viewport" content="width=device-width, viewport-fit=cover"><style>header { position: fixed; top: 0 }</style><header>Dice</header>');
  writeFileSync(join(dir, "dice", "public", "app.js"), "");
  const warned = execFileSync("node", [main, "lint"], { cwd: join(dir, "dice"), stdio: "pipe" }).toString();
  assert.match(warned, new RegExp(`^warning: ${COVER_RULE}: `, "m"));
  assert.match(warned, new RegExp(`^warning: ${TOP_BAR_RULE}: `, "m"));
  assert.match(warned, /ready to register/);
  assert.equal(statSync(join(dir, "dice", "owner.key")).mode & 0o777, 0o600);
  const m = JSON.parse(readFileSync(join(dir, "dice", "grain.json"), "utf8"));
  assert.equal(m.slug, "dice");
  const key = readKey(join(dir, "dice", "owner.key"));
  assert.deepEqual(m.owner_key, { ed25519: toHex(ed25519.getPublicKey(key)) });
  assert.equal(m.owner, toHex(accountId(ed25519.getPublicKey(key))));
  assert.ok(verifyManifest(signedFor(join(dir, "dice", "grain.json"), key)));
  assert.throws(() => execFileSync("node", [main, "init", join(dir, "dice")], { stdio: "pipe" }), "not over an existing grain");
});

test("the wallet's way: a link first, the signed manifest from the registry after", async () => {
  const before = await fakeNode({});
  const link = await walletLink(manifest(), before.url);
  assert.ok(link.startsWith("salt:grain-publish?m="));
  before.close();
  const registered = { slug: "chess", owner: "77".repeat(32), version: 1, retired: null };
  const stale = await fakeNode({ grain: registered });
  await assert.rejects(walletLink(manifest(), stale.url), /raise "version"/);
  stale.close();
  const gone = await fakeNode({ grain: { ...registered, retired: 9 } });
  await assert.rejects(walletLink(manifest({ version: 2 }), gone.url), /never used again/);
  gone.close();
  // The wallet's key in the registry's manifest: the same grain but for its owner.
  const published = {
    manifest: { ...manifest(), owner: "88".repeat(32), owner_key: { p256: "02" + "33".repeat(32) } },
    signature: "44".repeat(64),
  };
  const after = await fakeNode({ grain: { ...registered, owner: "88".repeat(32), manifest: published } });
  assert.deepEqual(await waitForPublished(after.url, manifest(), 1000), published);
  assert.equal(await waitForPublished(after.url, manifest({ version: 2 }), 100), null, "another version is not it");
  after.close();
});

test("a publish link carries the manifest without its owner", () => {
  const m = manifest();
  const link = publishLink(m);
  assert.ok(link.startsWith("salt:grain-publish?m=") && link.length < 500, link);
  assert.equal(toHex(publishLinkManifest(link)), toHex(encodeManifest({ ...m, ...UNOWNED })));
  // Text that does not compress: eight descriptions of 200 scattered CJK characters.
  const scattered = (seed) => Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919 + seed * 104729) % 20000))).join("");
  const huge = manifest({ description: Object.fromEntries(["en", "ru", "de", "fr", "es", "it", "pt", "pl"].map((l, k) => [l, scattered(k)])) });
  assert.throws(() => publishLink(huge), /key file/);
  assert.equal(publishLinkManifest("salt:grain/chess"), null);
});
