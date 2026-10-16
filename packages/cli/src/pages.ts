// What `grain lint` says about a grain's pages (`public/`), besides its manifest. Saltix lays a page out inside the safe
// area unless it declares `viewport-fit=cover` (12-grains §7): then it is drawn under the status bar, the navigation bar
// and the wallet's controls, and keeps clear of them itself. A page that signs in shows nothing of the app until its
// sign-in resolves (12-grains §5.1a: check first, render after). Reading pages without a browser is a heuristic, so
// these are warnings, never errors.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { viewportFitCover } from "@saltix/grain";

/** A page declares viewport-fit=cover, and nothing of the app reads the safe area. */
export const COVER_RULE = "cover-without-insets";
/** A page declares viewport-fit=cover, and a bar is pinned to its top without keeping clear. */
export const TOP_BAR_RULE = "full-screen-top-bar";
/** An app signs in, and a page shows something before the sign-in resolves, or no page marks a splash. */
export const GATE_RULE = "render-before-sign-in";
/** The attribute that marks a page's splash: what it shows until its sign-in resolves (the app's icon and name). */
export const SPLASH_ATTRIBUTE = "data-grain-splash";

const STYLED = new Set([".html", ".htm", ".css"]);
const PAGES = new Set([".html", ".htm"]);
const SCRIPTS = new Set([".js", ".mjs"]);
/** Files larger than this are not read: a bundle of a megabyte says nothing a page's own CSS does not. */
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 500;

/** What reads the safe area: the variables Saltix sets, the browser's own insets, or the values in a script. */
const SAFE_AREA = /--saltix-safe-|safe-area-inset-|safe_area|safeArea/;
/** What keeps a top bar clear in its own rule: the top inset, or the wallet's controls. */
const BAR_CLEAR = /--saltix-safe-top|--saltix-controls-|safe-area-inset-top/;
/** A script that asks for `grain_info` is the bridge (`grain.js`, `@saltix/grain`) or a bundle of it: it names the
 *  variables itself, so it says nothing about whether the page uses them. */
