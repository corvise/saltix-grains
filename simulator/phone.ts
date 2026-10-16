/**
 * The phone around a grain, as Saltix frames it (12-grains §5, §7; bridge version 3), for `npm run dev` and `grain dev`
 * alike:
 * - the page **inside the safe area** by default: below the status bar, the cutout and the band that holds the
 *   wallet's controls, above the gesture bar or taskbar; the band and the margins in the page's colour;
 * - **edge to edge** when the page declares `viewport-fit=cover` in its viewport meta, read as Saltix reads it
 *   (`viewportFitCover`) as soon as its head is, and again when it changes: under the status bar and the bars, told how
 *   far they reach (`safe_area`) and where the controls are (`controls`);
 * - the CSS variables `--saltix-safe-*` and `--saltix-controls-*` set on the page's `:root`, as Saltix sets them (a page
 *   on another origin than the simulator's cannot be read: it stays inside the safe area, as in a wallet that cannot
 *   read it);
 * - the wallet's controls `⋯ | ✕`, a translucent capsule drawn to contrast with the page's header colour
 *   (`grain_setHeader`) or its own, at the place `frameFor` gives: the same function and numbers the page SDK documents,
 *   so what a developer sees here is where Saltix puts them;
 * - ✕ closes the app; the system's Back goes back in the page's history first, then closes it; ⋯ opens a mock of the
 *   wallet's sheet;
 * - the loading screen (the app's initial and name, a thin progress line at the very top) until `grain_ready`;
 * - devices to test at: a phone (360 × 780 with a punch-hole), one on its side (the cutout on the left), the Galaxy Z
 *   Fold's 475 × 751, 704 × 932 and 932 × 704, and an iPhone-like screen (393 × 852 with a Dynamic Island). A change
 *   of device resizes the page and sends it `insets`, as the wallet does when the window changes.
 */
import { type Controls, type Frame, type SafeArea, type SystemInsets, LAYOUT_VARIABLES, frameFor, viewportFitCover, viewportOf } from "../packages/grain/src/index";

/** A screen the simulator plays: its size and what of the system covers it, CSS px (dp, or points on an iPhone). */
export interface Device {
  id: string;
  label: string;
  width: number;
  height: number;
  /** The status bar's height (an iPhone's reaches below its Dynamic Island). */
  status: number;
  /** The cutout: a punch-hole, a Dynamic Island, or a camera on the left edge of a phone on its side. */
  cutout: { left: number; top: number; width: number; height: number; round: number } | null;
  /** What is at the bottom: a gesture handle (`gestures` deep), a taskbar, or nothing. */
  nav: { kind: "gestures" | "taskbar"; height: number };
  /** The screen's corner radius. */
  corner: number;
}

/** The devices AGENTS.md asks every app to be tested at, and two more. */
export const DEVICES: readonly Device[] = [
  {
    id: "phone", label: "Phone, 360 × 780 (punch-hole, gestures)", width: 360, height: 780, status: 32,
    cutout: { left: 169, top: 9, width: 22, height: 22, round: 11 }, nav: { kind: "gestures", height: 24 }, corner: 30,
  },
  {
    id: "phone-side", label: "Phone on its side, 780 × 360 (cutout left)", width: 780, height: 360, status: 24,
    cutout: { left: 6, top: 169, width: 22, height: 22, round: 11 }, nav: { kind: "gestures", height: 24 }, corner: 30,
  },
  {
    id: "fold-475", label: "Galaxy Z Fold, 475 × 751", width: 475, height: 751, status: 32,
    cutout: { left: 227, top: 9, width: 21, height: 21, round: 11 }, nav: { kind: "gestures", height: 24 }, corner: 26,
  },
  { id: "fold-704", label: "Galaxy Z Fold, 704 × 932 (taskbar)", width: 704, height: 932, status: 32, cutout: null, nav: { kind: "taskbar", height: 48 }, corner: 16 },
  { id: "fold-932", label: "Galaxy Z Fold, 932 × 704 (taskbar)", width: 932, height: 704, status: 32, cutout: null, nav: { kind: "taskbar", height: 48 }, corner: 16 },
  {
    id: "iphone", label: "iPhone-like, 393 × 852 (Dynamic Island)", width: 393, height: 852, status: 59,
    cutout: { left: 133, top: 11, width: 127, height: 37, round: 19 }, nav: { kind: "gestures", height: 34 }, corner: 55,
  },
];

