// What `grain lint` says about a grain's pages (`public/`), besides its manifest. Saltix lays a page out inside the safe
// area unless it declares `viewport-fit=cover` (12-grains §7): then it is drawn under the status bar, the navigation bar
// and the wallet's controls, and keeps clear of them itself. Reading CSS without a browser is a heuristic, so these are
// warnings, never errors.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { viewportFitCover } from "@saltix/grain";

/** A page declares viewport-fit=cover, and nothing of the app reads the safe area. */
export const COVER_RULE = "cover-without-insets";
/** A page declares viewport-fit=cover, and a bar is pinned to its top without keeping clear. */
export const TOP_BAR_RULE = "full-screen-top-bar";

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
 * Warnings about the pages in `publicDir`. None while no page declares `viewport-fit=cover`: Saltix lays such pages out
 * inside the safe area itself. For an app with a page that does:
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
  const covers = files.filter((f) => PAGES.has(f.ext) && declaresCover(f.text));
  if (covers.length === 0) return [];
  const own = files.filter((f) => !(SCRIPTS.has(f.ext) && BRIDGE.test(f.text)));
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
