// `grain dev --check`: the page tried in `grain dev`'s simulator by a headless browser (`browser.ts`), as a person tries
// it: the Connect sheet first, then the page, at every screen the simulator plays (a phone, one on its side, the Galaxy Z
// Fold's three sizes, an iPhone-like screen) in both themes. The simulator says what it saw (`saltixSimulator`: the
// sheet, the page's load, the requests it refused, the page's geometry); what is wrong in it is judged here by pure
// functions (`judge`, `overlap`), tested on their own: an error for what a user would meet as broken (the page does not
// open or throws, something tappable under the wallet's controls ⋯ | ✕, a Connect profile a wallet refuses), a warning
// for what is worth a look (a sideways scroll, a request the wallet refused, the same look in both themes). A screenshot
// of each screen and `report.json` go to `.grain/check/`. Nothing leaves this computer.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Manifest } from "@saltix/grain-server";
import { Browser, findBrowser } from "./browser.js";
import { simulatorFor, serve } from "./dev.js";
import { type DevLog, GRAIN_DIR } from "./devlog.js";

/** Where the check writes its screenshots and report, in the project. */
export const CHECK_DIR = join(GRAIN_DIR, "check");

/** A box, CSS px from the phone's top left corner. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the simulator measured of one screen in one theme (`saltixSimulator.measure()`). */
export interface Measure {
  device: string;
  theme: string;
  mode: string;
  phone: { width: number; height: number; page: { x: number; y: number } };
  frame: Box;
  /** The wallet's controls ⋯ | ✕ over the page; null when they sit in their band above it. */
  controls: Box | null;
  /** How deep the status bar and the navigation bar reach. */
  bars: { top: number; bottom: number };
  page: {
    url: string;
    ready: string;
    status: number | null;
    title: string;
    scrollWidth: number;
    clientWidth: number;
    background: string;
    color: string;
    rootBackground: string;
  } | null;
  tappables: Array<{ name: string; box: Box }>;
}

/** The Connect sheet as the simulator drew it. */
export interface SheetSeen {
  text: string;
  /** Why a wallet would refuse `connect.json`, or null. */
  problem: string | null;
  /** Whether it shows the app's own words (a profile), or only the manifest's description. */
  profile: boolean;
  /** Whether it shows the project's icon. */
  icon: boolean;
  /** Where its icon stands: `none`, `loading`, `loaded` or `failed`. */
  iconState?: string;
}

/** Everything one check saw. */
export interface CheckRun {
  sheet: SheetSeen | null;
  /** The page at its first load, or null when it never loaded. */
  load: Measure["page"];
  measures: Measure[];
  /** Exceptions, console errors and failed loads: the page's, or the simulator's own. */
  errors: Array<{ where: "page" | "simulator"; text: string }>;
  /** Requests the simulator refused, as the page got them. */
  refused: Array<{ method: string; code: number; message: string }>;
  /** What the page asked the user (`confirm`, `prompt`), answered yes. */
  dialogs: string[];
  /** Whether grain.json names an icon. */
  icon: boolean;
}

export interface CheckFinding {
  level: "error" | "warning" | "ok";
  what: string;
  detail: string;
  /** The screens and themes it holds at (`fold-475 dark`), none for the page as a whole. */
  where: string[];
}

/** Whether two boxes share more than `tolerance` px each way. */
export const overlap = (a: Box, b: Box, tolerance = 1): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > tolerance &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > tolerance;

/** Whether a page is laid out edge to edge (it declares viewport-fit=cover), by the simulator's own words. */
const edgeToEdge = (m: Measure): boolean => /^Edge to edge/.test(m.mode);

