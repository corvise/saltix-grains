// What the README says of the tools holds: every command of the help is in its table, and the development server
// reads a node where a node listens by default.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const help = spawnSync("node", [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "help"], { encoding: "utf8" }).stdout;

test("the README's table names every command the help lists", () => {
  const commands = [...new Set([...help.matchAll(/^ {2}grain ([a-z-]+)/gm)].map((m) => m[1]))].filter((c) => c !== "help");
  assert.ok(commands.length >= 15, commands.join(" "));
  const row = read("README.md").split("\n").find((l) => l.startsWith("| [`@saltix/grain-cli`]"));
  for (const c of commands) assert.ok(row.includes(`\`${c}\``), `the README's table lacks ${c}`);
});

test("npm run dev reads a node at a node's own default port, as the README says", () => {
  // 08-node §5: `--rpc` listens on 127.0.0.1:30334 unless told otherwise.
  const dev = /process\.env\.NODE_RPC \?\? "([^"]+)"/.exec(read("scripts/dev.mjs"))[1];
  assert.equal(dev, "http://127.0.0.1:30334");
  assert.match(read("README.md"), /`NODE_RPC` \(default `http:\/\/127\.0\.0\.1:30334`/);
  for (const doc of ["README.md", "docs/first-app.md", "docs/chats.md", "scripts/dev.mjs"]) {
    assert.doesNotMatch(read(doc), /30734/, `${doc}: no node listens on 30734`);
  }
});

test("examples name the test network by its kind", () => {
  for (const doc of ["README.md", "docs/chats.md", "docs/first-app.md"]) {
    assert.doesNotMatch(read(doc), /network: "testnet"/, `${doc}: Saltix's test network is of the devnet kind`);
  }
});
