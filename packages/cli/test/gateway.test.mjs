// The command line without a node: registry commands and the faucet go through relays' gateways (Saltix 09-relay
// §10.7), each trusted by the certificate its relay record pins; --node stays for your own node. A relay here is an
// HTTPS server with a self-signed certificate answering POST /rpc, as a relay's client port does.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, encodeAddress, fromHex, toHex, GivenRelayRefused, RelayGateways, signRelayTicket } from "@saltix/grain-server";
import { reachOf, relayOf } from "../dist/network.js";
import { UsageError } from "../dist/args.js";
import { scratch } from "../../../scripts/scratch.mjs";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const GENESIS = "5a".repeat(32);
const secret = fromHex("61".repeat(32), 32);
const ownerId = toHex(accountId(ed25519.getPublicKey(secret)));
const address = encodeAddress("devnet", accountId(ed25519.getPublicKey(secret)));

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const tls = { skip: !hasOpenssl() && "no openssl" };

/** A relay's gateway: the wallet interface from `state` over TLS with a certificate of its own, and what it was asked. */
async function gateway(state) {
  const dir = scratch("grain-gateway-");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=relay",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "pipe" });
  const pin = createHash("sha256").update(execFileSync("openssl", ["x509", "-in", join(dir, "cert.pem"), "-outform", "DER"])).digest("hex");
  const asked = [];
  const https = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      asked.push({ path: `${req.method} ${req.url}`, method, params });
      const answer = state.answer?.(method, params);
      if (answer) return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...answer }));
      const result = {
        node_status: { network: "devnet", genesis: GENESIS, slot: 1000, beacon: { height: 1, hash: "b1" } },
        account_get: { nonce: 4, salt: String(state.salt ?? 200_000_000_000n), work: "0", channels: [], controller: null, shard: "" },
        grain_get: { grain: state.grain ?? null, deposit: "10000000000" },
        relay_list: { relays: state.relays ?? [] },
        transaction_submit: { id: "ab".repeat(32) },
        faucet_request: { id: "fa".repeat(32), amount: "100000000000", work: { id: "fb".repeat(32), amount: "500000000" } },
      }[method];
      if (method === "faucet_request") state.salt = (state.salt ?? 0n) + 100_000_000_000n;
      res.end(JSON.stringify(result === undefined
        ? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not served here" } }
        : { jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => https.listen(0, "127.0.0.1", r));
  const url = `wss://127.0.0.1:${https.address().port}/`;
  return { url, pin, relay: `${url}#${pin}`, asked, state, close: () => https.close() };
}

/** `grain <args>` in `cwd`: its exit code and output. */
const grain = (args, cwd) => new Promise((resolve) => {
  execFile("node", [main, ...args], { cwd, timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

const project = () => {
  const dir = scratch("grain-net-");
  writeFileSync(join(dir, "owner.key"), toHex(secret) + "\n", { mode: 0o600 });
  return dir;
};

test("a command goes to a relay's gateway trusted by its pin; another certificate is sent nothing", tls, async (t) => {
  const g = await gateway({ grain: { slug: "chess", owner: ownerId, version: 2, retired: null, servers: [] } });
  t.after(() => g.close());
  const dir = project();
  const shown = await grain(["show", "--slug", "chess", "--relay", g.relay], dir);
  assert.equal(shown.code, 0, shown.stderr);
  // A line in words first: the network it is on, and its version and access; the record as JSON with --json alone.
  assert.match(shown.stdout.split("\n")[0], /^chess on devnet [0-9a-f]{16}: v2, public$/);
  // The relay named is probed first — alone, it is asked for no tickets, which no other relay could confirm (41-transport
  // §18.5) —, then the command's own calls; never relay_list.
  assert.deepEqual(g.asked.map((a) => `${a.path} ${a.method}`), ["POST /rpc node_status", "POST /rpc node_status", "POST /rpc grain_get"]);
  const json = await grain(["show", "--slug", "chess", "--json", "--relay", g.relay], dir);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).version, 2);
  // A free slug: the deposit registering it keeps, in words, and exit 0: the question was answered.
  const empty = await gateway({});
  t.after(() => empty.close());
  const free = await grain(["show", "--slug", "chess", "--relay", empty.relay], dir);
  assert.equal(free.code, 0, free.stderr);
  assert.match(free.stdout, /^chess is free on devnet 5a5a5a5a5a5a5a5a: registering it keeps a deposit of 10 SALT until it retires/);
  assert.doesNotMatch(free.stdout, /^null$/m);
  g.asked.length = 0;
  const wrong = await grain(["show", "--slug", "chess", "--relay", `${g.url}#${"ab".repeat(32)}`], dir);
  assert.equal(wrong.code, 1);
  // Said with what was tried and the way out (41-transport §18.5), never a bare error.
  assert.match(wrong.stderr, /no relay of devnet answered \(1 tried/);
  assert.match(wrong.stderr, /relay cert:abababab \(given\): showed another certificate than its pin/);
  assert.ok(!wrong.stderr.includes("127.0.0.1"), "the relay named by its pin's fingerprint, never its address");
  assert.deepEqual(g.asked, [], "a relay that shows another certificate is sent nothing");
  // An owner's call, signed with the key file (the app is its account's) and submitted through the gateway; the owner
  // said first.
  const server = toHex(ed25519.getPublicKey(fromHex("63".repeat(32), 32)));
  const configured = await grain(["configure", "--slug", "chess", "--server", server, "--relay", g.relay], dir);
  assert.equal(configured.code, 0, configured.stderr);
  assert.match(configured.stdout, /^owner: dsalt1\S+, owner\.key's account on this computer, which the registry names as the owner$/m);
  assert.match(configured.stdout, new RegExp(`configure: transaction ${"ab".repeat(32)} \\(fee [0-9.]+ SALT\\)`));
  // The registry and the network's protocol version read again before signing (a call that changes nothing is never
  // sent; its form is the version's); then it waits for the call to land: this gateway's node says nothing of
  // transactions, so it stops there.
  assert.deepEqual(g.asked.map((a) => a.method), ["node_status",
    "grain_get", "node_status", "grain_get", "node_status", "grain_get", "node_status", "account_get", "transaction_submit", "transaction_get"]);
});

test("grain faucet asks for test SALT for the key file's account, says a refusal in words, and waits when asked", tls, async (t) => {
  const g = await gateway({ salt: 0n });
  t.after(() => g.close());
  const dir = project();
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "chess" }));
  const got = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dir);
  assert.equal(got.code, 0, got.stderr);
  assert.match(got.stdout, new RegExp(`100 SALT to ${address} \\(transaction ${"fa".repeat(32)}\\), and 500 WORK`));
  assert.match(got.stdout, /it is in the account/);
  // Its steps in the project's log, with the network it reached: never the address.
  const logged = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
  for (const [step, outcome, reason] of [["grant", "ok", "sent"], ["wait", "ok", "landed"]]) {
    assert.match(logged, new RegExp(`"command":"faucet","step":"${step}","outcome":"${outcome}","reason":"${reason}","ms":\\d+,"network":"devnet"`));
  }
  assert.ok(!logged.includes("dsalt1"), "no address in the log");
  assert.deepEqual(g.asked.find((a) => a.method === "faucet_request").params, { address });
  // Refused: an address waits the faucet's interval (an hour on the test network since 2026-11-05); the wait in words.
  g.state.answer = (method) => method === "faucet_request" ? { error: { code: 3, message: "too_soon", data: { retry_after: 2_400 } } } : null;
  const soon = await grain(["faucet", "--relay", g.relay], dir);
  assert.equal(soon.code, 1);
  assert.match(soon.stderr, new RegExp(`the faucet paid ${address} lately: try again in 40 minutes`));
  // An address of another network, and no key file nor address.
  const other = await grain(["faucet", "--address", encodeAddress("testnet", accountId(ed25519.getPublicKey(secret))), "--relay", g.relay], dir);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /an address of testnet, and the network answering is devnet/);
  const keyless = await grain(["faucet", "--relay", g.relay], scratch("grain-empty-"));
  assert.equal(keyless.code, 1);
  assert.match(keyless.stderr, /owner\.key/);
});

