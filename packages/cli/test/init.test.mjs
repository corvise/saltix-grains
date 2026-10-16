// What `grain init` makes: a slug a registry takes, keys that never reach git, and for a chat-only grain a server that
// starts from a developer key alone and answers its chat — run here against a development relay and a node's registry.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AppKey, RelayClient, chatMessageProblem, chatSpecFromJson, decodeChatFrame, derive, encodeChatFrame, newChatId, signChatRequest, toHex,
} from "@saltix/grain-server";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const sdk = fileURLToPath(new URL("../../server", import.meta.url));
const grain = (args, cwd) => spawnSync("node", [main, ...args], { cwd, encoding: "utf8", timeout: 10_000 });
const GENESIS = "6d".repeat(32);

test("a slug the registry would refuse stops init before anything is made", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "grain-slug-")), "t1");
  mkdirSync(dir);
  const fromDir = grain(["init"], dir);
  assert.equal(fromDir.status, 1);
  assert.match(fromDir.stderr, /the slug "t1" is not one: 3 to 32 of \[a-z0-9-\].*pass --slug/);
  assert.deepEqual(readdirSync(dir), [], "no owner key, no manifest");
  const given = grain(["init", "--slug", "-bad", "--chat"], dir);
  assert.equal(given.status, 1);
  assert.doesNotMatch(given.stderr, /pass --slug/, "the slug given is the one at fault");
  assert.equal(grain(["init", "--slug", "t1x"], dir).status, 0, "a slug of three is one");
});

test("every key file stays out of git, whatever its name", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "grain-ignore-")), "dice");
  assert.equal(grain(["init", dir], tmpdir()).status, 0);
  const ignored = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
  for (const line of ["*.key", "node_modules/", "bundle.zip", "*.store.json", "signed.json"]) assert.ok(ignored.includes(line), line);
  const git = spawnSync("git", ["init", "-q", dir]);
  if (git.status !== 0) return; // no git here: the patterns above say it
  for (const f of ["owner.key", "server.key", "app.key", "sponsor.key", "rater.key", "chat.store.json"]) {
    assert.equal(spawnSync("git", ["-C", dir, "check-ignore", "-q", f]).status, 0, `${f} is ignored`);
  }
  assert.notEqual(spawnSync("git", ["-C", dir, "check-ignore", "-q", "grain.json"]).status, 0, "the manifest is not");
});

/** A node's wallet interface over HTTP: the grain's record names `servers()`, and its relays are `relay`. */
async function fakeNode(relay, slug, servers) {
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const result = {
        node_status: { network: "devnet", genesis: GENESIS, slot: 1, beacon: { height: 1, hash: "b0".repeat(32) }, shards: [] },
        grain_get: {
          grain: params.slug !== slug ? null : {
            slug, owner: "aa".repeat(32), version: 1, id: "11".repeat(32), registered: 1, updated: 1, retired: null, deposit: "0",
            manifest: null, servers: servers(), category: 0, public: true, members: [], handles: [],
            ratings: { count: 0, sum: 0, citizens_count: 0, citizens_sum: 0 },
          },
          deposit: "0",
        },
        account_get: { account: params.address, shard: "", controller: null },
        relay_list: { relays: [{ endpoints: [relay.endpoint()] }] },
      }[method];
      res.end(JSON.stringify(result === undefined
        ? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: method } }
        : { jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}`, close: () => http.close() };
}

/** `node <dir>/server.mjs` (what `npm start` runs) from `cwd` (`dir` itself by default) with `env`; its log lines as they
 *  come, and its exit. */
function start(dir, env, cwd = dir) {
  const child = spawn("node", [join(dir, "server.mjs")], { cwd, env: { ...process.env, SALTIX_APP_KEY: "", SALTIX_APP_KEY_FILE: "", STATE_DIRECTORY: "", ...env } });
  const lines = [];
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
    const parts = out.split("\n");
    out = parts.pop();
    lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const done = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  /** Its exit code, or "running" after 10 s (then it is killed): a server that should have stopped fails the test. */
  const exited = Promise.race([done, new Promise((resolve) => setTimeout(() => resolve("running"), 10_000).unref())])
    .then((code) => { if (code === "running") child.kill("SIGKILL"); return code; });
  return {
    child, lines, exited, stderr: () => err,
    async until(event, ms = 10_000) {
      const end = Date.now() + ms;
      while (!lines.some((l) => l.event === event)) {
        if (Date.now() > end) throw new Error(`no ${event} in ${JSON.stringify(lines)} ${err}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      return lines.find((l) => l.event === event);
    },
  };
}

