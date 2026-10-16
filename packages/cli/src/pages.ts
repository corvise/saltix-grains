// What `grain lint` says about a grain's pages (`public/`), besides its manifest. Saltix shows every app full screen
// (12-grains §7): a page's fixed or sticky top bar sits under the status bar and the wallet's controls unless it keeps
// clear of them. Reading CSS without a browser is a heuristic, so these are warnings, never errors.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** The rule's id, at the start of its warning. */
export const TOP_BAR_RULE = "full-screen-top-bar";

const STYLED = new Set([".html", ".htm", ".css"]);
const SCRIPTS = new Set([".js", ".mjs"]);
/** Files larger than this are not read: a bundle of a megabyte says nothing a page's own CSS does not. */
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 500;

/** What a page uses to keep clear of the bars and the controls: the variables `grain.layout()` sets, the browser's own
 *  top inset, or the values themselves in a script. */
const KEEPS_CLEAR = /--saltix-(?:safe|controls)-|safe-area-inset-top|safe_area|safeArea/;
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

/** Whether a rule's declarations make a fixed or sticky bar at the top. */
function topBar(declarations: string): boolean {
  const props = new Map<string, string>();
  for (const d of declarations.split(";")) {
    const at = d.indexOf(":");
    if (at > 0) props.set(d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim());
  }
  const position = props.get("position")?.replace(/!important/i, "").trim().toLowerCase();
  if (position !== "fixed" && position !== "sticky") return false;
  const top = props.get("top") ?? props.get("inset-block-start") ?? props.get("inset")?.split(/\s+/)[0];
  return top !== undefined && atTheTop(top);
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

/** Utility classes that make a top bar (`fixed top-0`, `sticky top-0`, as Tailwind writes them). */
function classBars(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\sclass\s*=\s*(["'])([^"']*)\2/gi)) {
    const classes = m[3]!.split(/\s+/);
    if ((classes.includes("fixed") || classes.includes("sticky")) && classes.includes("top-0")) {
      found.push(`<${m[1]!.toLowerCase()} class="${classes.filter((c) => c === "fixed" || c === "sticky" || c === "top-0").join(" ")}">`);
    }
  }
  return found;
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

/**
 * Warnings about the pages in `publicDir`: a fixed or sticky top bar (`position: fixed|sticky` with `top: 0` or a few
 * pixels, or the utility classes `fixed top-0`) while no page, stylesheet or script of the app's own there uses the safe
 * area or the wallet's controls (`--saltix-safe-*`, `--saltix-controls-*`, `env(safe-area-inset-top)`, `safe_area`):
 * the bridge, and a bundle of it, are not read for that. None for a missing directory.
 */
export function lintPages(publicDir: string): string[] {
  if (!existsSync(publicDir) || !statSync(publicDir).isDirectory()) return [];
  const bars: string[] = [];
  let keepsClear = false;
  for (const file of filesOf(publicDir)) {
    const text = readFileSync(file, "utf8");
    const ext = extname(file).toLowerCase();
    if (KEEPS_CLEAR.test(text) && !(SCRIPTS.has(ext) && BRIDGE.test(text))) keepsClear = true;
    if (!STYLED.has(ext)) continue;
    const where = relative(publicDir, file).split("\\").join("/");
    for (const rule of cssOf(text, ext)) if (topBar(rule.declarations)) bars.push(`${where} (${rule.selector || "a rule"})`);
    if (ext !== ".css") for (const bar of classBars(text)) bars.push(`${where} (${bar})`);
  }
  if (bars.length === 0 || keepsClear) return [];
  const listed = bars.slice(0, 3).join(", ") + (bars.length > 3 ? ` and ${bars.length - 3} more` : "");
  return [
    `${TOP_BAR_RULE}: a fixed or sticky top bar in ${listed}, but no page in public/ uses the safe area or the wallet's controls ` +
    "(--saltix-safe-*, --saltix-controls-*, env(safe-area-inset-top)). Saltix shows apps full screen: such a bar sits under the " +
    "status bar and the wallet's ⋯ | ✕. Pad it by var(--saltix-safe-top) and stop its title short of the controls " +
    "(calc(var(--saltix-controls-right) + var(--saltix-controls-width))); grain.layout() sets the variables (AGENTS.md). " +
    "This is a heuristic: ignore it if the bar keeps clear another way.",
  ];
}
