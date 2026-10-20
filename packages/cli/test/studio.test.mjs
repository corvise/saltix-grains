// The app studio from the command line: configure, access, rate and bind, signed with a key file and refused before a
// node would refuse them, or done in Saltix and waited for; the deposit a registration sends; developer keys shown
// without their secret.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { AppKey, accountId, encodeAddress, toHex, fromHex, signManifest, verifyServerKeyProof } from "@saltix/grain-server";
import { publish } from "../dist/registry.js";
import { accessCall, bindCall, configureCall, membersOf, rateCall, readAppKey, serverKeyArgOf, serverKeyOf, waitForRegistry, describeAppKey } from "../dist/studio.js";
import { sendSettled } from "../dist/send.js";
import { scratch } from "../../../scripts/scratch.mjs";

/** Send `call` once the pool takes it (`--no-wait`). */
const sendCall = (call, secret, s) => sendSettled(async () => call, secret, s, { wait: false });

const secret = fromHex("61".repeat(32), 32);
const owner = toHex(ed25519.getPublicKey(secret));
const ownerId = toHex(accountId(fromHex(owner, 32)));
const server = toHex(ed25519.getPublicKey(fromHex("63".repeat(32), 32)));
const GENESIS = "5a".repeat(32);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** A node that answers the wallet interface from `state` and records what was submitted. */
async function fakeNode(state) {
  const submitted = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const result = {
        node_status: {
          genesis: GENESIS, slot: state.slot ?? 1000, network: "testnet", beacon: { height: 1, hash: "b1" },
          ...(state.protocol ? { protocol: state.protocol, epoch_slots: state.epochSlots ?? 100 } : {}),
        },
        account_get: { nonce: 4, salt: state.salt ?? "200000000000", controller: null, shard: "" },
        grain_get: { grain: state.grain === undefined ? null : state.grain, ...(state.noQuote ? {} : { deposit: state.deposit ?? "10000000000" }) },
        handle_get: { handle: state.handle ?? null },
        transaction_submit: { id: "ab".repeat(32) },
      }[method];
      if (method === "transaction_submit") submitted.push(params.transaction);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}`, submitted, state, close: () => http.close() };
}

const signing = (node) => ({ node, validFor: 600 });
const callTag = (hex) => fromHex(hex)[58];
const amountOf = (hex) => {
  // The amount is the action's last u64, before the proof's tag (1) and signature (64).
  const b = fromHex(hex);
  return new DataView(b.buffer, b.length - 65 - 8, 8).getBigUint64(0, true);
};
const grain = (over = {}) => ({ slug: "chess-bot", owner: ownerId, version: 1, retired: null, servers: [], category: 0, public: true, members: [], ...over });

test("a registration sends the deposit the node quotes for the slug", async () => {
  const chat = signManifest({
    slug: "chess-bot", version: 1, owner: ownerId, owner_key: { ed25519: owner }, name: { en: "Chess coach" }, description: {},
    icon: "11".repeat(32), entry: { chat: {} }, permissions: 4, sponsor: null, min_host: 1,
  }, secret);
  const node = await fakeNode({ deposit: "10000000000" });
  const sent = await publish(chat, secret, signing(node.url));
  assert.equal(sent.call, "register");
  assert.equal(sent.amount, 10_000_000_000n);
  assert.equal(amountOf(node.submitted[0]), 10_000_000_000n);
  node.close();
  // A node from before deposits by length quotes nothing: 100 SALT, as it takes.
  const old = await fakeNode({ noQuote: true });
  assert.equal((await publish(chat, secret, signing(old.url))).amount, 100_000_000_000n);
  assert.equal(amountOf(old.submitted[0]), 100_000_000_000n);
  old.close();
  const poor = await fakeNode({ salt: "9000000000", deposit: "10000000000" });
  await assert.rejects(publish(chat, secret, signing(poor.url)), /needs 10000/);
  assert.equal(poor.submitted.length, 0);
  poor.close();
});

test("configure names the server keys and the category, the owner's live grain only", async () => {
  const node = await fakeNode({ grain: grain({ category: 4 }) });
  const call = await configureCall(node.url, "chess-bot", [server], undefined, secret);
  assert.deepEqual(call, { configure: { slug: "chess-bot", servers: [server], category: 4 } }, "the category stays without --category");
  const { sent } = await sendCall(call, secret, signing(node.url));
  assert.equal(sent.call, "configure");
  assert.equal(callTag(node.submitted[0]), 34);
  assert.deepEqual((await configureCall(node.url, "chess-bot", [], "games", secret)).configure, { slug: "chess-bot", servers: [], category: 4 });
  await assert.rejects(configureCall(node.url, "chess-bot", [server], "toys", secret), /category/);
  await assert.rejects(configureCall(node.url, "chess-bot", [server, server], "1", secret), /servers/);
  await assert.rejects(configureCall(node.url, "chess-bot", ["00".repeat(32)], "1", secret), /servers/);
  node.state.grain = grain({ owner: "99".repeat(32) });
  await assert.rejects(configureCall(node.url, "chess-bot", [server], "1", secret), /another owner/);
  node.state.grain = grain({ retired: 7 });
  await assert.rejects(configureCall(node.url, "chess-bot", [server], "1", secret), /retired/);
  node.state.grain = null;
  await assert.rejects(configureCall(node.url, "chess-bot", [server], "1", secret), /not registered/);
  node.state.grain = { slug: "chess-bot", owner: ownerId, version: 1, retired: null };
  await assert.rejects(configureCall(node.url, "chess-bot", [server], "1", secret), /predates the app studio/);
  assert.equal(node.submitted.length, 1);
  node.close();
  // A server key from its key file.
  const dir = scratch("configure-");
  writeFileSync(join(dir, "server.key"), "63".repeat(32) + "\n", { mode: 0o600 });
  assert.equal(serverKeyOf(join(dir, "server.key")), server);
  assert.equal(serverKeyOf(server.toUpperCase()), server);
  assert.throws(() => serverKeyOf("00".repeat(32)), /not a valid/);
});

test("from protocol version 2 configure names each key with its proof, which its key file signs; version 1 bare keys", async () => {
  // 24-app-studio §2, 23-upgrades §6a: tag 39 with ServerKeyProof { key, proof } over (genesis, slug, owner) once the
  // network runs version 2; tag 34 before.
  const dir = scratch("configure-v2-");
  writeFileSync(join(dir, "server.key"), "63".repeat(32) + "\n", { mode: 0o600 });
  const file = serverKeyArgOf(join(dir, "server.key"));
  assert.equal(file.key, server);
  assert.equal(toHex(file.secret), "63".repeat(32));
  assert.equal(serverKeyArgOf(server).secret, null, "a bare key in hex has no secret");
  const node = await fakeNode({ grain: grain({ category: 4 }), protocol: { version: 2, supported: [1, 2], next: null, outdated: null } });
  const call = await configureCall(node.url, "chess-bot", [file], undefined, secret);
  assert.deepEqual(Object.keys(call), ["configureProven"]);
  const [proven] = call.configureProven.servers;
  assert.equal(proven.key, server);
  assert.ok(verifyServerKeyProof(server, proven.proof, GENESIS, "chess-bot", ownerId), "the key's proof for this app and owner");
  assert.ok(!verifyServerKeyProof(server, proven.proof, GENESIS, "chess-bot", "99".repeat(32)), "for this owner only");
  const { sent } = await sendCall(call, secret, signing(node.url));
  assert.equal(sent.call, "configure");
  assert.equal(callTag(node.submitted[0]), 39);
  // A bare key cannot be proven here: refused before anything is signed, pointing to its key file or grain pair.
  await assert.rejects(configureCall(node.url, "chess-bot", [server], undefined, secret), /proof, which its key file signs.*grain pair/);
  await assert.rejects(configureCall(node.url, "chess-bot", [file, file], undefined, secret), /servers/, "checked before a proof is signed");
  // No key revokes every key, in version 2's form too.
  assert.deepEqual(await configureCall(node.url, "chess-bot", [], "games", secret), { configureProven: { slug: "chess-bot", servers: [], category: 4 } });
  // A node left behind saw a block of version 2: the network runs it.
  node.state.protocol = { version: 1, supported: [1], next: null, outdated: { version: 2, chain: "beacon", height: 9, slot: 990 } };
  assert.ok("configureProven" in (await configureCall(node.url, "chess-bot", [file], undefined, secret)));
  // Version 1: bare keys (tag 34), a key file's included.
  node.state.protocol = { version: 1, supported: [1, 2], next: null, outdated: null };
  assert.deepEqual(await configureCall(node.url, "chess-bot", [file], undefined, secret), { configure: { slug: "chess-bot", servers: [server], category: 4 } });
  assert.equal(node.submitted.length, 1);
  node.close();
});

test("version 1's form is sent valid only until the scheduled switch to version 2, and not at all just before it", async () => {
  // Version 2 at epoch 20 of 100 slots: its first slot is 2000. A transaction of tag 34 valid past it would wait in a
  // pool into blocks that refuse it.
  const node = await fakeNode({ grain: grain({ category: 4 }), protocol: { version: 1, supported: [1, 2], next: { version: 2, epoch: 20 }, outdated: null }, slot: 1000 });
  const v1 = await configureCall(node.url, "chess-bot", [server], undefined, secret);
  const { sent } = await sendCall(v1, secret, signing(node.url));
  assert.equal(sent.validUntil, 1600, "the whole window when it ends before the switch");
  node.state.slot = 1500;
  assert.equal((await sendCall(v1, secret, signing(node.url))).sent.validUntil, 1999, "cut at the slot before the switch");
  node.state.slot = 1975;
  await assert.rejects(sendCall(v1, secret, signing(node.url)), /moves to protocol version 2 at slot 2000, in 25 slots/);
  // Version 2's form is refused while the network runs version 1.
  const v2 = { configureProven: { slug: "chess-bot", servers: [], category: 4 } };
  await assert.rejects(sendCall(v2, secret, signing(node.url)), /runs protocol version 1; this call is protocol version 2's/);
  node.state.protocol = { version: 2, supported: [1, 2], next: null, outdated: null };
  await assert.rejects(sendCall(v1, secret, signing(node.url)), /no longer takes this form/);
  assert.equal(node.submitted.length, 2);
  node.close();
});

test("from protocol version 2 the owner's Saltix names a key of this computer by its pairing, never by hand", async () => {
  const node = await fakeNode({ grain: grain({ servers: [server] }), protocol: { version: 2, supported: [1, 2], next: null, outdated: null } });
  const dir = scratch("configure-wallet-v2-");
  writeFileSync(join(dir, "server.key"), "63".repeat(32) + "\n", { mode: 0o600 });
  const out = await run(["configure", "--slug", "chess-bot", "--server", "server.key", "--node", node.url, "--timeout", "1"], dir);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /protocol version 2: the owner's Saltix names a server key with its proof, which comes with its pairing: run grain pair --slug chess-bot/);
  assert.doesNotMatch(out.stdout, /My apps → chess-bot → Developer key/);
  // Revoking every key needs no proof: Saltix does it.
  const revoke = await run(["configure", "--slug", "chess-bot", "--revoke-all", "--node", node.url, "--timeout", "1"], dir);
  assert.match(revoke.stdout, /My apps → chess-bot → Developer key: revoke every developer key/);
  assert.equal(node.submitted.length, 0);
  node.close();
});

test("access makes the grain private with its members; rate and bind are refused as the registry would", async () => {
  const node = await fakeNode({ grain: grain() });
  const member = toHex(accountId(fromHex("44".repeat(32), 32)));
  const members = membersOf([`${encodeAddress("testnet", fromHex(member, 32))}:user+developer`, `${"46".repeat(32)}:viewer`]);
  assert.deepEqual(members, [{ account: member, roles: 3 }, { account: "46".repeat(32), roles: 4 }]);
  assert.throws(() => membersOf(["tsalt1xyz:user"]), /address/);
  assert.throws(() => membersOf([`${member}:owner`]), /roles/);
  assert.throws(() => membersOf([member]), /<address>:<roles>/);
  const call = await accessCall(node.url, "chess-bot", false, members, secret);
  await sendCall(call, secret, signing(node.url));
  assert.equal(callTag(node.submitted[0]), 36);
  await assert.rejects(accessCall(node.url, "chess-bot", false, [{ account: ownerId, roles: 1 }], secret), /not the owner/);
  await assert.rejects(accessCall(node.url, "chess-bot", false, [members[0], members[0]], secret), /none twice/);

  const rater = fromHex("65".repeat(32), 32);
  const rate = await rateCall(node.url, "chess-bot", 5, "Лучшие шахматы", rater);
  await sendCall(rate, rater, signing(node.url));
  assert.equal(callTag(node.submitted[1]), 37);
  await assert.rejects(rateCall(node.url, "chess-bot", 5, "", secret), /own grain/);
  await assert.rejects(rateCall(node.url, "chess-bot", 6, "", rater), /score/);
  await assert.rejects(rateCall(node.url, "chess-bot", 5, "x".repeat(141), rater), /review/);
  node.state.grain = grain({ retired: 9 });
  await assert.rejects(rateCall(node.url, "chess-bot", 4, "", rater), /withdrawn/);
  assert.ok(await rateCall(node.url, "chess-bot", 0, "", rater), "a withdrawal on a retired grain");

  node.state.grain = grain();
  node.state.handle = { owner: ownerId, app: null, display: "@chess_coach" };
  const bind = await bindCall(node.url, "@Chess_Coach", "chess-bot", secret);
  assert.deepEqual(bind, { bind: { handle: { name: "chess_coach" }, slug: "chess-bot" } });
  await sendCall(bind, secret, signing(node.url));
  assert.equal(callTag(node.submitted[2]), 35);
  await assert.rejects(bindCall(node.url, "@chess_coach", null, secret), /opens no app/);
  node.state.handle = { owner: "99".repeat(32), app: null, display: "@chess_coach" };
  await assert.rejects(bindCall(node.url, "@chess_coach", "chess-bot", secret), /not this account's/);
  await assert.rejects(bindCall(node.url, "@chess__coach", "chess-bot", secret), /not a name/);
  assert.equal(node.submitted.length, 3);
  node.close();
});

test("without a key file, the tool says what to do in Saltix and waits for the registry", async () => {
  const node = await fakeNode({ grain: grain() });
  const call = { configure: { slug: "chess-bot", servers: [server], category: 4 } };
  assert.equal(await waitForRegistry(node.url, call, 0), false, "not yet");
  node.state.grain = grain({ servers: [server], category: 4 });
  assert.equal(await waitForRegistry(node.url, call, 1_000, 10), true);
  const dir = scratch("wallet-way-");
  node.state.grain = grain();
  // The owner does it in Saltix while the tool waits.
  const later = setTimeout(() => (node.state.grain = grain({ servers: [server], category: 4 })), 500);
  const out = await run(["configure", "--slug", "chess-bot", "--server", server, "--category", "games", "--node", node.url, "--timeout", "5"], dir);
  clearTimeout(later);
  assert.match(out.stdout, /My apps → chess-bot → Developer key/);
  assert.match(out.stdout, /the registry has it/);
  assert.equal(node.submitted.length, 0, "nothing signed here");
  // Asked again with the registry holding it so: nothing to change, nothing asked of the owner.
  const again = await run(["configure", "--slug", "chess-bot", "--server", server, "--category", "games", "--node", node.url, "--timeout", "1"], dir);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^nothing to change: the registry names these server keys and category games for chess-bot already; nothing signed or sent$/m);
  assert.doesNotMatch(again.stdout, /My apps/);
  const none = await run(["configure", "--slug", "chess-bot", "--node", node.url], dir);
  assert.match(none.stderr, /--revoke-all/, "no keys only on purpose");
  node.close();
});

test("a key file signs an owner's call only for an app it owns, or when --key names it; else the owner's Saltix, the owner said first", async () => {
  const theirs = "77".repeat(32);
  const node = await fakeNode({ grain: grain({ owner: theirs }) });
  const dir = scratch("owner-calls-");
  writeFileSync(join(dir, "owner.key"), toHex(secret) + "\n", { mode: 0o600 });
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "chess-bot" }));
  // owner.key here, the app another account's (made in Saltix): its Saltix is asked, nothing signed here.
  const asked = await run(["access", "--slug", "chess-bot", "--private", "--node", node.url, "--timeout", "1"], dir);
  assert.match(asked.stdout, /^owner: tsalt1\S+, as the registry names it: its Saltix signs \(owner\.key here is another account's\)$/m);
  assert.match(asked.stdout, /In the owner's Saltix: My apps → chess-bot → make it private/);
  // --key naming it: refused before anything is signed.
  const named = await run(["access", "--slug", "chess-bot", "--public", "--key", "owner.key", "--node", node.url], dir);
  assert.equal(named.code, 1);
  assert.match(named.stderr, /chess-bot: the registry names another owner \(7{64}\) than owner\.key's account/);
  // --wallet and --key at once: a misuse.
  assert.equal((await run(["access", "--slug", "chess-bot", "--public", "--key", "owner.key", "--wallet", "--node", node.url], dir)).code, 2);
  // Its own app: owner.key signs without --key, and says so.
  node.state.grain = grain();
  const own = await run(["access", "--slug", "chess-bot", "--private", "--node", node.url, "--no-wait"], dir);
  assert.equal(own.code, 0, own.stderr);
  assert.match(own.stdout, /^owner: tsalt1\S+, owner\.key's account on this computer, which the registry names as the owner$/m);
  assert.match(own.stdout, /access: transaction (ab){32} \(fee 0\.\d+ SALT\)/);
  // Kept for grain doctor (the project's own app), until a command sees it land.
  const kept = JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8"));
  assert.deepEqual([kept.slug, kept.sent.map((t) => [t.call, t.id, t.access])], ["chess-bot", [["access", "ab".repeat(32), { public: false, members: [] }]]]);
  // Already so: nothing to change, nothing signed or sent.
  const same = await run(["access", "--slug", "chess-bot", "--public", "--node", node.url], dir);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /^nothing to change: chess-bot is public with no members already, as asked; nothing signed or sent$/m);
  // A slug nobody registered: said, never a call built for it.
  node.state.grain = null;
  const none = await run(["access", "--slug", "chess-bot", "--public", "--node", node.url], dir);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /chess-bot: not registered yet \(grain publish registers an app/);
  assert.equal(node.submitted.length, 1);
  const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
  assert.match(log, /"step":"signer","outcome":"ok","reason":"wallet_not_owner"/);
  assert.match(log, /"step":"signer","outcome":"ok","reason":"key_owns"/);
  node.close();
});

const run = (args, cwd, env = {}, input) => new Promise((resolve) => {
  const child = execFile("node", [main, ...args], { cwd, env: { ...process.env, SALTIX_APP_KEY: "", ...env } }, (error, stdout, stderr) => {
    resolve({ code: error ? error.code : 0, stdout, stderr });
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
});

test("a developer key's public parts, never its secret, and never from the command line", async () => {
  const code = "saltix-app:1:tsalt:5a5a5a5a5a5a5a5a:chess:" + "63".repeat(32);
  const dir = scratch("app-key-");
  const shown = await run(["app-key", "--offline"], dir, { SALTIX_APP_KEY: code });
  assert.equal(shown.code, 0);
  const parts = JSON.parse(shown.stdout);
  assert.deepEqual(parts, { network: "testnet", hrp: "tsalt", genesis: "5a".repeat(8), slug: "chess", publicKey: server, address: AppKey.parse(code).address });
  assert.ok(!shown.stdout.includes("63".repeat(32)) && !shown.stderr.includes("63".repeat(32)));
  const piped = await run(["app-key", "--offline"], dir, {}, `${code}\n`);
  assert.equal(JSON.parse(piped.stdout).publicKey, server, "from stdin");
  writeFileSync(join(dir, "app.key"), code + "\n", { mode: 0o600 });
  assert.equal(JSON.parse((await run(["app-key", "--offline", "--file", "app.key"], dir)).stdout).slug, "chess");
  const argument = await run(["app-key", code], dir);
  assert.notEqual(argument.code, 0);
  assert.match(argument.stderr, /never put a developer key on the command line/);
  assert.ok(!argument.stderr.includes("63".repeat(32)), "the refusal does not repeat it");
  const bad = await run(["app-key", "--offline"], dir, { SALTIX_APP_KEY: code.toUpperCase() });
  assert.match(bad.stderr, /not a developer key/);
  assert.ok(!bad.stderr.includes("63".repeat(32)));
  assert.throws(() => readAppKey(undefined, {}), /SALTIX_APP_KEY/);

  // With the registry: whether it names the key.
  const node = await fakeNode({ grain: grain({ slug: "chess", servers: [server] }) });
  const named = JSON.parse((await run(["app-key", "--node", node.url], dir, { SALTIX_APP_KEY: code })).stdout);
  assert.equal(named.registered, true);
  node.state.grain = grain({ slug: "chess", servers: [] });
  const revoked = await run(["app-key", "--node", node.url], dir, { SALTIX_APP_KEY: code });
  assert.equal(revoked.code, 1);
  assert.match(JSON.parse(revoked.stdout).why, /revoked/);
  const other = await describeAppKey(AppKey.parse(code.replace(":5a5a5a5a5a5a5a5a:", ":6f6f6f6f6f6f6f6f:")), { call: async (m) => (m === "node_status" ? { network: "testnet", genesis: GENESIS } : null) });
  assert.match(other.why, /reset/);
  node.close();
});

test("app-key make writes the developer key owner-only, and says when the registry does not name it yet", async () => {
  const dir = scratch("app-key-make-");
  writeFileSync(join(dir, "server.key"), "63".repeat(32) + "\n", { mode: 0o600 });
  const node = await fakeNode({ grain: grain({ slug: "chess", servers: [] }) });
  const made = await run(["app-key", "make", "--slug", "chess", "--node", node.url], dir);
  assert.equal(made.code, 0, made.stderr);
  assert.ok(!made.stdout.includes("63".repeat(32)), "not on the terminal");
  assert.match(made.stdout, /grain configure --slug chess --server/);
  assert.equal(statSync(join(dir, "app.key")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "app.key"), "utf8").trim(), "saltix-app:1:tsalt:5a5a5a5a5a5a5a5a:chess:" + "63".repeat(32));
  const again = await run(["app-key", "make", "--slug", "chess", "--node", node.url], dir);
  assert.match(again.stderr, /exists already/);
  node.close();
  assert.ok(existsSync(join(dir, "app.key")));
});

test("init --chat makes a chat-only grain with a spec to build on", async () => {
  const dir = join(scratch("grain-chat-init-"), "coach");
  const made = await run(["init", dir, "--name", "Coach", "--chat"], tmpdir());
  assert.equal(made.code, 0, made.stderr);
  const m = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
  assert.deepEqual(m.entry, { chat: {} });
  assert.equal(m.permissions, 4);
  assert.ok(!existsSync(join(dir, "public")));
  const lint = await run(["lint"], dir);
  assert.match(lint.stdout, /coach v1: no errors; not published yet; left: grain publish .*; rewrite connect\.json for this app/);
  const spec = JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"));
  assert.equal(spec.slug, "coach");
  assert.ok(readFileSync(join(dir, ".gitignore"), "utf8").includes("app.key"));
  // The rules a coding agent follows, for a chat-only app too: Claude Code reads them through CLAUDE.md.
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md)."));
  assert.match(agents, /chat-only app/);
  assert.match(agents, /grain chat-spec/);
  assert.ok(!agents.includes("grain dev`: serves"), "no page to serve");
  assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /^@AGENTS\.md$/m);
});
