// `grain dev --check`: what is wrong in what the simulator measured (pure functions, on made-up measures), where the
// browser is found, and the whole check in a real headless browser when this computer has one: a fresh page passes at
// every screen in both themes, a button under the wallet's controls, a page that throws and a start page that is not
// there fail it, and a sealed page (what grain publish leaves in grain.json) opens. Nothing of the browser is left
// behind.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../dist/browser.js";
import { checkReason, findingLines, judge, overlap } from "../dist/check.js";
import { scratch } from "../../../scripts/scratch.mjs";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** A screen as the simulator measures it: a phone of 475 × 751, edge to edge, the controls at the top right. */
const measure = (over = {}) => ({
  device: "fold-475", theme: "dark", mode: "Edge to edge: the page declares viewport-fit=cover, and is told safe_area and controls.",
  phone: { width: 477, height: 753, page: { x: 0, y: 0 } }, frame: { x: 1, y: 1, width: 475, height: 751 },
  controls: { x: 372, y: 37, width: 96, height: 48 }, bars: { top: 33, bottom: 25 },
  page: { url: "http://127.0.0.1:1/", ready: "complete", status: 200, title: "Dice", scrollWidth: 475, clientWidth: 475, background: "rgb(11, 16, 32)", color: "rgb(230, 236, 255)", rootBackground: "rgba(0, 0, 0, 0)" },
  tappables: [{ name: 'button#count "Count"', box: { x: 17, y: 107, width: 443, height: 42 } }],
  ...over,
});
const light = (m) => ({ ...m, theme: "light", page: { ...m.page, background: "rgb(244, 246, 251)", color: "rgb(11, 16, 32)" } });
const run = (over = {}) => ({
  sheet: { text: "Saltix Connect", problem: null, profile: true, icon: true }, load: measure().page,
  measures: [measure(), light(measure())], errors: [], refused: [], dialogs: [], icon: true, ...over,
});
const errorsOf = (r) => judge(r).filter((f) => f.level === "error");

test("a page that keeps clear of the controls, loads and draws both themes has no error", () => {
  const findings = judge(run());
  assert.deepEqual(findings.filter((f) => f.level !== "ok"), []);
  assert.deepEqual(findings.map((f) => f.what), ["connect sheet", "open", "layout"]);
  assert.equal(checkReason(findings), "clean");
  assert.match(findingLines(findings).join("\n"), /^ok {4}layout {9}nothing tappable under the wallet's controls at 1 screens in 2 themes$/m);
});

test("something tappable under the wallet's controls is an error, at each screen and theme it is under them", () => {
  const menu = { name: 'button#menu "Menu"', box: { x: 400, y: 40, width: 40, height: 40 } };
  const under = measure({ tappables: [menu] });
  const findings = judge(run({ measures: [under, light(under), measure({ device: "phone", controls: null, tappables: [menu] })] }));
  const errors = findings.filter((f) => f.level === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].what, "controls");
  assert.match(errors[0].detail, /^button#menu "Menu" is under the wallet's controls ⋯ \| ✕/);
  assert.deepEqual(errors[0].where, ["fold-475 dark", "fold-475 light"], "not where the controls sit in their band above the page");
  assert.equal(checkReason(findings), "controls");
  // Touching edges are not an overlap; a pixel's sliver is not either.
  assert.equal(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }), false);
  assert.equal(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 9.5, y: 0, width: 10, height: 10 }), false);
  assert.equal(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 8, y: 8, width: 10, height: 10 }), true);
});