test("grain faucet --wait in a project grants until the key file's account can pay the first publish: the grants the deposit takes, the faucet's interval apart", tls, async (t) => {
  // A faucet of 10 SALT a grant, one a second here (five minutes on a network), as node_status tells it; the registry
  // asks a deposit of 10 SALT for the slug, so the deposit and the fees take two grants (the owner's run of 2026-11-05:
  // one grant left the account 5 640 base units short of its first publish, and the next was refused for five minutes).
  const faucet = (st) => (method) => {
    if (method === "node_status") return { result: { network: "devnet", genesis: GENESIS, slot: 1000, beacon: { height: 1, hash: "b1" }, faucet: { amount: st.amount, work: "0", every: st.every } } };
    if (method === "grain_get") return { result: { grain: st.grain ?? null, deposit: st.deposit } };
    if (method === "faucet_request") {
      if (st.soon > 0) {
        st.soon -= 1;
        return { error: { code: 3, message: "too_soon", data: { retry_after: 1 } } };
      }
      st.salt += BigInt(st.amount);
      return { result: { id: "fa".repeat(32), amount: st.amount, work: null } };
    }
    return null;
  };
  const st = { salt: 0n, deposit: "10000000000", every: 1, soon: 0, amount: "10000000000" };
  st.answer = faucet(st);
  const g = await gateway(st);
  t.after(() => g.close());
  const dir = project();
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "chessboard" }));
  const two = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dir);
  assert.equal(two.code, 0, two.stderr);
  assert.match(two.stdout, /^chessboard's first publish needs 10\.001 SALT more \(a deposit of 10 SALT for a slug of 10 characters, and the fees\): 2 grants of 10 SALT, 1 s apart$/m);
  assert.match(two.stdout, new RegExp(`^grant 1 of 2: the faucet sent 10 SALT to ${address} \\(transaction ${"fa".repeat(32)}\\), through the relays named \\(1\\)$`, "m"));
  assert.match(two.stdout, /^the faucet pays an address once every 1 s: the next grant \(2 of 2\) in 1 s$/m);
  assert.match(two.stdout, /^grant 2 of 2: the faucet sent 10 SALT/m);
  assert.match(two.stdout, /^owner\.key's account holds 20 SALT: enough for chessboard's first publish \(a deposit of 10 SALT and the fees\) → grain publish --key owner\.key --relay /m);
  assert.equal(g.asked.filter((a) => a.method === "faucet_request").length, 2, "two grants asked, no more");
  const logged = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
  assert.match(logged, /"command":"faucet","step":"interval","outcome":"ok","reason":"faucet_window","seconds":1,"grant":2,"grants":2,"ms":\d+/);
  assert.ok(!logged.includes("dsalt1"), "no address in the log");
  // Enough already: no grant is asked for, the way on is said.
  g.asked.length = 0;
  const enough = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dir);
  assert.equal(enough.code, 0, enough.stderr);
  assert.match(enough.stdout, /^owner\.key's account holds 20 SALT: enough for chessboard's first publish/m);
  assert.equal(g.asked.filter((a) => a.method === "faucet_request").length, 0, "nothing granted to an account that can pay");
  // A refusal by the faucet's clock on the second grant (its window measured from its own answer): waited out once.
  st.salt = 0n;
  st.soon = 0;
  const dirSoon = project();
  writeFileSync(join(dirSoon, "grain.json"), JSON.stringify({ slug: "chessboard" }));
  g.asked.length = 0;
  const soonAfterFirst = (method) => {
    const answer = faucet(st)(method);
    if (method === "faucet_request" && answer.result && st.salt === 10_000_000_000n && st.soon === 0 && !st.refusedOnce) {
      st.soon = 1; // The next request (the second grant) is too soon by the faucet's clock, once.
      st.refusedOnce = true;
    }
    return answer;
  };
  st.answer = soonAfterFirst;
  const waited = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dirSoon);
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, new RegExp(`^the faucet paid ${address} lately: try again in 1 s: waiting$`, "m"));
  assert.match(waited.stdout, /^grant 2 of 2: the faucet sent 10 SALT/m);
  assert.equal(g.asked.filter((a) => a.method === "faucet_request").length, 3, "the refused request, then the grant again");
  st.answer = faucet(st);
  // A deposit the faucet's grants would take an hour to gather is said up front, and nothing is asked for.
  st.salt = 0n;
  st.deposit = "100000000000";
  st.every = 300;
  const dirShort = project();
  writeFileSync(join(dirShort, "grain.json"), JSON.stringify({ slug: "chess" }));
  g.asked.length = 0;
  const hour = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dirShort);
  assert.equal(hour.code, 1);
  assert.match(hour.stderr, /chess's first publish needs 100\.001 SALT more \(a deposit of 100 SALT for a slug of 5 characters, and the fees\): 11 grants of 10 SALT, 5 minutes apart, 50 minutes of waiting — a slug of 8 characters or more keeps a deposit of 10 SALT, one of 6–7 keeps 30; or grain publish without --key: the owner's Saltix pays the deposit from its QR code/);
  assert.equal(g.asked.filter((a) => a.method === "faucet_request").length, 0, "no grant before the truth is told");
  // The test network's own terms (3 SALT once an hour, 2026-11-05): a deposit of 10 SALT is 4 grants, an afternoon —
  // said as the grants come, each run ending with the clock time to run it again; the command never sleeps an hour.
  st.deposit = "10000000000";
  st.every = 3_600;
  st.amount = "3000000000";
  const dirHour = project();
  writeFileSync(join(dirHour, "grain.json"), JSON.stringify({ slug: "chessboard" }));
  g.asked.length = 0;
  const hourly = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dirHour);
  assert.equal(hourly.code, 0, hourly.stderr);
  assert.match(hourly.stdout, /^chessboard's first publish needs 10\.001 SALT more \(a deposit of 10 SALT for a slug of 10 characters, and the fees\): 4 grants of 3 SALT, an hour apart$/m);
  assert.match(hourly.stdout, /^grant 1 of 4: the faucet sent 3 SALT/m);
  assert.match(hourly.stdout, /^the faucet pays an address once every an hour: 3 more grants to go — run grain faucet --wait --relay \S+ again after \d\d:\d\d UTC \(7\.001 SALT still needed\)$/m);
  assert.equal(g.asked.filter((a) => a.method === "faucet_request").length, 1, "one grant a run");
  const hourlySteps = readFileSync(join(dirHour, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(hourlySteps.some((l) => l.step === "interval" && l.outcome === "waiting" && l.reason === "come_back"), JSON.stringify(hourlySteps));
  st.every = 300;
  st.amount = "10000000000";
  // A slug the registry names already has no first publish to pay for: a plain grant, as without a project.
  st.deposit = "10000000000";
  st.grain = { slug: "chessboard", owner: "00".repeat(32), version: 1, retired: null };
  g.asked.length = 0;
  const plain = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dir);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /^the faucet sent 10 SALT to /m);
  assert.match(plain.stdout, /^it is in the account$/m);
  assert.ok(!plain.stdout.includes("first publish"), "no goal for a registered app");
  assert.equal(g.asked.filter((a) => a.method === "faucet_request").length, 1);
});

