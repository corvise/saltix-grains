// The `grain` command npm links: a file in the repository, so a fresh `npm ci` links it before anything is built, that
// runs the built command line and says what to do while it is not built.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scratch } from "../../../scripts/scratch.mjs";

const bin = fileURLToPath(new URL("../bin/grain.js", import.meta.url));
const run = (file, args = []) => spawnSync("node", [file, ...args], { encoding: "utf8", timeout: 10_000 });

test("npm links a command that is in the repository, not one the build makes", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.bin.grain, "bin/grain.js");
  assert.ok(pkg.files.includes("bin"), "the package ships it");
  assert.ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
  assert.ok(statSync(bin).mode & 0o111, "executable");
  const help = run(bin, ["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /grain init/);
});

test("before the build it says to build; a fault inside the built tool is not taken for that", () => {
  const dir = scratch("grain-bin-");
  writeFileSync(join(dir, "package.json"), '{"type": "module"}\n');
  mkdirSync(join(dir, "bin"));
  copyFileSync(bin, join(dir, "bin", "grain.js"));
  const unbuilt = run(join(dir, "bin", "grain.js"));
  assert.equal(unbuilt.status, 1);
  assert.match(unbuilt.stderr, /not built yet: run `npm run build`/);
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "main.js"), 'import "no-such-package-of-grain";\n');
  const broken = run(join(dir, "bin", "grain.js"));
  assert.notEqual(broken.status, 0);
  assert.doesNotMatch(broken.stderr, /not built yet/);
  assert.match(broken.stderr, /no-such-package-of-grain/);
});