test("a page that does not open, throws, or a Connect profile a wallet refuses is an error; the rest are warnings", () => {
  assert.equal(errorsOf(run({ load: null, measures: [] }))[0].detail, "the page did not load in the simulator");
  assert.match(errorsOf(run({ load: { ...measure().page, status: 404, url: "http://127.0.0.1:1/.well-known/index.html" } }))[0].detail, /answered 404: no page there/);
  const thrown = errorsOf(run({ errors: [{ where: "page", text: "TypeError: board is null" }] }));
  assert.deepEqual(thrown.map((f) => [f.what, f.detail]), [["page error", "TypeError: board is null"]]);
  assert.match(errorsOf(run({ sheet: { text: "", problem: "connect.json: texts: 1 to 8 languages", profile: false, icon: false } }))[0].detail, /a wallet shows the app as having no profile/);
  // Warnings: a sideways scroll, a bar's zone, a refused request, no profile, the same look in both themes, the
  // simulator's own errors.
  const wide = measure({ page: { ...measure().page, scrollWidth: 520 } });
  const top = measure({ tappables: [{ name: "a#home", box: { x: 10, y: 5, width: 40, height: 20 } }] });
  const findings = judge(run({
    measures: [wide, measure({ theme: "light" }), top], refused: [{ method: "grain_storage_set", code: 4100, message: "the manifest does not ask for storage" }],
    errors: [{ where: "simulator", text: "a simulator's own" }], sheet: { text: "", problem: null, profile: false, icon: false },
  }));
  assert.deepEqual(findings.filter((f) => f.level === "error"), []);
  const warned = Object.fromEntries(findings.filter((f) => f.level === "warning").map((f) => [f.what, f]));
  assert.deepEqual(Object.keys(warned).sort(), ["bars", "bridge", "connect sheet", "overflow", "simulator", "theme"]);
  assert.deepEqual(warned.overflow.where, ["fold-475 dark (520 > 475 px)"]);
  assert.match(warned.bars.detail, /^a#home is under the status bar: pad by --saltix-safe-top/);
  assert.equal(warned.bridge.detail, "grain_storage_set was refused: 4100 the manifest does not ask for storage");
  assert.match(warned.theme.detail, /looks the same in the dark and the light theme/);
  assert.equal(checkReason(findings), "warnings");
  // Inside the safe area nothing is under the bars: not judged so.
  const safe = measure({ mode: "Inside the safe area: the page does not declare viewport-fit=cover", controls: null, tappables: top.tappables });
  assert.ok(!judge(run({ measures: [safe, light(safe)] })).some((f) => f.what === "bars"));
});

test("the browser: CHROME_PATH first, then the system's usual places; none is said, never guessed", () => {
  const has = (paths) => (p) => paths.includes(p);
  assert.equal(findBrowser({ CHROME_PATH: "/opt/chrome" }, "linux", has(["/opt/chrome"])), "/opt/chrome");
  assert.equal(findBrowser({ CHROME_PATH: "/nowhere", PATH: "/usr/bin:/bin" }, "linux", has(["/usr/bin/chromium"])), "/usr/bin/chromium");
  assert.equal(findBrowser({ PATH: "/usr/bin" }, "linux", has(["/usr/bin/google-chrome", "/usr/bin/chromium"])), "/usr/bin/google-chrome");
  assert.equal(findBrowser({ HOME: "/Users/a" }, "darwin", has(["/Users/a/Applications/Chromium.app/Contents/MacOS/Chromium"])),
    "/Users/a/Applications/Chromium.app/Contents/MacOS/Chromium");
  assert.equal(findBrowser({ PROGRAMFILES: "C:/Program Files" }, "win32", has([join("C:/Program Files", "Microsoft/Edge/Application/msedge.exe")])),
    join("C:/Program Files", "Microsoft/Edge/Application/msedge.exe"));
  assert.equal(findBrowser({ PATH: "/usr/bin" }, "linux", has([])), null);
  // None here (on Linux, where the PATH is where browsers are found): the command says so and what to do, exit 1.
  if (process.platform === "linux") {
    const dir = scratch("grain-check-none-");
    assert.equal(spawnSync(process.execPath, [main, "init", join(dir, "dice"), "--name", "Dice"], { encoding: "utf8" }).status, 0);
    const none = spawnSync(process.execPath, [main, "dev", "--check"], {
      cwd: join(dir, "dice"), encoding: "utf8", env: { ...process.env, CHROME_PATH: "", SALTIX_BROWSER: "", PATH: "/nonexistent" },
    });
    assert.equal(none.status, 1, none.stderr);
    assert.match(none.stdout, /no Chrome, Chromium, Edge or Brave on this computer.*set CHROME_PATH/);
  }
});

const browser = findBrowser();
const live = { skip: browser === null ? "no Chrome, Chromium, Edge or Brave here" : false, timeout: 180_000 };

/** A page project as grain init makes it, `edit`ed. */
function page(edit = () => {}) {
  const dir = join(scratch("grain-check-"), "dice");
  const made = spawnSync("node", [main, "init", dir, "--name", "Dice"], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  edit(dir);
  return dir;
}
const check = (dir) => spawnSync("node", [main, "dev", "--check"], { cwd: dir, encoding: "utf8", timeout: 150_000 });
const reportOf = (dir) => JSON.parse(readFileSync(join(dir, ".grain", "check", "report.json"), "utf8"));

test("a fresh page passes in a real browser: the sheet, the page, six screens in both themes, a screenshot of each", live, () => {
  const dir = page();
  const temporary = () => readdirSync(tmpdir()).filter((name) => name.startsWith("grain-browser-"));
  const before = new Set(temporary());
  const r = check(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok {4}connect sheet  shown with connect\.json's profile and the monogram/m);
  assert.match(r.stdout, /^ok {4}open {11}the page loaded \(\/, "Dice"\)$/m);
  assert.match(r.stdout, /^next: nothing: the page checks at every screen in both themes/m);
  const report = reportOf(dir);
  assert.equal(report.run.measures.length, 12);
  assert.deepEqual([...new Set(report.run.measures.map((m) => m.theme))], ["dark", "light"]);
  const shots = readdirSync(join(dir, ".grain", "check")).filter((f) => f.endsWith(".png"));
  assert.equal(shots.length, 13, shots.join(" "));
  assert.ok(!existsSync(join(dir, ".grain", "browser")), "the browser's profile is removed");
  assert.deepEqual(temporary().filter((name) => !before.has(name)), [], "and its temporary directory");
  const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.command === "dev" && l.step === "check" && l.outcome === "ok" && l.reason === "clean"));
});

test("a real browser finds a button under the controls, a page that throws, and a page that is not there", live, () => {
  // A menu button pinned to the top right of an edge-to-edge page, where the wallet's controls float.
  const menu = page((dir) => {
    const html = readFileSync(join(dir, "public", "index.html"), "utf8")
      .replace("</main>", '</main><button id="menu" style="position:fixed;top:40px;right:12px;width:44px;height:44px">Menu</button>');
    writeFileSync(join(dir, "public", "index.html"), html);
  });
  const under = check(menu);
  assert.equal(under.status, 1, under.stdout + under.stderr);
  assert.match(under.stdout, /^error controls {7}button#menu "Menu" is under the wallet's controls/m);
  assert.ok(reportOf(menu).findings.find((f) => f.what === "controls").where.length >= 6, "at the screens where the controls float over the page");
  // A script that throws.
  const thrower = page((dir) => writeFileSync(join(dir, "public", "app.js"), readFileSync(join(dir, "public", "app.js"), "utf8") + '\nthrow new TypeError("board is null");\n'));
  const thrown = check(thrower);
  assert.equal(thrown.status, 1, thrown.stdout);
  assert.match(thrown.stdout, /^error page error {5}.*TypeError: board is null/m);
  // A start page the bundle does not have.
  const missing = page((dir) => {
    const m = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
    writeFileSync(join(dir, "grain.json"), JSON.stringify({ ...m, entry: { hosted: { url: "https://dice.example/nowhere.html", origins: ["https://dice.example"] } } }));
  });
  const gone = check(missing);
  assert.equal(gone.status, 1, gone.stdout);
  assert.match(gone.stdout, /^error open {11}http:\/\/127\.0\.0\.1:\d+\/nowhere\.html answered 404/m);
});

test("a sealed page, as grain publish leaves grain.json, opens in the simulator from the bundle's root, its icon on the sheet", live, () => {
  const dir = page();
  assert.equal(spawnSync("node", [main, "icon", "--monogram", "D"], { cwd: dir, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("node", [main, "bundle"], { cwd: dir, encoding: "utf8" }).status, 0);
  assert.ok("sealed" in JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).entry);
  const r = check(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok {4}open {11}the page loaded \(\/index\.html, "Dice"\)$/m);
  // The project's icon, which grain.json names, on the Connect sheet: never the monogram the simulator drew before.
  assert.match(r.stdout, /^ok {4}connect sheet  shown with connect\.json's profile and the app's icon$/m);
  assert.equal(reportOf(dir).run.sheet.icon, true);
});

test("a browser that does not start is said in words, and nothing of it is left behind", { timeout: 60_000, skip: process.platform === "win32" }, () => {
  // CHROME_PATH names a program that is no browser: it exits at once, saying it was given no sandbox.
  const dir = page();
  const bad = join(dir, "not-a-browser");
  writeFileSync(bad, "#!/bin/sh\necho 'No usable sandbox! (a test)' >&2\nexit 1\n", { mode: 0o755 });
  const broken = spawnSync(process.execPath, [main, "dev", "--check"], { cwd: dir, encoding: "utf8", env: { ...process.env, CHROME_PATH: bad }, timeout: 50_000 });
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /the browser has no sandbox here/, "a sandbox it is not given: tried once more without one");
  assert.match(broken.stderr, /^error: check: the browser exited \(status 1\): No usable sandbox! \(a test\)$/m);
  assert.ok(!existsSync(join(dir, ".grain", "browser")));
  const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
  assert.match(log, /"step":"check","outcome":"waiting","reason":"no_sandbox"/);
  assert.match(log, /"step":"check","outcome":"failed","reason":"browser"/);
});