const BRIDGE = /["']grain_info["']/;

/** What signs in: the SDK's `grain.signIn`/`grain.login`, or the bridge's method by name. */
const SIGNS_IN = /\bsignIn\s*\(|\.login\s*\(|["']grain_login["']/;
/** Elements that are seen even when empty. */
const CONTENT = new Set(["img", "svg", "input", "button", "select", "textarea", "canvas", "video", "audio", "iframe", "object", "embed", "picture", "progress", "meter"]);
/** Elements that never have children. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * What a page's HTML shows before any script runs, outside its splash: the outermost elements in the body that hold
 * text, a content element (an image, a control) or any element at all (a skeleton's empty boxes), and text outside any
 * element. An element marked `data-grain-splash` or `hidden` shows nothing of what it holds, nor do scripts, styles and
 * templates; an empty element alone in the body (a mount point, a toast's box) shows nothing.
 */
export function shownBeforeSignIn(html: string): string[] {
  const doc = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const at = doc.search(/<body\b[^>]*>/i);
  const body = at < 0 ? doc.replace(/<head\b[\s\S]*?<\/head\s*>/i, "") : doc.slice(at).replace(/^<body\b[^>]*>/i, "");
  type Frame = { name: string; hides: boolean; shown: boolean; tag: string };
  const frames: Frame[] = [];
  const shown: string[] = [];
  const hidden = () => frames.some((f) => f.hides);
  /** Something seen at the current point: the open element holds it, or the body does. */
  const mark = (what: string) => {
    if (hidden()) return;
    if (frames.length === 0) shown.push(what);
    else frames[frames.length - 1]!.shown = true;
  };
  /** `f` closed: if it showed anything, so does what holds it, up to the body, where it is reported. */
  const closed = (f: Frame) => {
    if (f.shown && !f.hides) mark(f.tag);
  };
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      const text = m[4].replace(/&nbsp;|&#160;/g, " ").trim();
      if (text) mark(`"${text.length > 32 ? text.slice(0, 31) + "…" : text}"`);
      continue;
    }
    const name = m[2]!.toLowerCase();
    if (name === "body" || name === "html") continue;
    if (m[1]) {
      const open = frames.map((f) => f.name).lastIndexOf(name);
      if (open < 0) continue;
      while (frames.length > open) closed(frames.pop()!);
      continue;
    }
    const attrs = m[3] ?? "";
    const bare = attrs.replace(/"[^"]*"|'[^']*'/g, '""');
    const hides = new RegExp(`(?:^|\\s)(?:hidden|${SPLASH_ATTRIBUTE})(?=[\\s=/]|$)`, "i").test(bare);
    const id = attribute(m[0], "id");
    const cls = attribute(m[0], "class");
    const tag = `<${name}${id ? `#${id}` : cls ? `.${cls.trim().split(/\s+/)[0]}` : ""}>`;
    // An element inside another is structure being drawn (a skeleton's boxes are empty): the outer one shows. Alone in
    // the body, an empty element (a mount point, a toast's box) shows nothing.
    if (!hides && frames.length > 0) mark(tag);
    const leaf = VOID.has(name) || /\/\s*$/.test(attrs);
    if (leaf) {
      if (CONTENT.has(name) && !hides) mark(tag);
      continue;
    }
    frames.push({ name, hides, shown: CONTENT.has(name), tag });
  }
  while (frames.length > 0) closed(frames.pop()!);
  return shown;
}

/** A `top` (or `inset`'s first value) that pins a bar to the top edge: 0 in any unit, or a few pixels. */
function atTheTop(value: string): boolean {
  const v = value.replace(/!important/i, "").trim().toLowerCase();
  if (/^-?0*\.?0+(?:px|r?em|%|vh|svh|dvh|lvh|pt)?$/.test(v)) return true;
  const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
  return px !== null && Number(px[1]) <= 16;
}

/** Whether a rule's declarations make a fixed or sticky bar at the top that does not keep clear in the rule itself. */
function topBar(declarations: string): boolean {
  const props = new Map<string, string>();
  for (const d of declarations.split(";")) {
    const at = d.indexOf(":");
    if (at > 0) props.set(d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim());
  }
  const position = props.get("position")?.replace(/!important/i, "").trim().toLowerCase();
  if (position !== "fixed" && position !== "sticky") return false;
  const top = props.get("top") ?? props.get("inset-block-start") ?? props.get("inset")?.split(/\s+/)[0];
  return top !== undefined && atTheTop(top) && !BAR_CLEAR.test(declarations);
}

/** The CSS of a file: a stylesheet whole; a page's `<style>` blocks and `style` attributes. */
function cssOf(text: string, ext: string): Array<{ selector: string; declarations: string }> {
  const rules: Array<{ selector: string; declarations: string }> = [];
  const sheets = ext === ".css" ? [text] : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
  for (const sheet of sheets) {
    // Innermost blocks only: a rule inside `@media` is found as itself.
    for (const m of sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      rules.push({ selector: m[1]!.trim().replace(/\s+/g, " "), declarations: m[2]! });
    }
  }
  if (ext !== ".css") {
    for (const m of text.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\sstyle\s*=\s*(["'])([\s\S]*?)\2/gi)) {
      rules.push({ selector: `<${m[1]!.toLowerCase()} style>`, declarations: m[3]! });
    }
  }
  return rules;
}

/** Utility classes that make a top bar (`fixed top-0`, `sticky top-0`, as Tailwind writes them), without a class that
 *  reads the safe area beside them. */
function classBars(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\sclass\s*=\s*(["'])([^"']*)\2/gi)) {
    const classes = m[3]!.split(/\s+/);
    if ((classes.includes("fixed") || classes.includes("sticky")) && classes.includes("top-0") && !classes.some((c) => BAR_CLEAR.test(c))) {
      found.push(`<${m[1]!.toLowerCase()} class="${classes.filter((c) => c === "fixed" || c === "sticky" || c === "top-0").join(" ")}">`);
    }
  }
  return found;
}

/** An attribute of a tag's text, by its name (any case), quoted or not. */
function attribute(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** Whether a page declares `viewport-fit=cover`: its last viewport meta, read as Saltix reads it (12-grains §7). */
export function declaresCover(html: string): boolean {
  let content: string | null = null;
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<meta\b[^>]*>/gi)) {
    if (attribute(m[0], "name")?.toLowerCase() === "viewport") content = attribute(m[0], "content") ?? "";
  }
  return viewportFitCover(content);
}

/** The files of `dir` worth reading, below it, by extension. */
function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (out.length >= MAX_FILES || name.startsWith(".") || name === "node_modules") continue;
      const path = join(d, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && st.size <= MAX_FILE && (STYLED.has(extname(name).toLowerCase()) || SCRIPTS.has(extname(name).toLowerCase()))) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const listed = (items: string[]) => items.slice(0, 3).join(", ") + (items.length > 3 ? ` and ${items.length - 3} more` : "");

/**
 * Warnings about the pages in `publicDir`: whether the app shows anything before its sign-in resolves (`lintSignIn`),
 * and its frame. About the frame, none while no page declares `viewport-fit=cover`: Saltix lays such pages out inside
 * the safe area itself. For an app with a page that does:
 * - `cover-without-insets` when no page, stylesheet or script of the app's own there reads the safe area
 *   (`--saltix-safe-*`, `env(safe-area-inset-*)`, `safe_area`); the bridge, and a bundle of it, are not read for that;
 * - `full-screen-top-bar` for a fixed or sticky bar at the top (`position: fixed|sticky` with `top: 0` or a few pixels,
 *   or the utility classes `fixed top-0`) whose own rule keeps clear of neither the top inset nor the controls, unless a
 *   script of the app lays out by the safe area itself; in every stylesheet, and in the pages that declare it.
 * None for a missing directory.
 */
export function lintPages(publicDir: string): string[] {
  if (!existsSync(publicDir) || !statSync(publicDir).isDirectory()) return [];
  const files = filesOf(publicDir).map((file) => ({
    file,
    where: relative(publicDir, file).split("\\").join("/"),
    ext: extname(file).toLowerCase(),
    text: readFileSync(file, "utf8"),
  }));
  const own = files.filter((f) => !(SCRIPTS.has(f.ext) && BRIDGE.test(f.text)));
  return [...lintCover(files, own), ...lintSignIn(files, own)];
}

type PageFile = { file: string; where: string; ext: string; text: string };

/**
 * `render-before-sign-in`, when a page or script of the app's own signs in (`grain.signIn`, `grain.login`,
 * `grain_login`; the bridge itself is not read for that): for each page whose HTML shows something outside its splash
 * before any script runs (`shownBeforeSignIn`), and once when no page marks a splash (`data-grain-splash`), so nothing
 * says what it shows first. What a script draws before the sign-in resolves is not seen here.
 */
function lintSignIn(files: PageFile[], own: PageFile[]): string[] {
  if (!own.some((f) => SIGNS_IN.test(f.text))) return [];
  const pages = files.filter((f) => PAGES.has(f.ext));
  const warnings: string[] = [];
  for (const page of pages) {
    const shown = shownBeforeSignIn(page.text);
    if (shown.length === 0) continue;
    warnings.push(
      `${GATE_RULE}: ${page.where} shows ${listed(shown)} before the app's sign-in resolves, so someone it is not for sees ` +
      `the app's UI for a moment. Keep only a splash in the HTML (the app's icon and name, in an element marked ` +
      `${SPLASH_ATTRIBUTE}; the rest hidden, or drawn later), and draw the app or a refusal page once grain.signIn() and ` +
      "gateOf() decide (AGENTS.md: check first, render after). This is a heuristic: ignore it if what shows is not the app's.",
    );
  }
  if (pages.length > 0 && !pages.some((f) => new RegExp(`\\s${SPLASH_ATTRIBUTE}(?=[\\s=/>])`, "i").test(f.text))) {
    warnings.push(
      `${GATE_RULE}: the app signs in, and no page marks its splash (${SPLASH_ATTRIBUTE}): show the app's icon and name, ` +
      "and nothing else, until grain.signIn() resolves, then the app or a refusal page with none of its UI (AGENTS.md: " +
      "check first, render after).",
    );
  }
  return warnings;
}

/** `cover-without-insets` and `full-screen-top-bar`: nothing while no page declares `viewport-fit=cover`. */
function lintCover(files: PageFile[], own: PageFile[]): string[] {
  const covers = files.filter((f) => PAGES.has(f.ext) && declaresCover(f.text));
  if (covers.length === 0) return [];
  const readsSafeArea = own.some((f) => SAFE_AREA.test(f.text));
  const scriptLaysOut = own.some((f) => SCRIPTS.has(f.ext) && SAFE_AREA.test(f.text));
  const warnings: string[] = [];
  const pages = listed(covers.map((f) => f.where));
  if (!readsSafeArea) {
    warnings.push(
      `${COVER_RULE}: ${pages} declare${covers.length === 1 ? "s" : ""} viewport-fit=cover, so Saltix draws ` +
      `${covers.length === 1 ? "it" : "them"} under the status bar, the navigation bar and its controls ⋯ | ✕, but no page, ` +
      "stylesheet or script in public/ reads the safe area (--saltix-safe-*, env(safe-area-inset-*), grain_info.safe_area). " +
      "Pad by var(--saltix-safe-top) and the others (Saltix sets them on :root), or drop viewport-fit=cover and Saltix keeps " +
      "the whole page clear of them itself (AGENTS.md). This is a heuristic: ignore it if the page keeps clear another way.",
    );
  }
  const bars: string[] = [];
  if (!scriptLaysOut) {
    for (const f of files) {
      const linted = f.ext === ".css" || covers.includes(f);
      if (!linted) continue;
      for (const rule of cssOf(f.text, f.ext)) if (topBar(rule.declarations)) bars.push(`${f.where} (${rule.selector || "a rule"})`);
      if (f.ext !== ".css") for (const bar of classBars(f.text)) bars.push(`${f.where} (${bar})`);
    }
  }
  if (bars.length > 0) {
    warnings.push(
      `${TOP_BAR_RULE}: a fixed or sticky bar at the top in ${listed(bars)}, in an app whose ${pages} declare` +
      `${covers.length === 1 ? "s" : ""} viewport-fit=cover, keeps clear of neither the status bar nor the wallet's ⋯ | ✕ in its ` +
      "own rule: it sits under them. Pad it by var(--saltix-safe-top) and stop its title short of the controls " +
      "(calc(var(--saltix-controls-right) + var(--saltix-controls-width))), or drop viewport-fit=cover and Saltix lays the " +
      "page out below them (AGENTS.md). This is a heuristic: ignore it if the bar keeps clear another way.",
    );
  }
  return warnings;
}
