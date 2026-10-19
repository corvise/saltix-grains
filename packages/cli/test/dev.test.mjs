// `grain dev`: a clear word when its port is taken, and no serving of a chat-only grain, which has no page.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, fromHex, toHex } from "@saltix/grain-server";
import { serve } from "../dist/dev.js";
import { scratch } from "../../../scripts/scratch.mjs";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const secret = fromHex("62".repeat(32), 32);
const owner = toHex(ed25519.getPublicKey(secret));
const manifest = (entry) => ({
  slug: "dice", version: 1, owner: toHex(accountId(fromHex(owner, 32))), owner_key: { ed25519: owner }, name: { en: "Dice" },
  description: {}, icon: "11".repeat(32), entry, permissions: entry.chat ? 4 : 1, sponsor: null, min_host: 1,
});
const hosted = () => manifest({ hosted: { url: "https://dice.example/", origins: ["https://dice.example"] } });

test("a taken port is said in words, with what to do", async () => {
  const dir = scratch("grain-dev-port-");
  mkdirSync(join(dir, "public"));
  const first = await serve(dir, hosted, secret, 0, "127.0.0.1");
  const port = first.address().port;
  try {
    await assert.rejects(serve(dir, hosted, secret, port, "127.0.0.1"), new RegExp(`port ${port} is taken .*pass --port`));
  } finally {
    first.close();
  }
});

test("grain dev refuses a chat-only grain instead of serving nothing forever", () => {
  const dir = scratch("grain-dev-chat-");
  writeFileSync(join(dir, "grain.json"), JSON.stringify(manifest({ chat: {} })));
  writeFileSync(join(dir, "owner.key"), "62".repeat(32) + "\n", { mode: 0o600 });
  const r = spawnSync("node", [main, "dev", "--port", "0"], { cwd: dir, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.signal, null, "it returned instead of serving");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a chat-only grain has no page to serve: run its chat server \(npm start/);
});

test("grain dev serves the project's connect.json for the simulator's Connect sheet, and the simulator draws it", async () => {
  const dir = scratch("grain-dev-connect-");
  mkdirSync(join(dir, "public"));
  const server = await serve(dir, hosted, secret, 0, "127.0.0.1");
  const url = `http://127.0.0.1:${server.address().port}/_connect.json`;
  try {
    const none = await fetch(url);
    assert.equal(none.status, 404);
    assert.match(await none.text(), /every app ships a Connect profile/);
    const profile = { version: 1, subject: { grain: { slug: "dice" } }, texts: { en: { tagline: "Roll dice", about: "", highlights: [], privacy: "" } } };
    writeFileSync(join(dir, "connect.json"), JSON.stringify(profile));
    const served = await fetch(url);
    assert.equal(served.headers.get("content-type"), "application/json");
    assert.deepEqual(await served.json(), profile);
  } finally {
    server.close();
  }
  // The simulator's bundle holds the sheet: its title, its rows' words, and where it reads the profile.
  const { readFileSync } = await import("node:fs");
  const bundle = readFileSync(new URL("../dist/simulator/dist/simulator.js", import.meta.url), "utf8");
  for (const words of ["Saltix Connect", "In its own words", "To continue, sign in", "It can follow your activity on the blockchain: balances, transfers, names.", "/_connect.json"]) {
    assert.ok(bundle.includes(words), words);
  }
  assert.match(readFileSync(new URL("../dist/simulator/index.html", import.meta.url), "utf8"), /id="connect-first" checked/);
});

const sealedOf = (connect) => manifest({ sealed: { bundle: "22".repeat(32), size: 10, sources: ["https://cdn.dice.example/b.zip"], start: "index.html", connect } });

test("grain dev keeps a development registry: the simulator's team and members, and a node's interface for the app's server", async () => {
  const dir = scratch("grain-dev-registry-");
  mkdirSync(join(dir, "public"));
  const server = await serve(dir, hosted, secret, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (method, params = {}) => (await (await fetch(`${base}/api/dev/rpc`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })).json()).result;
  try {
    const dev = await (await fetch(`${base}/api/dev`)).json();
    assert.equal(dev.chain.network, "devnet");
    assert.match(dev.chain.genesis, /^[0-9a-f]{64}$/);
    assert.deepEqual(dev.servers, []);
    assert.deepEqual(dev.access, { owner: toHex(accountId(fromHex(owner, 32))), public: true, members: [] });
    // The simulator's account joins a private app as a developer: its sign-ins carry a member proof.
    const member = "aa".repeat(32);
    const set = await (await fetch(`${base}/api/dev/access`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public: false, members: [member, "not hex", dev.access.owner] }),
    })).json();
    assert.deepEqual(set.access, { public: false, members: [{ account: member, roles: 3 }] });
    // The app's own server reads the same registry at /api/dev/rpc, as it reads a node's.
    assert.equal((await rpc("node_status")).genesis, dev.chain.genesis);
    const g = (await rpc("grain_get", { slug: "dice" })).grain;
    assert.equal(g.public, false);
    assert.deepEqual(g.members, [{ account: member, roles: 3 }]);
    assert.equal(g.owner, dev.access.owner);
    assert.equal((await rpc("grain_get", { slug: "other" })).grain, null);
  } finally {
    server.close();
  }
  // From a developer key, the registry is its network's and names its key, so a server started from it runs against it.
  const { AppKey } = await import("@saltix/grain-server");
  const appKey = AppKey.of("devnet", "5c".repeat(32), "dice", fromHex("63".repeat(32), 32));
  const keyed = await serve(dir, hosted, secret, 0, "127.0.0.1", { appKey });
  try {
    const dev = await (await fetch(`http://127.0.0.1:${keyed.address().port}/api/dev`)).json();
    // A developer key names its genesis by a prefix: the registry's starts with it, so the key is for it.
    assert.match(dev.chain.genesis, /^(5c){8}[0-9a-f]{48}$/);
    assert.ok(appKey.isFor(dev.chain.network, dev.chain.genesis));
    assert.deepEqual(dev.servers, [appKey.publicKey]);
  } finally {
    keyed.close();
  }
});