test("a node without a faucet passes the request on to another relay's node", tls, async (t) => {
  const none = await gateway({ answer: (m) => (m === "faucet_request" ? { error: { code: 3, message: "no_faucet", data: { retry_after: null } } } : null) });
  const other = await gateway({});
  t.after(() => { none.close(); other.close(); });
  const got = await grain(["faucet", "--relay", none.relay, "--relay", other.relay], project());
  assert.equal(got.code, 0, got.stderr);
  // Whichever answered its probe first is asked first: the request reaches the node that runs a faucet either way.
  assert.ok(other.asked.some((a) => a.method === "faucet_request"), "the node with a faucet was asked");
  const alone = await grain(["faucet", "--relay", none.relay], project());
  assert.equal(alone.code, 1);
  assert.match(alone.stderr, /no node within reach runs a faucet/);
});

test("where a command goes: the relays it finds by default, relays named, or your node; never two", () => {
  const flags = (pairs) => {
    const m = new Map();
    const all = {};
    for (const [k, v] of pairs) {
      m.set(k, v);
      (all[k] ??= []).push(v);
    }
    return [m, (k) => all[k] ?? []];
  };
  const byDefault = reachOf(...flags([]));
  assert.ok(byDefault.node instanceof RelayGateways && byDefault.node.finds, "found when the command runs");
  assert.equal(byDefault.gateways, byDefault.node);
  assert.equal(byDefault.flags, "", "nothing to repeat for the default");
  assert.equal(byDefault.where, "the test network's relays");
  assert.equal(byDefault.release, "devnet", "the relays this release finds: its network's genesis is what a command is held to");
  const node = reachOf(...flags([["node", "http://127.0.0.1:30334"]]));
  assert.deepEqual([node.node, node.flags, node.gateways], ["http://127.0.0.1:30334", " --node http://127.0.0.1:30334", undefined]);
  assert.equal(node.release, undefined, "a node is whatever network its owner runs");
  const pin = "Ab".repeat(32);
  const named = reachOf(...flags([["relay", `wss://10.0.0.1:30335/#${pin}`], ["relay", `wss://10.0.0.2:30335/#${pin}`]]));
  assert.ok(named.node instanceof RelayGateways && named.node.finds);
  assert.equal(named.where, "the relays named (2)", "relays of one's own alone: a private network's");
  assert.equal(named.release, undefined);
  assert.equal(relayOf(`wss://10.0.0.1:30335/#${pin}`), `wss://10.0.0.1:30335/#${"ab".repeat(32)}`, "pins in lower case");
  // A ticket is taken as every reader takes it, in either case, past its life too (the finder leaves it out with a
  // warning when it runs); a refused one says why, and is a configuration to fix (78).
  const ticket = signRelayTicket({ secret: fromHex("71".repeat(32), 32), genesis: GENESIS, endpoints: [{ url: "wss://192.0.2.7:30335/", cert_sha256: "7c".repeat(32) }], issuedAt: Date.now() });
  assert.equal(relayOf(ticket.toLowerCase()), ticket);
  // A person's ticket goes first, with the project's cache and the release's entry points still tried.
  const ticketed = reachOf(...flags([["relay", ticket]]));
  assert.ok(ticketed.node instanceof RelayGateways && ticketed.node.finds);
  assert.equal(ticketed.where, "the test network's relays (and the tickets given, 1)");
  assert.equal(ticketed.release, "devnet", "a ticket goes first, and the release's relays are still tried");
  assert.equal(ticketed.flags, ` --relay ${ticket}`);
  const old = signRelayTicket({ secret: fromHex("71".repeat(32), 32), genesis: GENESIS, endpoints: [{ url: "wss://192.0.2.7:30335/", cert_sha256: "7c".repeat(32) }], issuedAt: Date.now() - 40 * 86_400_000 });
  assert.equal(relayOf(old), old);
  assert.throws(() => relayOf(ticket.slice(0, -8)), (e) => e instanceof GivenRelayRefused && /relay ticket refused/.test(e.message));
  assert.equal(relayOf("wss://relay.example.net/"), "wss://relay.example.net/", "a name behind a CA's certificate");
  const usage = (pairs, pattern) => assert.throws(() => reachOf(...flags(pairs)), (e) => e instanceof UsageError && pattern.test(e.message));
  usage([["node", "http://n"], ["relay", `wss://10.0.0.1:30335/#${pin}`]], /one of them/);
  usage([["node", "http://n"], ["network", "devnet"]], /one of them/);
  usage([["network", "mainnet"]], /no relay is known for mainnet/);
  usage([["network", "moon"]], /--network moon: mainnet, testnet, devnet/);
  usage([["node", true]], /--node URL/);
  for (const bad of ["wss://10.0.0.1:30335/", `ws://10.0.0.1:30335/#${pin}`, "wss://10.0.0.1/#abc", `https://x/#${pin}`]) {
    assert.throws(() => relayOf(bad), (e) => e instanceof GivenRelayRefused && e.reason === "form", bad);
  }
  // A developer key's own network: its relays unless told.
  assert.throws(() => reachOf(...flags([]), "mainnet"), /no relay is known for mainnet/);
});

