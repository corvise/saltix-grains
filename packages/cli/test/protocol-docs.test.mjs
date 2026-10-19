// The repository is public and the protocol's own repository is not: every page here leads somewhere a reader can
// open. Links between pages reach a file and, with an anchor, a heading of it; nothing links or sends a reader to the
// private repositories; and the protocol's pages (docs/protocol/) each say which protocol commit they reflect.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".git"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(root);
const markdown = files.filter((f) => f.endsWith(".md"));
const TEXT = /\.(md|ts|mjs|js|json|sh|ya?ml|html|css)$/;

/** A heading's anchor as GitHub makes it: lower case, punctuation and symbols dropped, each space a hyphen. */
export function anchorOf(heading) {
  const text = heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

const anchorsCache = new Map();
function anchorsOf(file) {
  if (!anchorsCache.has(file)) {
    const seen = new Map();
    const anchors = new Set();
    let fenced = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      const m = !fenced && /^#{1,6} (.+?)\s*$/.exec(line);
      if (!m) continue;
      const base = anchorOf(m[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    anchorsCache.set(file, anchors);
  }
  return anchorsCache.get(file);
}

/** Every inline link of a page, outside code: its target and the line it is on. */
function linksOf(file) {
  const links = [];
  let fenced = false;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const prose = line.replace(/`[^`]*`/g, "``");
    for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) links.push({ target, line: i + 1 });
  });
  return links;
}

test("the GitHub anchor of a heading", () => {
  assert.equal(anchorOf("5.1a. The team's sign-in: check first, render after"), "51a-the-teams-sign-in-check-first-render-after");
  assert.equal(anchorOf("Messaging keys: get_key"), "messaging-keys-get_key");
  assert.equal(anchorOf("The Connect profile: `connect.json`"), "the-connect-profile-connectjson");
  assert.equal(anchorOf('13. "Sign in with Saltix" on the web'), "13-sign-in-with-saltix-on-the-web");
});

test("every link between the repository's pages reaches a file, and its anchor a heading there", () => {
  let checked = 0;
  for (const file of markdown) {
    for (const { target, line } of linksOf(file)) {
      if (/^[a-z][a-z+.-]*:/i.test(target)) continue;
      const [path, anchor] = target.split("#", 2);
      const to = path === "" ? file : join(dirname(file), decodeURI(path));
      const where = `${relative(root, file)}:${line} → ${target}`;
      assert.ok(existsSync(to), `${where}: no such file`);
      if (anchor !== undefined && to.endsWith(".md")) {
        assert.ok(anchorsOf(to).has(anchor), `${where}: no such heading`);
      }
      checked++;
    }
  }
  assert.ok(checked > 200, `only ${checked} links checked`);
});

test("nothing links to the private repositories, nor sends a reader to the protocol's specs", () => {
  // The vectors are the protocol's bytes, copied unchanged: their `spec` fields name its documents as it names them.
  for (const file of files.filter((f) => TEXT.test(f) && !f.startsWith(join(root, "vectors")))) {
    const text = readFileSync(file, "utf8");
    const where = relative(root, file);
    // assert.ok, not doesNotMatch: a failure names the file and the words, not the whole file.
    const found = (re) => re.exec(text)?.[0];
    assert.ok(!found(/github\.com\/corvise\/saltix\//), `${where} links to the protocol's private repository`);
    assert.ok(!found(/corvise\/saltix-wallet/), `${where} names the wallet's private repository`);
    assert.ok(!found(/corvise\/saltix\s+`?(specs|explorer|docs)\//), `${where} sends a reader into the protocol's repository: ${found(/corvise\/saltix\s+`?(specs|explorer|docs)\/\S*/)}`);
    assert.ok(!found(/\bspecs\/\d\d-[a-z-]+\.md/), `${where} names a spec file a reader cannot open (${found(/\bspecs\/\d\d-[a-z-]+\.md/)}): link docs/protocol/`);
  }
});

test("the protocol's pages each name the protocol commit they reflect, and the index lists them all", () => {
  const dir = join(root, "docs", "protocol");
  const pages = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  assert.deepEqual(pages, ["app-studio.md", "basics.md", "connect.md", "grain-chats.md", "grains.md", "images.md", "relays.md", "wallet-interface.md"]);
  const index = readFileSync(join(dir, "README.md"), "utf8");
  for (const page of pages) {
    const text = readFileSync(join(dir, page), "utf8");
    assert.ok(/^> Reflects Saltix .+/m.test(text), `${page} says which specification it reflects`);
    const quote = text.replace(/\n> ?/g, " ");
    assert.ok(/as of corvise\/saltix `[0-9a-f]{8}` \(\d{4}-\d\d-\d\d\)/.test(quote), `${page} names the commit it was read at`);
    assert.ok(index.includes(`](${page})`), `the index lists ${page}`);
  }
  assert.ok(index.includes("](../../vectors/README.md)"), "the index leads to the vectors");
  assert.match(readFileSync(join(root, "vectors", "README.md"), "utf8"), /the protocol's own bytes/i);
});