/** What is wrong with a check's run, and what is right: findings, the same one at several screens merged. */
export function judge(run: CheckRun): CheckFinding[] {
  const found = new Map<string, CheckFinding>();
  const add = (level: CheckFinding["level"], what: string, detail: string, where?: string) => {
    const key = `${level}\u0000${what}\u0000${detail}`;
    const f = found.get(key) ?? { level, what, detail, where: [] };
    if (where !== undefined && !f.where.includes(where)) f.where.push(where);
    found.set(key, f);
  };
  // The Connect sheet: what Saltix shows before the page the first time (19-connect §12).
  if (run.sheet === null) {
    add("warning", "connect sheet", "the simulator showed no Connect sheet before the page");
  } else if (run.sheet.problem) {
    add("error", "connect sheet", `${run.sheet.problem.replace(/^connect\.json: /, "connect.json: ")}: a wallet shows the app as having no profile`);
  } else if (!run.sheet.profile) {
    add("warning", "connect sheet", "no Connect profile (connect.json): the sheet shows only the manifest's description");
  } else {
    add("ok", "connect sheet", `shown with connect.json's profile${run.icon ? run.sheet.icon ? " and the app's icon" : "; the icon grain.json names is not here (grain icon)" : " and the monogram (no icon yet: grain icon)"}`);
  }
  // The page's first load.
  if (run.load === null) {
    add("error", "open", "the page did not load in the simulator");
  } else if (run.load.status !== null && run.load.status >= 400) {
    add("error", "open", `${run.load.url} answered ${run.load.status}: no page there`);
  } else {
    add("ok", "open", `the page loaded (${new URL(run.load.url).pathname}${run.load.title ? `, "${run.load.title}"` : ""})`);
  }
  for (const e of run.errors) {
    if (e.where === "page") add("error", "page error", e.text);
    else add("warning", "simulator", e.text);
  }
  for (const r of run.refused) add("warning", "bridge", `${r.method} was refused: ${r.code} ${r.message}`);
  for (const d of run.dialogs) add("ok", "asked", `the simulator asked "${d.replace(/\s+/g, " ").slice(0, 120)}", and the check said yes`);
  // Every screen, both themes.
  for (const m of run.measures) {
    const where = `${m.device} ${m.theme}`;
    if (m.page === null) {
      add("error", "layout", "the page could not be read here", where);
      continue;
    }
    if (m.controls) {
      for (const t of m.tappables) {
        if (overlap(t.box, m.controls)) add("error", "controls", `${t.name} is under the wallet's controls ⋯ | ✕, where a tap closes the app or opens its sheet`, where);
      }
    }
    if (edgeToEdge(m)) {
      const status = { x: 0, y: 0, width: m.phone.width, height: m.bars.top };
      const nav = { x: 0, y: m.phone.height - m.bars.bottom, width: m.phone.width, height: m.bars.bottom };
      for (const t of m.tappables) {
        if (m.bars.top > 0 && overlap(t.box, status)) add("warning", "bars", `${t.name} is under the status bar: pad by --saltix-safe-top`, where);
        if (m.bars.bottom > 0 && overlap(t.box, nav)) add("warning", "bars", `${t.name} is under the navigation bar: pad by --saltix-safe-bottom`, where);
      }
    }
    if (m.page.scrollWidth > m.page.clientWidth + 1) {
      add("warning", "overflow", "the page is wider than the screen, so it scrolls sideways", `${where} (${m.page.scrollWidth} > ${m.page.clientWidth} px)`);
    }
  }
  // Both themes: a page brings its own design for each and follows grain_info.theme.
  const looks = new Map<string, Set<string>>();
  for (const m of run.measures) {
    if (!m.page) continue;
    const look = `${m.page.background} ${m.page.rootBackground} ${m.page.color}`;
    looks.set(m.device, (looks.get(m.device) ?? new Set()).add(`${m.theme}\u0000${look}`));
  }
  const same = [...looks.values()].every((seen) => new Set([...seen].map((s) => s.split("\u0000")[1])).size === 1);
  const themes = new Set(run.measures.map((m) => m.theme));
  if (looks.size > 0 && themes.size > 1 && same) {
    add("warning", "theme", "the page looks the same in the dark and the light theme: draw both, by grain_info.theme and the theme event");
  }
  const measured = run.measures.filter((m) => m.page !== null).length;
  if (measured > 0 && ![...found.values()].some((f) => f.what === "controls" || f.what === "layout")) {
    add("ok", "layout", `nothing tappable under the wallet's controls at ${new Set(run.measures.map((m) => m.device)).size} screens in ${themes.size} themes`);
  }
  const order = { error: 0, warning: 1, ok: 2 } as const;
  return [...found.values()].sort((a, b) => order[a.level] - order[b.level]);
}

/** A stable code for the log: the first error's kind, else `warnings` or `clean`. */
export function checkReason(findings: CheckFinding[]): string {
  const error = findings.find((f) => f.level === "error");
  if (error) return error.what.replace(/ /g, "_");
  return findings.some((f) => f.level === "warning") ? "warnings" : "clean";
}

