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
import { shortAddress } from "@saltix/grain";
import { encodeAddress, fromHex } from "@saltix/grain-server";
import { findBrowser } from "../dist/browser.js";
import { checkReason, findingLines, judge, judgeTaps, overlap, underNavigationBar, underStatusBar } from "../dist/check.js";
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

test("the navigation bar: what is pinned there stays a warning; a button at a long page's fold that scrolls clear is none", () => {
  // The phone of `measure()`: 753 px tall, its navigation bar the last 25 (from y 728).
  const nav = { x: 0, y: 728, width: 477, height: 25 };
  const status = { x: 0, y: 0, width: 477, height: 33 };
  const atFold = { x: 17, y: 700, width: 443, height: 42 };
  const scrolledUp = { x: 17, y: 420, width: 443, height: 42 };
  const barsOf = (tappables) => judge(run({ measures: [measure({ tappables })] })).filter((f) => f.what === "bars").map((f) => f.detail);
  // A long page: its button sits at the fold as it opens, and the page scrolls it clear of the bar. No warning.
  const fold = { name: 'button#next "Next"', box: atFold, pinned: false, end: scrolledUp };
  assert.equal(underNavigationBar(fold, nav), false);
  assert.deepEqual(barsOf([fold]), []);
  // The same button on a page with no room below it: still under the bar with the page scrolled to its end.
  const stuck = { ...fold, end: atFold };
  assert.equal(underNavigationBar(stuck, nav), true);
  assert.match(barsOf([stuck])[0], /^button#next "Next" is under the navigation bar: pad by --saltix-safe-bottom/);
  // A page that does not scroll: where it is, it stays.
  assert.equal(underNavigationBar({ ...fold, end: null }, nav), true);
  // A button fixed to the bottom with no padding: under the bar at every scroll. A warning, whatever the page does.
  const fixed = { name: 'button#buy "Buy"', box: { x: 0, y: 711, width: 477, height: 42 }, pinned: true, end: { x: 0, y: 711, width: 477, height: 42 } };
  assert.equal(underNavigationBar(fixed, nav), true);
  assert.match(barsOf([fixed])[0], /^button#buy "Buy" is under the navigation bar/);
  // A bar sticky to the bottom: under the navigation bar as the page opens and while it scrolls, though at the scroll's
  // end it rests at its place above the page's padding. A warning: most of the time a tap there goes to the system.
  const stickyBottom = { name: "button#checkout", box: { x: 0, y: 711, width: 477, height: 42 }, pinned: true, end: { x: 0, y: 600, width: 477, height: 42 } };
  assert.equal(underNavigationBar(stickyBottom, nav), true);
  // A bar sticky to the top (not pinned low: it scrolls up until it sticks there), which a long page's opening shows at
  // its place near the bottom: clear once the page scrolls. No warning.
  const stickyTop = { name: "nav#tabs", box: { x: 0, y: 720, width: 477, height: 48 }, pinned: false, end: { x: 0, y: 33, width: 477, height: 48 } };
  assert.equal(underNavigationBar(stickyTop, nav), false);
  // Padded by the inset: clear of the bar at once.
  assert.equal(underNavigationBar({ ...fixed, box: { ...fixed.box, y: 686 }, end: { ...fixed.box, y: 686 } }, nav), false);
  // An older simulator, which measured no scroll: judged where it is, as before.
  assert.equal(underNavigationBar({ name: "a", box: atFold }, nav), true);
  // The status bar: an element that scrolls with the page is at its lowest as the page opens, so under it then is under
  // it for good; a pinned one stays there.
  const top = { name: "a#home", box: { x: 10, y: 5, width: 40, height: 20 }, pinned: false, end: { x: 10, y: -400, width: 40, height: 20 } };
  assert.equal(underStatusBar(top, status), true);
  assert.equal(underStatusBar({ ...top, box: { ...top.box, y: 40 } }, status), false);
});

test("--tap: a tap that throws, or asks Saltix for what it refuses, is an error; one that changes nothing a warning; a user's no is neither", () => {
  const tapped = (over) => ({ name: 'button#x "X"', state: "tapped", thrown: [], asked: [], dialogs: 0, blocked: [], changed: true, ...over });
  const taps = (seen, total = seen.filter((t) => !t.later).length, later = seen.filter((t) => t.later).length) => ({ seen, total, later, device: "phone", theme: "dark" });
  // A tap that changes the screen, one that asks Saltix for something (a copy, no visible change), one the simulator's
  // declined payment answers (4001, the user's no), one that opens a dialog: all fine.
  const fine = judgeTaps(taps([
    tapped({}), tapped({ name: "b", changed: false, asked: [{ method: "grain_copy", ok: true }] }),
    tapped({ name: "pay", changed: false, asked: [{ method: "grain_pay", ok: false, code: 4001, message: "declined: grain dev --check makes no payment" }] }),
    tapped({ name: "ask", changed: false, dialogs: 1 }),
  ]));
  assert.deepEqual(fine.filter((f) => f.level !== "ok"), []);
  assert.equal(fine.at(-1).detail, "tapped 4 buttons once each at phone dark");
  // An exception and a refusal are errors, each named by its button.
  const bad = judgeTaps(taps([
    tapped({ name: 'button#boom "Boom"', thrown: ["TypeError: board is null"] }),
    tapped({ name: 'button#send "Send"', asked: [{ method: "grain_relay_send", ok: false, code: 4100, message: "the manifest does not ask for this" }] }),
  ]));
  assert.deepEqual(bad.filter((f) => f.level === "error").map((f) => f.detail), [
    'tapping button#boom "Boom" threw TypeError: board is null',
    'tapping button#send "Send" asked Saltix for grain_relay_send, which it refuses: 4100 the manifest does not ask for this',
  ]);
  // A tap failed: no line says that all went well (round four read "error tap … threw" beside "ok tap tapped 9 buttons").
  assert.deepEqual(bad.filter((f) => f.level === "ok"), []);
  assert.deepEqual(judge(run({ taps: taps([tapped({ thrown: ["TypeError: x"] }), tapped({ name: "b" })]) })).filter((f) => f.what === "tap").map((f) => f.level), ["error"]);
  // Warnings: nothing changed and nothing asked; a document from elsewhere (stopped); a button something covers.
  const warned = judgeTaps(taps([
    tapped({ name: 'button#dead "Dead"', changed: false }),
    tapped({ name: 'button#away "Away"', changed: false, blocked: ["https://elsewhere.example/page"] }),
    { name: 'button#under "Under"', state: "covered", by: "div", thrown: [], asked: [], dialogs: 0, blocked: [], changed: false },
    { name: 'button#gone "Gone"', state: "gone", thrown: [], asked: [], dialogs: 0, blocked: [], changed: false },
  ], 40));
  assert.deepEqual(warned.filter((f) => f.level === "warning").map((f) => f.detail), [
    'tapping button#dead "Dead" changed nothing on the screen and asked Saltix for nothing',
    "tapping button#away \"Away\" tried to leave the page for https://elsewhere.example/page: stopped here; Saltix opens a page outside the app's origins in its browser, without the bridge (grain.openLink says so on purpose)",
    'button#under "Under" cannot be tapped: div is over its middle, and a tap there reaches that instead',
  ]);
  assert.equal(warned.at(-1).detail, "tapped 2 buttons once each (the first 4 of 40) at phone dark; 2 not tapped (taken away by an earlier tap, or covered)");
  assert.equal(judgeTaps(taps([])).at(-1).detail, "no button to tap");
  // Buttons a tap brought up ("Clear history" once there is a history) are tapped in their turn and counted; those the
  // bounds left are a warning, with how many.
  const brought = judgeTaps(taps([tapped({ name: 'button#roll "Roll"' }), tapped({ name: 'button#clear "Clear history"', later: true })]));
  assert.deepEqual(brought.filter((f) => f.level !== "ok"), []);
  assert.equal(brought.at(-1).detail, "tapped 2 buttons once each at phone dark, 1 of them brought up by an earlier tap");
  const bounded = judgeTaps(taps([tapped({}), tapped({ name: "b", later: true })], 1, 3));
  assert.deepEqual(bounded.filter((f) => f.level === "warning").map((f) => f.detail), [
    "2 buttons appeared later and were not tapped: the check taps at most 30 buttons, in at most 40 s; try them in grain dev's simulator",
  ]);
  assert.equal(judgeTaps(taps([tapped({})], 1, 1)).find((f) => f.level === "warning").detail.split(":")[0], "1 button appeared later and was not tapped");
  // A thrown tap among later ones: an error, by its name.
  const late = judgeTaps(taps([tapped({ name: 'button#roll "Roll"' }), tapped({ name: 'button#clear "Clear history"', later: true, thrown: ["Error: clear failed"] })]));
  assert.deepEqual(late.map((f) => [f.level, f.detail]), [["error", 'tapping button#clear "Clear history" threw Error: clear failed']]);
  // In the whole judgment: the first error's kind is the log's reason; without --tap nothing of it.
  assert.equal(checkReason(judge(run({ taps: taps([tapped({ thrown: ["TypeError: x"] })]) }))), "tap");
  assert.equal(checkReason(judge(run({ taps: taps([tapped({ changed: false })]) }))), "warnings");
  assert.ok(!judge(run()).some((f) => f.what === "tap"));
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
  // A new project is sealed from the start: the simulator opens its start page from the bundle's root.
  assert.match(r.stdout, /^ok {4}open {11}the page loaded \(\/index\.html, "Dice"\)$/m);
  assert.match(r.stdout, /^next: nothing: the page checks at every screen in both themes/m);
  const report = reportOf(dir);
  // The sheet names the owner as Saltix does (19-connect §12.1): a short address of the network, never hex.
  const owner = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).owner;
  const short = shortAddress(encodeAddress("devnet", fromHex(owner, 32)));
  assert.match(short, /^dsalt1q\w{4}…\w{6}$/);
  assert.ok(report.run.sheet.text.includes(`dice · by ${short}`), report.run.sheet.text);
  assert.ok(!report.run.sheet.text.includes(owner.slice(0, 8)), "no hex");
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

test("a real browser: a long page's button at the fold is fine, a button fixed over the navigation bar is not", live, () => {
  // A long page with a button at the fold as it opens (its top 20 px above the screen's bottom edge, over the
  // navigation bar), which the page scrolls clear of the bar.
  const long = page((dir) => {
    const html = readFileSync(join(dir, "public", "index.html"), "utf8")
      .replace("<body>", '<body>\n  <div style="height:calc(100vh - 20px)"></div><button id="next" style="display:block">Next</button><div style="height:60vh"></div>');
    writeFileSync(join(dir, "public", "index.html"), html);
  });
  const fine = check(long);
  assert.equal(fine.status, 0, fine.stdout + fine.stderr);
  assert.doesNotMatch(fine.stdout, /under the navigation bar/, "a button the page scrolls clear of the bar");
  const report = reportOf(long);
  const atFold = report.run.measures.filter((m) => m.bars.bottom > 0).map((m) => [m, m.tappables.find((t) => t.name.startsWith("button#next"))]);
  assert.ok(atFold.length > 0);
  for (const [m, t] of atFold) {
    assert.equal(t.pinned, false);
    assert.ok(overlap(t.box, { x: 0, y: m.phone.height - m.bars.bottom, width: m.phone.width, height: m.bars.bottom }), `${m.device}: over the bar as the page opens`);
    assert.ok(t.end && t.end.y < t.box.y, `${m.device}: measured again with the page scrolled to its end`);
  }
  // A button fixed to the bottom of an edge-to-edge page, with no padding for the bar, and one in a bar sticky to the
  // bottom: warnings at every screen. The page's own sticky top bar is not pinned low: it scrolls up until it sticks.
  const fixed = page((dir) => {
    const html = readFileSync(join(dir, "public", "index.html"), "utf8")
      .replace("<header>", '<header><a id="home" href="#">Home</a>')
      .replace("</main>", '<div style="height:150vh"></div><div style="position:sticky;bottom:0"><button id="pay" style="margin:0">Pay</button></div></main>' +
        '<button id="buy" style="position:fixed;left:0;right:0;bottom:0;width:100%;margin:0">Buy</button>');
    writeFileSync(join(dir, "public", "index.html"), html);
  });
  const warned = check(fixed);
  assert.equal(warned.status, 0, warned.stdout + warned.stderr);
  assert.match(warned.stdout, /^warn {2}bars {11}button#buy "Buy" is under the navigation bar: pad by --saltix-safe-bottom/m);
  assert.match(warned.stdout, /^warn {2}bars {11}button#pay "Pay" is under the navigation bar/m);
  const phone = reportOf(fixed).run.measures.find((m) => m.device === "phone").tappables;
  const pinned = (name) => phone.find((t) => t.name.startsWith(name)).pinned;
  assert.deepEqual([pinned("button#buy"), pinned("button#pay"), pinned("a#home")], [true, true, false]);
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

test("--tap in a real browser: each button once; a throw and a refused request fail it, a dead or covered button and a page that would leave are warnings", live, () => {
  const dir = page((dir) => {
    const html = readFileSync(join(dir, "public", "index.html"), "utf8").replace("</main>", `</main>
<div id="taps"><button id="boom">Boom</button><button id="dead">Dead</button><button id="away">Away</button><button id="pay">Pay</button>
<button id="send">Send</button><div style="position:relative"><button id="under">Under</button><div style="position:absolute;inset:0"></div></div>
<button id="roll">Roll</button><button id="clear" hidden>Clear history</button><span id="again"><button>Drawn 0 times</button></span></div>
<script type="module" src="./taps.js"></script>`);
    writeFileSync(join(dir, "public", "index.html"), html);
    writeFileSync(join(dir, "public", "taps.js"), `import { grain } from "./grain.js";
document.getElementById("boom").onclick = () => { throw new TypeError("board is null"); };
document.getElementById("away").onclick = () => { location.href = "https://elsewhere.example/page"; };
document.getElementById("pay").onclick = () => grain.pay({ to: "dsalt1qqqq", amount: "1" }).catch(() => {});
document.getElementById("send").onclick = () => grain.relay.send("dsalt1qqqq", new Uint8Array([1])).catch(() => {});
document.getElementById("roll").onclick = () => { document.getElementById("clear").hidden = false; };
document.getElementById("clear").onclick = () => { throw new Error("clear failed"); };
// A button drawn again on every tap, its count in its label: the same button, never one a tap brought up.
let drawn = 0;
const draw = () => {
  const b = document.createElement("button");
  b.textContent = \`Drawn \${drawn} times\`;
  b.onclick = () => { drawn++; draw(); };
  document.getElementById("again").replaceChildren(b);
};
draw();
`);
  });
  // Without --tap: nothing is tapped, and the page passes.
  const quiet = check(dir);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /tapped|tapping|^\S+ +tap /m);
  const r = spawnSync("node", [main, "dev", "--check", "--tap"], { cwd: dir, encoding: "utf8", timeout: 170_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  // Eight shown as the taps began, one covered; "Clear history", which Roll brings up, tapped in its turn; the button
  // drawn again with a new count, never.
  assert.match(r.stdout, /then 9 of its buttons tapped once each$/m);
  assert.match(r.stdout, /^error tap {12}tapping button#clear "Clear history" threw Error: clear failed$/m);
  assert.match(r.stdout, /^error tap {12}tapping button#boom "Boom" threw TypeError: board is null$/m);
  assert.match(r.stdout, /^error tap {12}tapping button#send "Send" asked Saltix for grain_relay_send, which it refuses: 4100 /m);
  assert.match(r.stdout, /^warn {2}tap {12}tapping button#dead "Dead" changed nothing on the screen and asked Saltix for nothing$/m);
  assert.match(r.stdout, /^warn {2}tap {12}tapping button#away "Away" tried to leave the page for https:\/\/elsewhere\.example\/page: stopped here/m);
  assert.match(r.stdout, /^warn {2}tap {12}button#under "Under" cannot be tapped: div is over its middle/m);
  // A tap failed: no line says all went well, and the next step checks the taps again.
  assert.doesNotMatch(r.stdout, /^ok {4}tap /m);
  assert.match(r.stdout, /^next: fix the 3 errors above, then grain dev --check --tap again$/m);
  // The counter changed the screen; the payment was declined by the simulator, as a user may: neither is said.
  assert.doesNotMatch(r.stdout, /button#count|button#pay/);
  const report = reportOf(dir).run;
  const pay = report.taps.seen.find((t) => t.name.startsWith("button#pay"));
  assert.deepEqual(pay.asked.map((a) => [a.method, a.code]), [["grain_pay", 4001]]);
  assert.ok(report.taps.seen.find((t) => t.name.startsWith("button#count")).changed);
  assert.deepEqual(report.taps.seen.filter((t) => t.later).map((t) => t.name), ['button#clear "Clear history"']);
  assert.equal(report.taps.later, 1);
  // Tap-time errors are the taps' own, never counted twice as the page's.
  assert.deepEqual(report.errors.filter((e) => e.where === "page"), []);
  assert.ok(existsSync(join(dir, ".grain", "check", "tap-1.png")), "what each tap left on the page");
  const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8");
  assert.match(log, /"step":"check","outcome":"refused","reason":"tap"/);
  // A fresh page answers its one tap; --tap alone is a misuse.
  const fresh = page();
  const ok = spawnSync("node", [main, "dev", "--check", "--tap"], { cwd: fresh, encoding: "utf8", timeout: 170_000 });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^ok {4}tap {12}tapped 1 button once each at phone dark$/m);
  assert.match(ok.stdout, /^next: nothing: the page checks at every screen in both themes and answers every tap/m);
  assert.equal(spawnSync("node", [main, "dev", "--tap"], { cwd: fresh, encoding: "utf8" }).status, 2);
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