test("a sealed grain's pages carry Saltix's Content-Security-Policy; a hosted grain's are the page's own", async () => {
  const { sealedCsp } = await import("@saltix/grain/rules");
  const dir = scratch("grain-dev-csp-");
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Dice</title>");
  const sealedServer = await serve(dir, () => sealedOf(["https://api.dice.example"]), secret, 0, "127.0.0.1");
  const hostedServer = await serve(dir, hosted, secret, 0, "127.0.0.1");
  try {
    const page = await fetch(`http://127.0.0.1:${sealedServer.address().port}/index.html`);
    assert.equal(page.headers.get("content-security-policy"), sealedCsp(["https://api.dice.example"]));
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    const own = await fetch(`http://127.0.0.1:${hostedServer.address().port}/index.html`);
    assert.equal(own.headers.get("content-security-policy"), null);
  } finally {
    sealedServer.close();
    hostedServer.close();
  }
});

test("a sealed grain's start page is where the simulator opens it, and the icon grain.json names is at /_icon.png", async () => {
  const { devPageUrl } = await import("@saltix/grain/rules");
  const { iconHash } = await import("@saltix/grain-server");
  const { readFileSync } = await import("node:fs");
  const vectors = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
  const icon = Buffer.from(vectors.images.find((i) => i.kind === "grain_icon" && i.width === 512).hex, "hex");
  const dir = scratch("grain-dev-sealed-");
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Dice</title><p>the page</p>");
  let named = "00".repeat(32);
  const m = () => ({ ...sealedOf([]), icon: named });
  const server = await serve(dir, m, secret, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // As the simulator does: the manifest, then the page its entry names.
    const manifestUrl = `${base}/.well-known/saltix-grain`;
    const signed = await (await fetch(manifestUrl)).json();
    const page = await fetch(devPageUrl(signed.manifest.entry, manifestUrl));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /the page/);
    assert.equal((await fetch(new URL("index.html", manifestUrl))).status, 404, "never beside the manifest");
    // No icon named: none served (the sheet draws the monogram); a file whose hash grain.json names: served.
    writeFileSync(join(dir, "icon.png"), icon);
    assert.equal((await fetch(`${base}/_icon.png`)).status, 404);
    named = iconHash(new Uint8Array(icon));
    const served = await fetch(`${base}/_icon.png`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), icon);
    named = "11".repeat(32);
    assert.equal((await fetch(`${base}/_icon.png`)).status, 404, "another icon than the file here");
  } finally {
    server.close();
  }
  // The simulator draws it: the sheet and the splash ask for it, in the rounded square.
  const bundle = readFileSync(new URL("../dist/simulator/dist/simulator.js", import.meta.url), "utf8");
  assert.ok(bundle.includes("/_icon.png") && bundle.includes("app-icon"));
  assert.match(readFileSync(new URL("../dist/simulator/index.html", import.meta.url), "utf8"), /\.app-icon \{[^}]*border-radius: 26%/);
});

test("grain dev logs that it serves, and what form, to the steps' log", async () => {
  const { spawn } = await import("node:child_process");
  const { readFileSync, existsSync } = await import("node:fs");
  const dir = scratch("grain-dev-log-");
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Dice</title>");
  writeFileSync(join(dir, "grain.json"), JSON.stringify(hosted()));
  writeFileSync(join(dir, "owner.key"), "62".repeat(32) + "\n", { mode: 0o600 });
  const child = spawn("node", [main, "dev", "--port", "0"], { cwd: dir });
  try {
    const log = join(dir, ".grain", "log.jsonl");
    const end = Date.now() + 10_000;
    while (!(existsSync(log) && readFileSync(log, "utf8").includes('"serve"'))) {
      if (Date.now() > end) throw new Error("no serve step");
      await new Promise((r) => setTimeout(r, 50));
    }
    const line = JSON.parse(readFileSync(log, "utf8").trim().split("\n").find((l) => l.includes('"serve"')));
    assert.deepEqual([line.command, line.step, line.outcome, line.reason], ["dev", "serve", "ok", "page"]);
  } finally {
    child.kill();
  }
});