/** Findings for people: one line each, the screens it holds at after it. */
export function findingLines(findings: CheckFinding[]): string[] {
  const tag = { error: "error", warning: "warn ", ok: "ok   " } as const;
  return findings.map((f) => {
    const where = f.where.length === 0 ? "" : f.where.length > 4 ? `: ${f.where.slice(0, 4).join(", ")} and ${f.where.length - 4} more` : `: ${f.where.join(", ")}`;
    return `${tag[f.level]} ${f.what.padEnd(14)} ${f.detail}${where}`;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `check()` until it gives something, at most `ms`: what it gave, or null. */
async function until<T>(check: () => Promise<T | null | undefined | false>, ms: number, every = 100): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value as T;
    if (Date.now() >= end) return null;
    await sleep(every);
  }
}

/** Drive the simulator at `origin` in `browser`: the sheet, the page, every screen in both themes, the screenshots. */
async function drive(browser: Browser, origin: string, out: string, icon: boolean): Promise<CheckRun> {
  const session = await browser.tab();
  const send = <T = Record<string, unknown>>(method: string, params: object = {}) => browser.send<T>(method, params, session);
  const contexts = new Map<number, string>();
  let mainFrame = "";
  const errors: CheckRun["errors"] = [];
  const dialogs: string[] = [];
  const whereOf = (context: unknown): "page" | "simulator" => {
    const frame = typeof context === "number" ? contexts.get(context) : undefined;
    return frame !== undefined && frame !== mainFrame ? "page" : "simulator";
  };
  browser.on((e) => {
    if (e.sessionId !== session) return;
    const p = e.params as Record<string, any>;
    if (e.method === "Runtime.executionContextCreated") contexts.set(p.context.id, p.context.auxData?.frameId ?? "");
    else if (e.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails;
      errors.push({ where: whereOf(d.executionContextId), text: String(d.exception?.description ?? d.text ?? "an exception").split("\n")[0]! });
    } else if (e.method === "Runtime.consoleAPICalled" && p.type === "error") {
      const text = (p.args as Array<{ value?: unknown; description?: string }>).map((a) => a.value ?? a.description ?? "").join(" ");
      errors.push({ where: whereOf(p.executionContextId), text: `console.error: ${text}`.slice(0, 300) });
    } else if (e.method === "Log.entryAdded" && p.entry?.level === "error") {
      const url = String(p.entry.url ?? "");
      // The icon is asked for whether or not the project has one (its absence is the sheet's to say), and the browser's own
      // favicon, which no wallet asks for.
      if (url.endsWith("/_icon.png") || url.endsWith("/favicon.ico")) return;
      // A failed load: the page's own files, or the simulator's (its own files, the development registry).
      const own = url.startsWith(origin) && !url.startsWith(`${origin}/_simulator/`) && !url.startsWith(`${origin}/api/dev`);
      errors.push({ where: own ? "page" : "simulator", text: `${p.entry.text}${url ? ` (${url.replace(origin, "")})` : ""}` });
    } else if (e.method === "Page.javascriptDialogOpening") {
      dialogs.push(String(p.message ?? ""));
      void send("Page.handleJavaScriptDialog", { accept: true, promptText: "" }).catch(() => undefined);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1900, height: 1300, deviceScaleFactor: 1, mobile: false });
  mainFrame = (await send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")).frameTree.frame.id;
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluate");
    return r.result.value as T;
  };
  const shot = async (m: Measure | null, name: string) => {
    const box = m ?? (await evaluate<Measure>("window.saltixSimulator.measure()"));
    const { data } = await send<{ data: string }>("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true,
      clip: { x: box.phone.page.x, y: box.phone.page.y, width: box.phone.width, height: box.phone.height, scale: 1 },
    });
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  await send("Page.navigate", { url: simulatorFor(origin) });
  const ready = await until(() => evaluate<boolean>("typeof window.saltixSimulator === 'object' && window.saltixSimulator.version === 1"), 20_000);
  if (!ready) throw new Error("the simulator did not load in the browser");
  // The Connect sheet comes first, read once its icon has loaded (or is known to be none); then the page opens.
  let sheet = await until(() => evaluate<SheetSeen | null>("window.saltixSimulator.sheet()"), 8_000);
  if (sheet) {
    sheet = (await until(async () => {
      const seen = await evaluate<SheetSeen | null>("window.saltixSimulator.sheet()");
      return seen && seen.iconState !== "loading" ? seen : null;
    }, 5_000)) ?? sheet;
    await sleep(300);
    await shot(null, "connect-sheet");
    await evaluate("window.saltixSimulator.continue()");
  }
  const first = await until(async () => {
    const m = await evaluate<Measure>("window.saltixSimulator.measure()");
    return m.page && m.page.ready === "complete" ? m : null;
  }, 20_000);
  // Its scripts settle: grain.info, the theme, the layout.
  await sleep(800);
  const measures: Measure[] = [];
  if (first) {
    const devices = await evaluate<string[]>("window.saltixSimulator.devices()");
    for (const theme of ["dark", "light"]) {
      for (const device of devices) {
        await evaluate(`window.saltixSimulator.set(${JSON.stringify({ device, theme })})`);
        await sleep(450);
        const m = await evaluate<Measure>("window.saltixSimulator.measure()");
        measures.push(m);
        await shot(m, `${theme}-${device}`);
      }
    }
  }
  const refused = await evaluate<CheckRun["refused"]>("window.saltixSimulator.refused()").catch(() => []);
  return { sheet, load: first?.page ?? null, measures, errors, refused, dialogs, icon };
}

export interface CheckOptions {
  dir: string;
  manifest: () => Manifest;
  secret: Uint8Array;
  log: DevLog;
  print?: (line: string) => void;
  /** The browser to drive (tests); `findBrowser()`'s by default, null for none. */
  browser?: string | null;
  /** The whole check, at most (90 s). */
  timeoutMs?: number;
}

/** `grain dev --check`: its exit status, 1 when the page has an error, or when there is no browser to check it with. */
export async function runCheck(o: CheckOptions): Promise<number> {
  const print = o.print ?? ((line: string) => console.log(line));
  const path = o.browser === undefined ? findBrowser() : o.browser;
  if (!path) {
    o.log.step("check", "refused", "no_browser");
    print("check: no Chrome, Chromium, Edge or Brave on this computer to drive the simulator headless. Install one, or set " +
      "CHROME_PATH to its program; meanwhile grain dev serves the simulator for a person to try");
    return 1;
  }
  const out = join(o.dir, CHECK_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const icon = !/^0+$/.test(o.manifest().icon ?? "0");
  const server = await serve(o.dir, o.manifest, o.secret, 0, "127.0.0.1");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = join(o.dir, GRAIN_DIR, "browser");
  let browser = Browser.launch(path, profile);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the check took longer than ${(o.timeoutMs ?? 90_000) / 1000} s`)), o.timeoutMs ?? 90_000);
  });
  try {
    let run: CheckRun;
    try {
      run = await Promise.race([drive(browser, origin, out, icon), deadline]);
    } catch (e) {
      // Linux without user namespaces for the browser's sandbox (Ubuntu 24.04's default, many containers): the page is
      // this computer's own, served here, so it is driven without one rather than not at all.
      if (!/sandbox/i.test((e as Error).message)) throw e;
      await browser.close();
      o.log.step("check", "waiting", "no_sandbox");
      print("check: the browser has no sandbox here (the system does not give it one): driving it without one, for this page served on this computer");
      browser = Browser.launch(path, profile, false);
      run = await Promise.race([drive(browser, origin, out, icon), deadline]);
    }
    const findings = judge(run);
    writeFileSync(join(out, "report.json"), JSON.stringify({ findings, run }, null, 2) + "\n");
    const errors = findings.filter((f) => f.level === "error").length;
    const warnings = findings.filter((f) => f.level === "warning").length;
    o.log.step("check", errors > 0 ? "refused" : "ok", checkReason(findings));
    print(`check: ${basename(path)} headless drove grain dev's simulator: the Connect sheet, then the page at ${new Set(run.measures.map((m) => m.device)).size} screens in both themes`);
    for (const line of findingLines(findings)) print(line);
    print(`screenshots and report.json: ${out}`);
    print(errors > 0
      ? `next: fix the ${errors === 1 ? "error" : `${errors} errors`} above, then grain dev --check again`
      : warnings > 0 ? "next: nothing stops the page; look at the warnings above and the screenshots" : "next: nothing: the page checks at every screen in both themes (grain doctor, then grain publish)");
    return errors > 0 ? 1 : 0;
  } catch (e) {
    o.log.step("check", "failed", "browser");
    throw new Error(`check: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
}
