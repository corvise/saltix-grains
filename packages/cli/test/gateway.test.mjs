// The command line without a node: registry commands and the faucet go through relays' gateways (Saltix 09-relay
// §10.7), each trusted by the certificate its relay record pins; --node stays for your own node. A relay here is an
// HTTPS server with a self-signed certificate answering POST /rpc, as a relay's client port does.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, encodeAddress, fromHex, toHex, PUBLIC_RELAYS, RelayGateways } from "@saltix/grain-server";
import { reachOf, relayOf } from "../dist/network.js";
import { UsageError } from "../dist/args.js";

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
  const dir = mkdtempSync(join(tmpdir(), "grain-gateway-"));
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
  const dir = mkdtempSync(join(tmpdir(), "grain-net-"));
  writeFileSync(join(dir, "owner.key"), toHex(secret) + "\n", { mode: 0o600 });
  return dir;
};

test("a command goes to a relay's gateway trusted by its pin; another certificate is sent nothing", tls, async (t) => {
  const g = await gateway({ grain: { slug: "chess", owner: ownerId, version: 2, retired: null, servers: [] } });
  t.after(() => g.close());
  const dir = project();
  const shown = await grain(["show", "--slug", "chess", "--relay", g.relay], dir);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).version, 2);
  assert.deepEqual(g.asked.map((a) => `${a.path} ${a.method}`), ["POST /rpc grain_get"]);
  g.asked.length = 0;
  const wrong = await grain(["show", "--slug", "chess", "--relay", `${g.url}#${"ab".repeat(32)}`], dir);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /certificate does not match the relay record/);
  assert.deepEqual(g.asked, [], "a relay that shows another certificate is sent nothing");
  // An owner's call, signed with the key file and submitted through the gateway.
  const server = toHex(ed25519.getPublicKey(fromHex("63".repeat(32), 32)));
  const configured = await grain(["configure", "--slug", "chess", "--server", server, "--relay", g.relay], dir);
  assert.equal(configured.code, 0, configured.stderr);
  assert.match(configured.stdout, new RegExp(`configure: transaction ${"ab".repeat(32)}`));
  assert.deepEqual(g.asked.map((a) => a.method), ["grain_get", "node_status", "account_get", "transaction_submit"]);
});

test("grain faucet asks for test SALT for the key file's account, says a refusal in words, and waits when asked", tls, async (t) => {
  const g = await gateway({ salt: 0n });
  t.after(() => g.close());
  const dir = project();
  const got = await grain(["faucet", "--wait", "--timeout", "10", "--relay", g.relay], dir);
  assert.equal(got.code, 0, got.stderr);
  assert.match(got.stdout, new RegExp(`100 SALT to ${address} \\(transaction ${"fa".repeat(32)}\\), and 500 WORK`));
  assert.match(got.stdout, /it is in the account/);
  assert.deepEqual(g.asked.find((a) => a.method === "faucet_request").params, { address });
  // Refused: once every 5 minutes.
  g.state.answer = (method) => method === "faucet_request" ? { error: { code: 3, message: "too_soon", data: { retry_after: 240 } } } : null;
  const soon = await grain(["faucet", "--relay", g.relay], dir);
  assert.equal(soon.code, 1);
  assert.match(soon.stderr, new RegExp(`the faucet paid ${address} less than 5 minutes ago: try again in 240 s`));
  // An address of another network, and no key file nor address.
  const other = await grain(["faucet", "--address", encodeAddress("testnet", accountId(ed25519.getPublicKey(secret))), "--relay", g.relay], dir);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /an address of testnet, and the network answering is devnet/);
  const keyless = await grain(["faucet", "--relay", g.relay], mkdtempSync(join(tmpdir(), "grain-empty-")));
  assert.equal(keyless.code, 1);
  assert.match(keyless.stderr, /owner\.key/);
});

test("a node without a faucet passes the request on to another relay's node", tls, async (t) => {
  const none = await gateway({ answer: (m) => (m === "faucet_request" ? { error: { code: 3, message: "no_faucet", data: { retry_after: null } } } : null) });
  const other = await gateway({});
  t.after(() => { none.close(); other.close(); });
  const got = await grain(["faucet", "--relay", none.relay, "--relay", other.relay], project());
  assert.equal(got.code, 0, got.stderr);
  assert.ok(none.asked.some((a) => a.method === "faucet_request") && other.asked.some((a) => a.method === "faucet_request"));
  const alone = await grain(["faucet", "--relay", none.relay], project());
  assert.equal(alone.code, 1);
  assert.match(alone.stderr, /no node within reach runs a faucet/);
});

test("where a command goes: the test network's public relays by default, relays named, or your node; never two", () => {
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
  assert.ok(byDefault.node instanceof RelayGateways);
  assert.deepEqual(byDefault.node.endpoints, PUBLIC_RELAYS.devnet.map((e) => ({ ...e, cert_sha256: e.cert_sha256.toLowerCase() })));
  assert.equal(byDefault.flags, "", "nothing to repeat for the default");
  assert.equal(byDefault.where, "the test network's public relays");
  const node = reachOf(...flags([["node", "http://127.0.0.1:30334"]]));
  assert.deepEqual([node.node, node.flags], ["http://127.0.0.1:30334", " --node http://127.0.0.1:30334"]);
  const pin = "Ab".repeat(32);
  const named = reachOf(...flags([["relay", `wss://10.0.0.1:30335/#${pin}`], ["relay", `wss://10.0.0.2:30335/#${pin}`]]));
  assert.deepEqual(named.node.endpoints.map((e) => e.cert_sha256), ["ab".repeat(32), "ab".repeat(32)], "pins in lower case");
  const usage = (pairs, pattern) => assert.throws(() => reachOf(...flags(pairs)), (e) => e instanceof UsageError && pattern.test(e.message));
  usage([["node", "http://n"], ["relay", `wss://10.0.0.1:30335/#${pin}`]], /one of them/);
  usage([["node", "http://n"], ["network", "devnet"]], /one of them/);
  usage([["network", "mainnet"]], /no public relays are known for mainnet/);
  usage([["network", "moon"]], /--network moon: mainnet, testnet, devnet/);
  usage([["node", true]], /--node URL/);
  for (const bad of ["wss://10.0.0.1:30335/", `ws://10.0.0.1:30335/#${pin}`, "wss://10.0.0.1/#abc", `https://x/#${pin}`]) {
    assert.throws(() => relayOf(bad), /--relay/, bad);
  }
  // A developer key's own network: its relays unless told.
  assert.throws(() => reachOf(...flags([]), "mainnet"), /no public relays are known for mainnet/);
});

test("refusals of the command line come before the network: exit 2", async () => {
  const dir = project();
  for (const [args, pattern] of [
    [["faucet", "--network", "mainnet"], /no public relays are known for mainnet/],
    [["show", "--slug", "x", "--relay", "wss://10.0.0.1:30335/"], /SHA-256 of its certificate/],
    [["show", "--slug", "x", "--node", "http://127.0.0.1:1", "--network", "devnet"], /one of them/],
  ]) {
    const r = await grain(args, dir);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, pattern);
  }
});