test("a chat-only grain's server starts from its developer key alone and answers its chat", async (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), "grain-chat-")), "coach");
  const made = grain(["init", dir, "--chat", "--name", "Coach"], tmpdir());
  assert.equal(made.status, 0, made.stderr);
  for (const f of ["grain.json", "chat.json", "server.mjs", "package.json", "README.md", ".gitignore", "owner.key"]) assert.ok(existsSync(join(dir, f)), f);
  assert.match(made.stdout, /My apps → New app, slug coach.*app\.key.*npm install && npm start/s);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node server.mjs");
  assert.equal(pkg.type, "module");
  // The SDK this tool runs with, by its path while it is not on npm.
  const dep = pkg.dependencies["@saltix/grain-server"];
  assert.match(dep, /^file:/);
  assert.equal(readFileSync(join(dir, dep.slice(5), "package.json"), "utf8"), readFileSync(join(sdk, "package.json"), "utf8"));
  // What npm install makes of it, without the network.
  mkdirSync(join(dir, "node_modules", "@saltix"), { recursive: true });
  symlinkSync(sdk, join(dir, "node_modules", "@saltix", "grain-server"));

  const relay = await createDevRelay();
  const secret = new Uint8Array(32).fill(0x5e);
  const key = AppKey.of("devnet", GENESIS, "coach", secret);
  let servers = [key.publicKey];
  const node = await fakeNode(relay, "coach", () => servers);
  t.after(async () => { node.close(); await relay.close(); });

  // No key at all, or one readable by others: it says so and stops.
  const none = start(dir, { NODE_RPC: node.url });
  assert.equal(await none.exited, 1);
  assert.match((await none.until("not_started")).error, /no developer key/);
  // The key in the environment, as a secret store hands it over.
  const viaEnv = start(dir, { NODE_RPC: node.url, SALTIX_APP_KEY: key.reveal() });
  assert.equal((await viaEnv.until("ready")).address, key.address);
  viaEnv.child.kill("SIGTERM");
  assert.equal(await viaEnv.exited, 0);
  writeFileSync(join(dir, "app.key"), key.reveal() + "\n");
  chmodSync(join(dir, "app.key"), 0o644);
  const open = start(dir, { NODE_RPC: node.url });
  assert.equal(await open.exited, 1);
  assert.match((await open.until("not_started")).error, /readable by others/);
  chmodSync(join(dir, "app.key"), 0o600);

  // As a supervisor runs it: started elsewhere, the key in a credential file, its state in a directory of its own.
  const elsewhere = mkdtempSync(join(tmpdir(), "grain-run-"));
  const state = mkdtempSync(join(tmpdir(), "grain-state-"));
  writeFileSync(join(elsewhere, "credential"), key.reveal(), { mode: 0o600 });
  const server = start(dir, { NODE_RPC: node.url, SALTIX_APP_KEY_FILE: join(elsewhere, "credential"), STATE_DIRECTORY: state }, elsewhere);
  t.after(() => server.child.kill());
  const ready = await server.until("ready");
  // Above the spec of version 1 Saltix signs when it makes an app: a wallet takes only a higher one.
  assert.deepEqual([ready.slug, ready.address, ready.network, ready.spec], ["coach", key.address, "devnet", 2]);

  // A wallet: the user's grain key in the app, a request for hello, the signed card it gets.
  const user = new Uint8Array(32).fill(7);
  const wallet = await RelayClient.connect({
    endpoints: [relay.endpoint()], secret: user, messagingSecret: derive("Saltix grain messaging key v1", user, new TextEncoder().encode("coach")),
    network: "devnet", log: () => {},
  });
  t.after(() => wallet.close());
  const answered = new Promise((resolve) => wallet.on("frame", ({ payload }) => {
    const frame = decodeChatFrame(payload);
    if (frame.message) resolve(frame.message);
  }));
  const now = Date.now();
  const request = signChatRequest({
    slug: "coach", id: newChatId(), at: now, expires_at: now + 86_400_000, via: null, command: "hello", args: [["name", { text: "Ann" }]],
    text: "", member: null, lang: "en",
  }, user, GENESIS);
  await wallet.send(key.address, encodeChatFrame({ request }), { keep: true });
  const message = await answered;
  assert.deepEqual(message.message.blocks[0], { text: { text: "Hello, Ann!" } });
  assert.equal(message.message.answers, request.request.id);
  const spec = chatSpecFromJson(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8")));
  const ownerKey = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).owner_key;
  assert.equal(chatMessageProblem(message, {
    chain: { genesis: GENESIS, network: "devnet" }, ownerKey, servers, spec, from: key.address, now: Date.now(),
  }), null, "a wallet shows it, verified");
  server.child.kill("SIGTERM");
  assert.equal(await server.exited, 0);
  assert.ok(existsSync(join(state, "chat.store.json")), "the store is in the state directory");
  assert.ok(!existsSync(join(elsewhere, "chat.store.json")) && !existsSync(join(dir, "chat.store.json")));

  // A key the registry does not name: 78, which a supervisor does not restart on. The log never holds the key.
  servers = ["ab".repeat(32)];
  const dead = start(dir, { NODE_RPC: node.url });
  assert.equal(await dead.exited, 78);
  assert.match((await dead.until("not_started")).error, /does not name this server key/);
  const everything = JSON.stringify([none.lines, viaEnv.lines, open.lines, server.lines, dead.lines]) +
    [none, viaEnv, open, server, dead].map((p) => p.stderr()).join("");
  assert.ok(!everything.includes(toHex(secret)), "no secret in the log");
});
