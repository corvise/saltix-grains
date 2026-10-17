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
 * - the band, the margins and the bars' icons in the page's colours, in Saltix's order (`frameColors`, `pageColorOf`):
 *   the band takes the colour the page gave with `grain_setHeader` (it holds until the next call), else its own; the
 *   page's own is its first `theme-color` whose `media` matches and which is a valid, opaque colour, else the
 *   background of its `<body>`, then `<html>`, else its canvas (by its `color-scheme`). It is read again when Saltix
 *   reads it: as the head is parsed and whenever the head changes, when the document is loaded, when the theme changes
 *   and when the system's dark preference does;
 * - the wallet's controls `⋯ | ✕`, a translucent capsule drawn to contrast with the band's colour, at the place
 *   `frameFor` gives: the same function and numbers the page SDK documents, so what a developer sees here is where
 *   Saltix puts them;
 * - ✕ closes the app; the system's Back goes back in the page's history first, then closes it; ⋯ opens a mock of the
 *   wallet's sheet;
 * - the loading screen (the app's initial and name, a thin progress line at the very top) while the page loads, gone
 *   once it has loaded, as in Saltix: `grain_ready` neither holds nor hides it;
 * - devices to test at: a phone (360 × 780 with a punch-hole), one on its side (the cutout on the left), the Galaxy Z
 *   Fold's 475 × 751, 704 × 932 and 932 × 704, and an iPhone-like screen (393 × 852 with a Dynamic Island). A change
 *   of device resizes the page and sends it `insets`, as the wallet does when the window changes.
 */
import {
  type Controls, type Frame, type PageLook, type SafeArea, type SystemInsets, LAYOUT_VARIABLES, frameColors, frameFor, pageColorOf, viewportFitCover,
  viewportOf,
} from "../packages/grain/src/index";

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
  /** The theme changed (or the app's name): repaint, and read the page's colour again once it has followed the theme,
   *  as Saltix does on its `theme` event. */
  repaint(): void;
  /** The app is opening at the frame's current URL. */
  opened(): void;
  /** Close the app: ✕, Back past the page's history, or `grain_close`. */
  close(why: string): void;
  /** Where the wallet's own sheets are drawn, as a page inside the safe area is: below the controls' band, clear of the
   *  bars, the cutout and the corners (19-connect §12); and the screen's size. */
  sheetFrame(): { view: SafeArea; width: number; height: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let paint: CanvasRenderingContext2D | null = null;

/** A CSS colour as `#rrggbb` when it is valid and opaque, else null, read by a canvas as the browser reads it: Saltix's
 *  own way (saltix-wallet frame.js). An invalid colour leaves `fillStyle` as it was, so two starting points tell. */
function opaque(value: string): string | null {
  try {
    paint ??= document.createElement("canvas").getContext("2d");
    if (!paint) return null;
    paint.fillStyle = "#000000";
    paint.fillStyle = value;
    const a = String(paint.fillStyle);
    paint.fillStyle = "#ffffff";
    paint.fillStyle = value;
    return a === String(paint.fillStyle) && /^#[0-9a-f]{6}$/.test(a) ? a : null;
  } catch {
    return null;
  }
}

/** What Saltix reads of a page's document for its colour. */
function lookOf(doc: Document): PageLook {
  const view = doc.defaultView;
  const matches = (media: string | null) => !media || (view?.matchMedia(media).matches ?? false);
  const style = (element: Element | null, property: string) => (element && view ? view.getComputedStyle(element).getPropertyValue(property) : null);
  return {
    themeColors: Array.from(doc.querySelectorAll('meta[name="theme-color" i]'), (m) => ({ content: m.getAttribute("content"), matches: matches(m.getAttribute("media")) })),
    body: doc.body !== null,
    bodyBackground: style(doc.body, "background-color"),
    rootBackground: style(doc.documentElement, "background-color"),
    colorScheme: style(doc.documentElement, "color-scheme"),
    prefersDark: view?.matchMedia("(prefers-color-scheme: dark)").matches ?? false,
  };
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
  // The colour the page gave with grain_setHeader: it holds until the next call, for as long as the app is open.
  let header: string | null = null;
  // The page's frame as its document declares it, and its own colour (`pageColorOf`), read from the page.
  let cover = false;
  let pageColor: string | null = null;
  // The top window's history once the app's first page loaded, and the Backs taken since: what is above it is the page's
  // own.
  let base = history.length;
  let backs = 0;
  let counting = false;

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
    // Saltix's order (12-grains §7, `frameColors`): the band takes the header colour, else the page's; the margins the
    // page's; where the page gave none, the wallet's own background and icons by its theme.
    const colors = frameColors(header, pageColor);
    const wallet = host.theme() === "dark" ? "#0b1020" : "#f4f6fb";
    phone.style.background = colors.around ?? wallet;
    band.style.background = colors.band ?? wallet;
    phone.dataset.glyphs = (colors.topDark ?? host.theme() === "dark") ? "light" : "dark";
    phone.dataset.navGlyphs = (colors.bottomDark ?? host.theme() === "dark") ? "light" : "dark";
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
    pageColor = pageColorOf(lookOf(doc), opaque);
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

  /** Read again on the frame after next: after the page has followed what changed (its own `theme` handler, say). */
  function soon(): void {
    requestAnimationFrame(() => requestAnimationFrame(read));
  }

  /** Follow the frame's document from as early as it can be read, as Saltix's script does: every addition while it is
   *  parsed until its body starts (the head has been read), then only its head's changes; and when it has loaded, the
   *  theme changes (`repaint`) or the system's dark preference does. Nothing else: a background changed in the body
   *  alone is seen by Saltix at the next of these, and here too. */
  function watch(): void {
    const doc = readable();
    if (!doc || doc === watched) return;
    watched = doc;
    observer?.disconnect();
    let onHead = false;
    const parsed = () => {
      read();
      if (onHead || !doc.head) return;
      observer?.disconnect();
      onHead = true;
      observer = new MutationObserver(soon);
      observer.observe(doc.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["content", "name", "media"] });
    };
    if (doc.body) parsed();
    else {
      observer = new MutationObserver(() => (doc.body ? parsed() : read()));
      observer.observe(doc, { childList: true, subtree: true });
    }
    doc.addEventListener("DOMContentLoaded", parsed);
    try {
      doc.defaultView?.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", soon);
    } catch {
      // A document that went away under us.
    }
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
  }

  const api: Phone = {
    insets,
    setHeader(color) {
      header = color;
      repaint();
    },
    repaint() {
      repaint();
      soon();
    },
    opened() {
      header = null;
      counting = true;
      showClosed(false);
      splash.hidden = false;
      watched = null;
      repaint();
      requestAnimationFrame(() => seek());
    },
    sheetFrame: () => ({ view: frameFor(systemOf(device), false).view, width: device.width, height: device.height }),
    close(why) {
      host.frame.src = "about:blank";
      hideSplash();
      showClosed(true);
      host.log(`closed (${why})`);
    },
  };

  // The splash goes once the page has loaded, as Saltix's does (12-grains §7): `grain_ready` neither holds nor hides it.
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
    if (host.frame.src !== "about:blank" && host.frame.src !== "") hideSplash();
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
