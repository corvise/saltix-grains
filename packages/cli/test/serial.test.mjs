// An account's calls one at a time: each carries the account's nonce (and a profile its revision) from what the node
// holds when it is built, so a command waits until its transaction left the pool and the registry holds what it makes,
// and a call the pool refuses because an earlier one of the account is still pending is built again once that landed.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, decodeSignedProfile, fromHex, toHex } from "@saltix/grain-server";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const secret = fromHex("61".repeat(32), 32);
const ownerId = toHex(accountId(ed25519.getPublicKey(secret)));
const GENESIS = "5a".repeat(32);

/**
 * A node with a pool: a transaction waits there for `polls` reads of its status, then lands — the account's nonce goes
 * up and the registry takes the profile it sets. A second transaction of the nonce of a pending one is refused, as the
 * node's pool refuses it ("a replacement must pay more per byte"), and so is one below the account's nonce.
 */
async function poolNode(polls = 2) {
  const state = { nonce: 4, revision: 5, profile: null, pending: new Map(), submitted: [], refused: 0 };
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const answer = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      const refuse = (message) => {
        state.refused++;
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 2, message } }));
      };
      switch (method) {
        case "node_status": return answer({ genesis: GENESIS, slot: 1000, network: "devnet", beacon: { height: 1, hash: "b1" } });
        case "account_get": return answer({ nonce: state.nonce, salt: "200000000000", controller: null, shard: "" });
        case "grain_get": return answer({ grain: { slug: "dice", owner: ownerId, version: 1, retired: null, servers: [], category: 0, public: true, members: [],
          profile: state.profile, profile_revision: state.revision }, deposit: "10000000000" });
        case "transaction_submit": {
          const tx = fromHex(params.transaction);
          const nonce = Number(new DataView(tx.buffer, tx.byteOffset + 33, 8).getBigUint64(0, true));
          if (nonce < state.nonce) return refuse(`nonce ${nonce} is used already; the account is at ${state.nonce}`);
          if ([...state.pending.values()].some((p) => p.nonce === nonce)) return refuse("a replacement must pay more per byte");
          const id = toHex(crypto.getRandomValues(new Uint8Array(32)));
          state.pending.set(id, { nonce, tx, polls });
          state.submitted.push({ nonce, tx });
          return answer({ id });
        }
        case "transaction_get": {
          const p = state.pending.get(params.id);
          if (!p) return answer({ status: "unknown" });
          if (p.polls-- > 0) return answer({ status: "pending", shard: "" });
          if (!p.landed) {
            p.landed = true;
            state.nonce = Math.max(state.nonce, p.nonce + 1);
            const sent = profileOf(p.tx);
            // The registry takes a revision above the one it holds, and refuses any other.
            if (sent && sent.profile.revision > state.revision) {
              state.revision = sent.profile.revision;
              state.profile = sent;
            }
          }
          return answer({ status: "included", shard: "", block: "cd".repeat(32), height: 9, confirmations: 1 });
        }
        default: return answer(undefined);
      }
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${http.address().port}`, state, close: () => http.close() };
}

/** The signed profile a SetGrainProfile transaction carries (see connect.test.mjs). */
function profileOf(b) {
  if (b[57] !== 1 || b[58] !== 38) return null;
  const slugLength = new DataView(b.buffer, b.byteOffset + 59, 4).getUint32(0, true);
  const at = 63 + slugLength;
  return b[at] === 0 ? null : decodeSignedProfile(b.slice(at + 1, b.length - 8 - 65));
}

/** A project of `grain init` with its owner key. */
function project() {
  const dir = join(mkdtempSync(join(tmpdir(), "grain-serial-")), "dice");
  const made = spawnSync("node", [main, "init", dir, "--slug", "dice", "--name", "Dice roll"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(made.status, 0, made.stderr);
  writeFileSync(join(dir, "owner.key"), "61".repeat(32) + "\n", { mode: 0o600 });
  return dir;
}

const run = (args, cwd) => new Promise((resolve) => {
  const child = spawn("node", [main, ...args], { cwd });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill(), 60_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});

test("two calls in a row: the first returns once the registry has it, so the second goes above it", async () => {
  const dir = project();
  const node = await poolNode();
  try {
    const first = await run(["profile", "--node", node.url], dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /the registry has it/);
    const second = await run(["profile", "--node", node.url], dir);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(node.state.submitted.map((s) => [s.nonce, profileOf(s.tx).profile.revision]), [[4, 6], [5, 7]]);
    assert.equal(node.state.revision, 7, "both landed");
    assert.equal(node.state.refused, 0);
  } finally {
    node.close();
  }
});

test("two calls at once: the one the pool refuses is built again from the registry once the other landed", async () => {
  const dir = project();
  const node = await poolNode(3);
  try {
    const [a, b] = await Promise.all([run(["profile", "--node", node.url], dir), run(["profile", "--node", node.url], dir)]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.ok(node.state.refused >= 1, "one of them met the other's pending transaction");
    const landed = node.state.submitted.map((s) => [s.nonce, profileOf(s.tx).profile.revision]);
    assert.deepEqual(landed, [[4, 6], [5, 7]]);
    assert.equal(node.state.revision, 7);
  } finally {
    node.close();
  }
});

test("--no-wait returns once the pool took it", async () => {
  const dir = project();
  const node = await poolNode(50);
  try {
    const r = await run(["profile", "--node", node.url, "--no-wait"], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /the registry has it/);
    assert.equal(node.state.pending.size, 1);
  } finally {
    node.close();
  }
});
