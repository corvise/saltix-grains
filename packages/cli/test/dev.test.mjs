// `grain dev`: a clear word when its port is taken, and no serving of a chat-only grain, which has no page.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, fromHex, toHex } from "@saltix/grain-server";
import { serve } from "../dist/dev.js";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const secret = fromHex("62".repeat(32), 32);
const owner = toHex(ed25519.getPublicKey(secret));
const manifest = (entry) => ({
  slug: "dice", version: 1, owner: toHex(accountId(fromHex(owner, 32))), owner_key: { ed25519: owner }, name: { en: "Dice" },
  description: {}, icon: "11".repeat(32), entry, permissions: entry.chat ? 4 : 1, sponsor: null, min_host: 1,
});
const hosted = () => manifest({ hosted: { url: "https://dice.example/", origins: ["https://dice.example"] } });

test("a taken port is said in words, with what to do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grain-dev-port-"));
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
  const dir = mkdtempSync(join(tmpdir(), "grain-dev-chat-"));
  writeFileSync(join(dir, "grain.json"), JSON.stringify(manifest({ chat: {} })));
  writeFileSync(join(dir, "owner.key"), "62".repeat(32) + "\n", { mode: 0o600 });
  const r = spawnSync("node", [main, "dev", "--port", "0"], { cwd: dir, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.signal, null, "it returned instead of serving");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a chat-only grain has no page to serve: run its chat server \(npm start/);
});