/** What of the system covers `d`, as the wallet reads it (`SystemInsets`): a side cutout is the left edge's. */
export function systemOf(d: Device): SystemInsets {
  const side = d.cutout !== null && d.cutout.left < 40 && d.width > d.height;
  return {
    bars: { top: d.status, bottom: d.nav.height, left: side ? d.cutout!.left + d.cutout!.width + 4 : 0, right: 0 },
    cornerTop: d.corner,
    cornerBottom: d.corner,
  };
}

export interface PhoneHost {
  frame: HTMLIFrameElement;
  /** The app's name, for the loading screen and the sheet. */
  name(): string;
  theme(): "dark" | "light";
  log(line: string): void;
  /** Send the page an event of the bridge. */
  emit(event: string, data: object): void;
  /** Open the app's chat (the sheet's Chat). */
  openChat(): void;
  /** Open the app again (after ✕). */
  reopen(): void;
}

export interface Phone {
  /** What `grain_info` and the `insets` event say. */
  insets(): { safe_area: SafeArea; controls: Controls | null };
  /** The page asked for this header colour (`#rrggbb`). */
  setHeader(color: string): void;
  /** The theme changed: the bars and the controls follow it unless the page set a header colour. */
  repaint(): void;
  /** The app is opening at the frame's current URL. */
  opened(): void;
  /** The page says it is drawn (`grain_ready`). */
  ready(): void;
  /** Close the app: ✕, Back past the page's history, or `grain_close`. */
  close(why: string): void;
  /** Where the wallet's own sheets are drawn, as a page inside the safe area is: below the controls' band, clear of the
   *  bars, the cutout and the corners (19-connect §12); and the screen's size. */
  sheetFrame(): { view: SafeArea; width: number; height: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Whether `#rrggbb` is light enough for dark glyphs on it (relative luminance above one half, roughly). */
function light(color: string): boolean {
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

/** A computed colour (`rgb(…)`, `rgba(…)`) as `#rrggbb` when it is opaque, else null. */
function hex(css: string | null | undefined): string | null {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec((css ?? "").trim());
  if (!m || (m[4] !== undefined && Number(m[4]) < 1)) return null;
  return "#" + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
}

export function setupPhone(host: PhoneHost): Phone {
  const phone = $("phone");
  const capsule = $("capsule");
  const status = $("status-bar");
  const nav = $("nav-bar");
  const cutout = $("cutout");
  const band = $("band");
  const mode = $("frame-mode");
  const splash = $("splash");
  const closed = $("closed");
  const sheet = $("sheet");
  const select = $<HTMLSelectElement>("size");
  let device = DEVICES[0]!;
  let header: string | null = null;
  // The page's frame as its document declares it, and its colour (theme-color or background), read from the page.
  let cover = false;
  let pageColor: string | null = null;
  // The top window's history once the app's first page loaded, and the Backs taken since: what is above it is the page's
  // own.
  let base = history.length;
  let backs = 0;
  let counting = false;
  let splashTimer: ReturnType<typeof setTimeout> | null = null;

  const frameNow = (): Frame => frameFor(systemOf(device), cover);
  const insets = () => {
    const f = frameNow();
    return { safe_area: f.safe_area, controls: f.controls };
  };

  function place(): void {
    phone.style.width = `${device.width}px`;
    phone.style.height = `${device.height}px`;
    phone.style.borderRadius = `${device.corner}px`;
    const f = frameNow();
    const v = f.view;
    // An iframe is not stretched by its insets: its size is set.
    Object.assign(host.frame.style, {
      top: `${v.top}px`, left: `${v.left}px`, width: `${device.width - v.left - v.right}px`, height: `${device.height - v.top - v.bottom}px`,
    });
    band.hidden = f.cover;
    band.style.height = `${v.top}px`;
    status.style.height = `${device.status}px`;
    nav.style.height = `${device.nav.height}px`;
    nav.dataset.kind = device.nav.kind;
    const c = device.cutout;
    cutout.hidden = c === null;
    if (c) Object.assign(cutout.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px`, borderRadius: `${c.round}px` });
    const k = f.capsule;
    Object.assign(capsule.style, { top: `${k.top}px`, right: `${k.right}px`, width: `${k.width}px`, height: `${k.height}px` });
    mode.textContent = f.cover
      ? "Edge to edge: the page declares viewport-fit=cover, and is told safe_area and controls."
      : "Inside the safe area: the page does not declare viewport-fit=cover; nothing is over it (safe_area 0, controls null).";
    paintVariables();
    repaint();
  }

  function repaint(): void {
    // The band and the margins take the page's colour; glyphs contrast with its header colour, else its own, else the
    // theme's background.
    const top = header ?? pageColor;
    phone.style.background = pageColor ?? (host.theme() === "dark" ? "#0b1020" : "#f4f6fb");
    band.style.background = top ?? phone.style.background;
    const dark = top ? !light(top) : host.theme() === "dark";
    phone.dataset.glyphs = dark ? "light" : "dark";
    $("splash-name").textContent = host.name();
    $("splash-icon").textContent = host.name().slice(0, 1).toUpperCase();
    $("sheet-name").textContent = host.name();
  }

  // ── the page's document, read and given its variables as Saltix does (same origin only) ──
  let watched: Document | null = null;
  let observer: MutationObserver | null = null;
  let sheetOf: { doc: Document; sheet: CSSStyleSheet } | null = null;

  function paintVariables(): void {
    const doc = readable();
    if (!doc) return;
    const f = frameNow();
    const s = f.safe_area;
    const c = f.controls ?? { top: 0, right: 0, width: 0, height: 0 };
    const v = LAYOUT_VARIABLES;
    const css = `:root{${v.safeTop}:${s.top}px;${v.safeRight}:${s.right}px;${v.safeBottom}:${s.bottom}px;${v.safeLeft}:${s.left}px;` +
      `${v.controlsTop}:${c.top}px;${v.controlsRight}:${c.right}px;${v.controlsWidth}:${c.width}px;${v.controlsHeight}:${c.height}px}`;
    try {
      const view = doc.defaultView as (Window & typeof globalThis) | null;
      if (!view) return;
      if (sheetOf?.doc !== doc) sheetOf = { doc, sheet: new view.CSSStyleSheet() };
      sheetOf.sheet.replaceSync(css);
      const list = Array.from(doc.adoptedStyleSheets);
      if (!list.includes(sheetOf.sheet)) doc.adoptedStyleSheets = [...list, sheetOf.sheet];
    } catch {
      // A document that went away under us: the next one is read when it loads.
    }
  }

  /** The page's document when the simulator may read it (same origin), else null. */
  function readable(): Document | null {
    try {
      const doc = host.frame.contentDocument;
      return doc && doc.location.href !== "about:blank" ? doc : null;
    } catch {
      return null;
    }
  }

  /** Read the page's declaration and colour; a change of frame resizes the page and tells it. */
  function read(): void {
    const doc = readable();
    if (!doc) return;
    // Until the head has been read, no meta yet says nothing yet.
    const meta = viewportOf(doc);
    if (meta === null && !doc.body && doc.readyState === "loading") return;
    const next = viewportFitCover(meta);
    const body = doc.body ? hex(doc.defaultView?.getComputedStyle(doc.body).backgroundColor) : null;
    const theme = doc.querySelector('meta[name="theme-color" i]')?.getAttribute("content") ?? null;
    pageColor = (theme && /^#[0-9a-f]{6}$/i.test(theme) ? theme : null) ?? body;
    if (next !== cover) {
      cover = next;
      place();
      host.emit("insets", insets());
      host.log(`frame: ${cover ? "edge to edge (viewport-fit=cover)" : "inside the safe area"}: insets sent`);
    } else {
      paintVariables();
      repaint();
    }
  }

  /** Follow the frame's document from as early as it can be read: its head as it is parsed, then its changes. */
  function watch(): void {
    const doc = readable();
    if (!doc || doc === watched) return;
    watched = doc;
    observer?.disconnect();
    observer = new MutationObserver(read);
    observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ["content", "name", "media", "style", "class"] });
    doc.addEventListener("DOMContentLoaded", read);
    paintVariables();
    read();
  }

  /** A new document is looked for each frame until it is there: an iframe says nothing when its document starts. */
  function seek(tries = 120): void {
    watch();
    if (watched !== readable() || tries <= 0) return;
    if (readable()?.readyState === "loading") requestAnimationFrame(() => seek(tries - 1));
  }

  function showClosed(on: boolean): void {
    closed.hidden = !on;
    capsule.hidden = on;
    sheet.hidden = true;
  }

  function hideSplash(): void {
    splash.hidden = true;
    if (splashTimer) clearTimeout(splashTimer);
    splashTimer = null;
  }

  const api: Phone = {
    insets,
    setHeader(color) {
      header = color;
      repaint();
    },
    repaint,
    opened() {
      header = null;
      counting = true;
      showClosed(false);
      splash.hidden = false;
      watched = null;
      repaint();
      requestAnimationFrame(() => seek());
    },
    ready: hideSplash,
    sheetFrame: () => ({ view: frameFor(systemOf(device), false).view, width: device.width, height: device.height }),
    close(why) {
      host.frame.src = "about:blank";
      hideSplash();
      showClosed(true);
      host.log(`closed (${why})`);
    },
  };

  // A page that never says it is ready is shown once loaded, as a wallet would not keep its splash for ever.
  host.frame.addEventListener("load", () => {
    if (counting) {
      counting = false;
      base = history.length;
      backs = 0;
    }
    watch();
    read();
    if (!readable() && host.frame.src !== "about:blank" && host.frame.src !== "") {
      host.log("frame: the page is on another origin than the simulator's: it stays inside the safe area, as in a wallet that cannot read it");
    }
    if (!splash.hidden && !splashTimer) splashTimer = setTimeout(hideSplash, 2_500);
  });

  select.replaceChildren(...DEVICES.map((d) => Object.assign(document.createElement("option"), { value: d.id, textContent: d.label })));
  select.onchange = () => {
    device = DEVICES.find((d) => d.id === select.value) ?? DEVICES[0]!;
    place();
    // The window changed: the page gets its own resize, and the wallet's word on its insets.
    host.emit("insets", insets());
    host.log(`${device.label}: insets sent`);
  };
  $<HTMLInputElement>("box").onchange = (e) => capsule.classList.toggle("outlined", (e.target as HTMLInputElement).checked);
  $<HTMLButtonElement>("close").onclick = () => api.close("✕");
  $<HTMLButtonElement>("reopen").onclick = () => host.reopen();
  $<HTMLButtonElement>("more").onclick = () => {
    sheet.hidden = false;
  };
  sheet.onclick = (e) => {
    if (e.target === sheet) sheet.hidden = true;
  };
  sheet.querySelectorAll<HTMLButtonElement>("button[data-row]").forEach((row) => {
    row.onclick = () => {
      sheet.hidden = true;
      const what = row.dataset.row!;
      if (what === "chat") host.openChat();
      else if (what === "reload") host.reopen();
      else host.log(`⋯ ${row.textContent}: the wallet's own (a mock here)`);
    };
  });
  $<HTMLButtonElement>("back").onclick = () => {
    // Back on the Connect sheet is its Cancel: nothing opens and nothing is sent.
    const connect = phone.querySelector<HTMLButtonElement>(".connect-scrim .cs-cancel");
    if (connect) {
      connect.click();
      return;
    }
    if (!closed.hidden) return;
    if (!sheet.hidden) {
      sheet.hidden = true;
      return;
    }
    // Back goes through the page's own history first (12-grains §7), then closes the app.
    if (!counting && history.length - base - backs > 0) {
      try {
        host.frame.contentWindow!.history.back();
        backs++;
        host.log("Back: the page's history");
        return;
      } catch {
        // Another origin's page: its history is not ours to walk.
      }
    }
    api.close("Back");
  };
  place();
  return api;
}
