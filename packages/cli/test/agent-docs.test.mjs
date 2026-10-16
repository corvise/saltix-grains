// The pages for coding agents say only what holds: their links lead somewhere, every `grain` command they name exists,
// and every `npm run` script they name is the repository's.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(root, "docs", "agents");
const pages = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));
const help = spawnSync("node", [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "help"], { encoding: "utf8" }).stdout;
const commands = new Set([...help.matchAll(/^ {2}grain ([a-z-]+)/gm)].map((m) => m[1]));

test("the agents' pages exist and link to files that do", () => {
  assert.deepEqual(pages.map((p) => p.name).sort(), ["README.md", "app.md", "sdk.md"]);
  for (const { name, text } of pages) {
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      assert.ok(existsSync(join(dir, target)), `${name} links to ${target}, which is not there`);
    }
  }
});

test("every grain command and npm script they name exists", () => {
  const scripts = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts);
  let named = 0;
  for (const { name, text } of pages) {
    // Commands as they are typed: `grain …` in code, or npx grain … in a block.
    for (const [, command] of text.matchAll(/(?:npx |`)grain ([a-z][a-z-]*)/g)) {
      named++;
      assert.ok(commands.has(command), `${name} names grain ${command}, which the help does not list`);
    }
    for (const [, script] of text.matchAll(/npm run ([a-z:]+)/g)) assert.ok(scripts.includes(script), `${name}: npm run ${script}`);
  }
  assert.ok(named >= 5, "the pages name the commands they use");
});

test("the map names files that are there", () => {
  const sdk = pages.find((p) => p.name === "sdk.md").text;
  for (const [, path] of sdk.matchAll(/`((?:packages|scripts|simulator|examples|docs)\/[^`\s*…]*)`/g)) {
    assert.ok(existsSync(join(root, path)), `sdk.md names ${path}, which is not there`);
  }
  for (const [, file] of sdk.matchAll(/`([a-z-]+\.ts)`/g)) {
    const found = ["packages/server/src", "packages/cli/src", "packages/grain/src"].some((d) => existsSync(join(root, d, file)));
    assert.ok(found, `sdk.md names ${file}, which no package has`);
  }
});
