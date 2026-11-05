// No list of relays anywhere in the SDK (Saltix 41-transport §18, the owner's rule of 2026-11-04): a censor who reads the
// package, its docs or its templates finds no relay's address. The release's entry points live obfuscated in entry.ts;
// everything else is found when the SDK runs. In Saltix's repository the relays the apps' pins name
// (deploy/net/relays) must not appear anywhere here in the clear, tests included.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { entryPoints, endpointOf, publicHost } from "../dist/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEPLOY_RELAYS = join(ROOT, "..", "deploy", "net", "relays", "README.md");
const TEXT = /\.(ts|mjs|js|json|md|html|css|txt|sh|yml|yaml)$/;
// vectors/: the protocol's golden bytes copied into the public mirror beside the packages (held to their source by
// vectors/SOURCE), with the documentation addresses their cases use; not the SDK's text.
const SKIP = new Set(["node_modules", "dist", ".git", ".grain", "vectors"]);

/** Every text file of the SDK, tests included. */
function files(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name === "package-lock.json") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (TEXT.test(name)) out.push({ path, rel: relative(ROOT, path) });
  }
  return out;
}

/** Whether an IPv4 address may stand in the SDK's text: one no relay can serve the public from, as the SDK judges a
 *  ticket's host (`publicHost`: loopback, private, link-local, an emulator's host alias, documentation — RFC 5737's
 *  ranges, which examples and tests use —, multicast, reserved…). */
const harmless = (ip) => !publicHost(ip);

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/** A browser's reduced user agent names its version as an address would (`Chrome/130.0.0.0`): that alone passes. */
const version = (text, m) => text.slice(Math.max(0, m.index - 7), m.index) === "Chrome/" && m[0].endsWith(".0.0.0");

test("no public address in the SDK's code, docs, templates, examples or tests: relays are found, never listed", () => {
  const found = [];
  for (const f of files()) {
    const text = readFileSync(f.path, "utf8");
    for (const m of text.matchAll(IPV4)) if (!harmless(m[0]) && !version(text, m)) found.push(`${f.rel}: ${m[0]}`);
    for (const m of text.matchAll(/wss:\/\/\[([0-9a-fA-F:]+)\]/g)) {
      if (!/^(2001:db8|::1$)/i.test(m[1])) found.push(`${f.rel}: [${m[1]}]`);
    }
  }
  assert.deepEqual(found, [], "an address in the clear: a relay is found when the SDK runs (41-transport §18), and an example or a test uses 192.0.2.x, 198.51.100.x or 203.0.113.x");
});

test("the entry points are in the package only obfuscated: no line of entry.ts reads as one", () => {
  const source = readFileSync(join(ROOT, "packages", "server", "src", "entry.ts"), "utf8");
  for (const entry of entryPoints("devnet")) {
    const host = new URL(endpointOf(entry).url).hostname;
    assert.ok(!source.includes(host), "the entry point's host is not in entry.ts in the clear");
  }
});

test("the relays the apps' pins name appear nowhere in the SDK in the clear, tests included", { skip: !existsSync(DEPLOY_RELAYS) && "outside Saltix's repository" }, () => {
  const hosts = [...readFileSync(DEPLOY_RELAYS, "utf8").matchAll(/^\| `relay-\d\.crt` \| [^,]+, ([0-9.]+):\d+ \|/gm)].map((m) => m[1]);
  assert.ok(hosts.length >= 1, "deploy/net/relays/README.md names its relays");
  const found = [];
  for (const f of files()) {
    const text = readFileSync(f.path, "utf8");
    for (const host of hosts) if (text.includes(host)) found.push(`${f.rel}: ${host}`);
  }
  assert.deepEqual(found, []);
  // And the entry points are those relays (scripts/set-network.py --check holds their pins to the certificates).
  assert.deepEqual(entryPoints("devnet").map((e) => new URL(endpointOf(e).url).hostname).sort(), [...hosts].sort());
});