test("refusals of the command line come before the network: exit 2, and 78 for a relay given that cannot be one", async () => {
  const dir = project();
  for (const [args, pattern] of [
    [["faucet", "--network", "mainnet"], /no relay is known for mainnet/],
    [["show", "--slug", "x", "--node", "http://127.0.0.1:1", "--network", "devnet"], /one of them/],
  ]) {
    const r = await grain(args, dir);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, pattern);
  }
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "x", entry: { chat: {} } }));
  const relay = await grain(["show", "--slug", "x", "--relay", "wss://10.0.0.1:30335/"], dir);
  assert.equal(relay.code, 78, relay.stderr);
  assert.match(relay.stderr, /relay 1 given: neither a relay ticket .*SHA-256 of its certificate/);
  assert.match(readFileSync(join(dir, ".grain", "log.jsonl"), "utf8"), /"reason":"relay_given_form"/);
});

test("grain doctor says where its relays came from, which answered and how fast, and when none did, each one and why", tls, async (t) => {
  const g = await gateway({});
  t.after(() => g.close());
  const dir = project();
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "chess", entry: { chat: {} } }));
  const text = await grain(["doctor", "--relay", g.relay], dir);
  const line = text.stdout.split("\n").find((l) => / relays /.test(l));
  assert.match(line ?? "", /^ok {3}relays {10}1 of 1 answered, \d+ ms \(given 1\)$/, text.stdout);
  // The command's log: where the relays came from and the counts, never a relay's address.
  const logged = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
  assert.match(logged, /"step":"relays","outcome":"ok","reason":"none","given":1,"cache":0,"entry":0,"discovered":0,"tried":1,"answered":1,"tickets":0,"refused":0,"unconfirmed":0,"took_ms":\d+,"fastest_ms":\d+,"ms":\d+/);
  assert.ok(!logged.includes("127.0.0.1"), "no relay's address in the log");
  const doctorJson = await grain(["doctor", "--json", "--relay", g.relay], dir);
  const json = JSON.parse(doctorJson.stdout);
  assert.equal(json.relays.sources.given, 1);
  assert.equal(json.relays.discovery, "none");
  assert.deepEqual(json.relays.tried.map((r) => [r.relay, r.source, r.ok]), [[`cert:${g.pin.slice(0, 8)}`, "given", true]]);
  assert.deepEqual(json.relays.answered, [], "the tickets of the relays that answered: a relay named by its endpoint gave none");
  assert.ok(!JSON.stringify(json.relays).includes("127.0.0.1"), "nor in doctor's report of the relays (its next commands repeat the --relay given)");
  // A relay that is not there: the finding names it by its pin's fingerprint and why, and the way out.
  const dead = await grain(["doctor", "--relay", `wss://127.0.0.1:1/#${"ab".repeat(32)}`], dir);
  assert.equal(dead.code, 1);
  assert.match(dead.stdout, /^fix  relays {10}none of 1 answered \(given 1\): relay cert:abababab refused the connection → a relay ticket from a computer whose SDK reaches the network \(grain doctor --json there prints them: relays\.answered\): grain doctor --relay \S+ --relay SALARIUM-RELAY:… /m);
  assert.match(dead.stdout, /^fix  key {13}not checked: no relay to ask the network through \(relays, above\)$/m, "said once, by the relays' finding");
  const finding = dead.stdout.split("\n").find((l) => l.startsWith("fix  relays")).split(" → ")[0];
  assert.ok(!finding.includes("127.0.0.1"), "what it says of the relay names no address (the next command repeats the --relay given)");
});

