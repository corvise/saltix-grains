/**
 * The phone around a grain, as Saltix draws it (12-grains §5, §7; bridge version 3), for `npm run dev` and `grain dev`
 * alike:
 * - the page edge to edge, under a status bar and a gesture navigation bar whose size it learns (`safe_area`);
 * - the wallet's controls `⋯ | ✕` floating in the top right corner, a translucent capsule on a blur, drawn to contrast
 *   with the page's header colour (`grain_setHeader`) or its theme, in the box `controlsFor` gives (`controls`): the same
 *   function and numbers the page SDK documents, so what a developer sees here is where Saltix puts them;
 * - ✕ closes the app; the system's Back goes back in the page's history first, then closes it; ⋯ opens a mock of the
 *   wallet's sheet;
 * - the loading screen (the app's initial and name, a thin progress line at the very top) until `grain_ready`;
 * - sizes to test at: a phone, and the Galaxy Z Fold's 475 × 751, 704 × 932 and 932 × 704 (CSS px = dp). A change of
 *   size resizes the page and sends it `insets`, as the wallet does when the window resizes.
 */
import { type Controls, type SafeArea, controlsFor } from "../packages/grain/src/index";

export interface Size {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** A phone, then the sizes AGENTS.md asks every app to be tested at. */
export const SIZES: readonly Size[] = [
  { id: "phone", label: "Phone, 390 × 844", width: 390, height: 844 },
  { id: "fold-475", label: "Galaxy Z Fold, 475 × 751", width: 475, height: 751 },
  { id: "fold-704", label: "Galaxy Z Fold, 704 × 932", width: 704, height: 932 },
  { id: "fold-932", label: "Galaxy Z Fold, 932 × 704", width: 932, height: 704 },
];

/** The system's bars the simulator plays, in CSS px: a status bar and a gesture navigation bar. */
export const BARS: SafeArea = { top: 32, bottom: 24, left: 0, right: 0 };

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
  insets(): { safe_area: SafeArea; controls: Controls };
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
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Whether `#rrggbb` is light enough for dark glyphs on it (relative luminance above one half, roughly). */
function light(color: string): boolean {
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

export function setupPhone(host: PhoneHost): Phone {
  const phone = $("phone");
  const capsule = $("capsule");
  const status = $("status-bar");
  const nav = $("nav-bar");
  const splash = $("splash");
  const closed = $("closed");
  const sheet = $("sheet");
  const select = $<HTMLSelectElement>("size");
  let size = SIZES[0]!;
  let header: string | null = null;
  // The top window's history once the app's first page loaded, and the Backs taken since: what is above it is the page's
  // own.
  let base = history.length;
  let backs = 0;
  let counting = false;
  let splashTimer: ReturnType<typeof setTimeout> | null = null;

  const insets = () => ({ safe_area: { ...BARS }, controls: controlsFor(BARS) });

  function place(): void {
    phone.style.width = `${size.width}px`;
    phone.style.height = `${size.height}px`;
    const { safe_area: s, controls: c } = insets();
    status.style.height = `${s.top}px`;
    nav.style.height = `${s.bottom}px`;
    Object.assign(capsule.style, { top: `${c.top}px`, right: `${c.right}px`, width: `${c.width}px`, height: `${c.height}px` });
  }

  function repaint(): void {
    // Glyphs contrast with the page's header colour when it set one, else with its theme's background.
    const dark = header ? !light(header) : host.theme() === "dark";
    phone.dataset.glyphs = dark ? "light" : "dark";
    $("splash-name").textContent = host.name();
    $("splash-icon").textContent = host.name().slice(0, 1).toUpperCase();
    $("sheet-name").textContent = host.name();
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
      repaint();
    },
    ready: hideSplash,
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
    if (!splash.hidden && !splashTimer) splashTimer = setTimeout(hideSplash, 2_500);
  });

  select.replaceChildren(...SIZES.map((s) => Object.assign(document.createElement("option"), { value: s.id, textContent: s.label })));
  select.onchange = () => {
    size = SIZES.find((s) => s.id === select.value) ?? SIZES[0]!;
    place();
    // The window resized: the page gets its own resize, and the wallet's word on its insets.
    host.emit("insets", insets());
    host.log(`size ${size.width} × ${size.height}: insets sent`);
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
  repaint();
  return api;
}