test("the relays' finding in doctor's words, from a finder's report", async () => {
  const { relaysFinding } = await import("../dist/status.js");
  const report = (tried, more = {}) => ({
    network: "devnet", genesis: GENESIS, cache: ".grain/relays.json", sources: { given: 0, cache: 2, entry: 3, discovered: 5 },
    tried, discovery: "tickets", tickets: { taken: 6, refused: { signature: 1, unconfirmed: 2 } }, warnings: [], took_ms: 812, at: 0, kept: 2,
    answered: [], ...more,
  });
  const ok = relaysFinding(report([{ relay: "key:1a2b3c4d", source: "cache", ok: true, ms: 41, error: null },
    { relay: "key:5e6f7a8b", source: "discovered", ok: true, ms: 230, error: null },
    { relay: "cert:9c0d1e2f", source: "entry", ok: false, ms: null, error: "no answer within 5 s" }]));
  assert.deepEqual(ok, {
    ok: true, what: "relays",
    detail: "2 of 3 answered, 41 to 230 ms (cache 2, entry points 3; tickets: 6 taken, 5 new relays; tickets refused: 1 signature, 2 unconfirmed); kept 2 in .grain/relays.json",
  });
  assert.match(relaysFinding(report([{ relay: "cert:9c0d1e2f", source: "entry", ok: true, ms: 41, error: null }], { kept: 0 })).detail,
    /kept 0 in \.grain\/relays\.json \(entry points never are\)$/, "only entry points answered: nothing to keep");
  const none = relaysFinding(report([{ relay: "cert:9c0d1e2f", source: "entry", ok: false, ms: null, error: "no answer within 5 s" }],
    { discovery: "none", tickets: { taken: 0, refused: {} }, sources: { given: 0, cache: 0, entry: 1, discovered: 0 },
      warnings: ["the ticket given for relay key:77777777 is left out: relay ticket refused: past its life of 30 days: ask whoever gave it for a new one (expired)"] }),
    " --network devnet");
  assert.equal(none.ok, false);
  assert.equal(none.detail, "none of 1 answered (entry points 1): relay cert:9c0d1e2f no answer within 5 s");
  assert.equal(none.next, "a relay ticket from a computer whose SDK reaches the network (grain doctor --json there prints them: relays.answered): " +
    "grain doctor --network devnet --relay SALARIUM-RELAY:… (or --node URL, a node of your own)");
  assert.match(none.warning, /key:77777777 is left out: .*a new one/, "a ticket given and left out, said beside");
});

test("every entry point showing another certificate: doctor and status say the release is behind the network, and to update", async () => {
  const { keyState, relaysFinding } = await import("../dist/status.js");
  const { NoRelayAnswered, updateAdvice } = await import("@saltix/grain-server");
  const other = "showed another certificate than its pin (not this relay, or it was replaced)";
  const entry = (n, more = {}) => ({ relay: `cert:0000000${n}`, source: "entry", ok: false, ms: null, error: other, cause: "pin", ...more });
  const report = (tried, sources = { given: 0, cache: 0, entry: 3, discovered: 0 }) => ({
    network: "devnet", genesis: null, cache: ".grain/relays.json", sources, tried, discovery: "none", tickets: { taken: 0, refused: {} },
    warnings: [], took_ms: 310, at: 0, kept: 0, answered: [],
  });
  const behind = report([entry(1), entry(2), entry(3)]);
  assert.deepEqual(relaysFinding(behind, " --network devnet"), {
    ok: false, what: "relays",
    detail: "this release of the SDK is most likely behind the devnet network: every entry point it carries showed another certificate than its pin " +
      "(none of 3 answered; entry points 3)",
    next: `${updateAdvice()}; then grain doctor --network devnet again`,
  });
  assert.match(updateAdvice(), /git pull && npm install && npm run build/, "the update, as a command");
  // One entry point that failed another way: the network may be out of reach, so each relay is named and a ticket is the way out.
  const mixed = relaysFinding(report([entry(1), entry(2), entry(3, { error: "no answer within 5 s", cause: null })]));
  assert.match(mixed.detail, /^none of 3 answered \(entry points 3\): relay cert:00000001 showed another certificate/);
  assert.match(mixed.next, /^a relay ticket from a computer whose SDK reaches the network/);
  // A relay of the cache with another certificate beside them changes nothing: the entry points decide.
  const cached = relaysFinding(report([{ ...entry(9), source: "cache" }, entry(1), entry(2), entry(3)], { given: 0, cache: 1, entry: 3, discovered: 0 }));
  assert.match(cached.detail, /^this release of the SDK is most likely behind the devnet network: .*\(none of 4 answered; cache 1, entry points 3\)$/);
  // Relays given alone, none of the release's: nothing says the release is behind.
  const given = relaysFinding(report([{ ...entry(1), source: "given" }], { given: 1, cache: 0, entry: 0, discovered: 0 }));
  assert.match(given.detail, /^none of 1 answered \(given 1\)/);

  // grain status: never "the network did not answer" — it answered, with relays this release does not know.
  const dir = scratch("grain-behind-");
  writeFileSync(join(dir, "chat.json"), "{}");
  const node = { call: async () => { throw new NoRelayAnswered(behind); } };
  const state = await keyState(dir, node, " --network devnet");
  assert.equal(state.status, "unknown");
  assert.equal(state.detail, "no relay to ask the network through: this release of the SDK is most likely behind the devnet network: every entry point " +
    "it carries showed another certificate than its pin (none of 3 answered; entry points 3)");
  assert.equal(state.next, `${updateAdvice()}; then grain status --network devnet again`);
  // Out of reach for another reason: the relays tried, and the ticket, for the same command.
  const out = await keyState(dir, { call: async () => { throw new NoRelayAnswered(report([entry(1, { error: "refused the connection", cause: null })], { given: 0, cache: 0, entry: 1, discovered: 0 })); } });
  assert.equal(out.detail, "no relay to ask the network through: none of 1 answered (entry points 1): relay cert:00000001 refused the connection");
  assert.match(out.next, /: grain status --relay SALARIUM-RELAY:… \(or --node URL, a node of your own\)$/);
  // Any other failure of the call stays the network's silence.
  const silent = await keyState(dir, { call: async () => { throw new Error("socket hang up"); } });
  assert.equal(silent.detail, "the network did not answer (socket hang up)");
});
