/**
 * `@saltix/grain`: the bridge between a grain and the Saltix wallet it runs in
 * (Saltix specs/12-grains.md §5, bridge version 1; the chat, 22-grain-chats §5, version 2; the page's frame, its
 * insets and the wallet's controls, and the app's own manage page, version 3: `grain.layout()`, `grain.manage.open()`).
 *
 * In a wallet the page has `window.saltix`, defined before its scripts run; in the simulator
 * (an iframe named `saltix-simulator`) requests go to the simulator page instead. Outside both,
 * `inWallet()` is false and `walletLink()` gives the link that opens the grain in a wallet.
 *
 * Every method returns a promise that rejects with a `GrainError` carrying the wallet's code.
 */

/** Codes a wallet answers with (EIP-1193's where they fit). */
export const ErrorCode = {
  UserRejected: 4001,
  NotPermitted: 4100,
  Unsupported: 4200,
  RateLimited: 4290,
  InvalidParams: -32602,
  Failed: 5000,
  /** Not in a wallet (or the simulator): nothing to ask. */
  NoWallet: 4900,
} as const;

// ── the page's frame (12-grains §5, §7; bridge version 3) ──
//
// Saltix opens every grain as a full app, its own controls (`⋯ | ✕`) floating in the top right corner, and lays the page
// out as browsers do: inside the safe area by default (below the status bar, a cutout and a band that holds the
// controls; above the navigation bar or gesture area and the keyboard), edge to edge only for a page that declares
// `viewport-fit=cover` in its viewport meta (`viewportFitCover`). Such a page keeps its text and controls inside the safe
// area, and every tappable element out of the controls' box. Saltix sets the CSS variables (`LAYOUT_VARIABLES`) on the
// page's `:root` itself; what the page reads, and every fallback, is decided in one place (`layoutOf`):
// - Saltix with bridge 3 or newer: the wallet's `safe_area` and `controls` (0 and none inside the safe area);
// - Saltix with bridge 1 or 2: its header sits above the page, so nothing of the page is under the system's bars: a
//   safe area of 0 and no controls;
// - a plain browser (no wallet): the browser's own insets (`env(safe-area-inset-*)`) and no controls.
// In CSS pixels, which equal dp in a grain's view. This file is copied whole into projects (`grain init`): it stays one
// module.

/** How far the status bar, the navigation bar and a display cutout reach into the page from each edge. */
export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The wallet's controls over the page: `top` from the page's top edge, `right` from its right edge. */
export interface Controls {
  top: number;
  right: number;
  width: number;
  height: number;
}

/** Where the page is drawn, and what is over it. */
export interface Layout {
  safeArea: SafeArea;
  /** The wallet's controls over the page, or null where there are none (a page inside the safe area, Saltix bridge 1–2,
   *  a plain browser). */
  controls: Controls | null;
  /** Where the values come from: Saltix with bridge 3 or newer (`wallet`), an older Saltix (`legacy`), or no wallet
   *  (`browser`). */
  source: "wallet" | "legacy" | "browser";
}

/** What the wallet answers in `grain_info` and in the `insets` event, as far as the layout reads it. */
export interface LayoutInfo {
  bridge?: number;
  safe_area?: Partial<SafeArea> | null;
  controls?: Partial<Controls> | null;
}

/**
 * The wallet's controls (12-grains §7, §11): two 48 dp targets, ⋯ then ✕, in a box 96 × 48 dp, 8 dp from the right
 * inset and 4 dp below the top inset.
 */
export const CONTROLS_BOX = { width: 96, height: 48, right: 8, below: 4 } as const;

/** The first bridge version that tells the page its frame (`safe_area` with its four sides, `controls`, `insets`). */
export const FULL_SCREEN_BRIDGE = 3;

/** The band above a page inside the safe area (12-grains §7, §11): the controls' box and 4 px above and below it. */
export const BAND = CONTROLS_BOX.below + CONTROLS_BOX.height + CONTROLS_BOX.below;

/** ASCII letters in lower case, nothing else changed: the viewport meta's keys and values compare so (12-grains §7). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Whether a viewport meta's `content` asks Saltix to draw the page edge to edge (12-grains §7), as Saltix reads it: split
 * at commas, semicolons and whitespace into `key=value` pairs (whitespace allowed around `=`), keys and values ASCII
 * case-insensitive, the last `viewport-fit` deciding; only `cover` is edge to edge. No meta (`null`) is not.
 */
export function viewportFitCover(content: string | null | undefined): boolean {
  if (content == null) return false;
  let fit: string | null = null;
  for (const m of content.matchAll(/([^\s,;=]+)\s*=\s*([^\s,;=]*)/g)) {
    if (asciiLower(m[1]!) === "viewport-fit") fit = m[2]!;
  }
  return fit !== null && asciiLower(fit) === "cover";
}

/** The content of a document's last viewport meta, or null when it has none. */
export function viewportOf(doc: { querySelectorAll?(selector: string): ArrayLike<{ getAttribute(name: string): string | null }> } | undefined): string | null {
  const metas = doc?.querySelectorAll?.('meta[name="viewport" i]');
  if (!metas || metas.length === 0) return null;
  return metas[metas.length - 1]!.getAttribute("content") ?? "";
}

/** The system's UI over a window, CSS px: `bars` from each edge (status and navigation bars, a cutout, the gesture
 *  area), an open `keyboard` from the bottom, the largest radius of the screen's corners on its top and bottom edges. */
export interface SystemInsets {
  bars: SafeArea;
  keyboard?: number;
  cornerTop?: number;
  cornerBottom?: number;
}

/** A page's frame as Saltix lays it out: `view`, how far the page's viewport is inset in the window; `safe_area` and
 *  `controls`, what the page is told; `capsule`, where the controls are drawn, from the window's top and right edges. */
export interface Frame {
  cover: boolean;
  view: SafeArea;
  safe_area: SafeArea;
  controls: Controls | null;
  capsule: Controls;
}

/** ⌈r · (1 − 1/√2)⌉: how deep a rounded corner of radius `r` reaches in at its arc's 45° point (12-grains §11). */
export const cornerDepth = (r: number): number => (r > 0 ? Math.ceil(r * (1 - Math.SQRT1_2) - 1e-9) : 0);

/**
 * The frame Saltix gives a page under `system`: edge to edge when it declared `viewport-fit=cover` (`cover`), inside the
 * safe area and below the band otherwise. The controls sit at one place in the window in both. For tools that play the
 * wallet (the simulator, `grain dev`): the same rule as Saltix's.
 */
export function frameFor(system: SystemInsets, cover: boolean): Frame {
  const b = system.bars;
  const s: SafeArea = {
    top: Math.max(length(b.top), cornerDepth(length(system.cornerTop))),
    bottom: Math.max(length(b.bottom), cornerDepth(length(system.cornerBottom))),
    left: length(b.left),
    right: length(b.right),
  };
  const keyboard = length(system.keyboard);
  const capsule = controlsFor(s);
  if (cover) {
    return {
      cover: true, view: { top: 0, bottom: keyboard, left: 0, right: 0 },
      safe_area: { ...s, bottom: Math.max(0, s.bottom - keyboard) }, controls: capsule, capsule,
    };
  }
  return {
    cover: false, view: { top: s.top + BAND, bottom: Math.max(s.bottom, keyboard), left: s.left, right: s.right },
    safe_area: { ...ZERO }, controls: null, capsule,
  };
}

/** The CSS custom properties `grain.layout()` sets on `:root`, in pixels. */
export const LAYOUT_VARIABLES = {
  safeTop: "--saltix-safe-top",
  safeBottom: "--saltix-safe-bottom",
  safeLeft: "--saltix-safe-left",
  safeRight: "--saltix-safe-right",
  controlsTop: "--saltix-controls-top",
  controlsRight: "--saltix-controls-right",
  controlsWidth: "--saltix-controls-width",
  controlsHeight: "--saltix-controls-height",
} as const;

const ZERO: SafeArea = { top: 0, bottom: 0, left: 0, right: 0 };

/** Where Saltix draws its controls over a page whose insets are `safeArea`: what a wallet reports as `controls`. For
 *  tools that play the wallet (the simulator, `grain dev`). */
export function controlsFor(safeArea: SafeArea): Controls {
  return { top: safeArea.top + CONTROLS_BOX.below, right: safeArea.right + CONTROLS_BOX.right, width: CONTROLS_BOX.width, height: CONTROLS_BOX.height };
}

/** A length the wallet gave: a finite number of 0 or more, anything else 0 (a field it does not give is 0). */
const length = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The layout from what the wallet answered (`grain_info`, or an `insets` event with the bridge it came under), or from
 * nothing (`info` null: no wallet) with the browser's own insets. Every fallback is here, and nowhere else.
 */
export function layoutOf(info: LayoutInfo | null, insets: SafeArea = ZERO): Layout {
  if (info === null) return { safeArea: { ...insets }, controls: null, source: "browser" };
  if ((info.bridge ?? 1) < FULL_SCREEN_BRIDGE) return { safeArea: { ...ZERO }, controls: null, source: "legacy" };
  const s = info.safe_area ?? {};
  const c = info.controls;
  return {
    safeArea: { top: length(s.top), bottom: length(s.bottom), left: length(s.left), right: length(s.right) },
    controls: c ? { top: length(c.top), right: length(c.right), width: length(c.width), height: length(c.height) } : null,
    source: "wallet",
  };
}

const px = (n: number) => `${n}px`;

/** The values `grain.layout()` gives the CSS variables: pixels, or in a plain browser the browser's own insets, so that
 *  they follow its viewport without a script. Controls that are not there are 0. */
export function cssVariables(layout: Layout): Record<string, string> {
  const v = LAYOUT_VARIABLES;
  const s = layout.safeArea;
  const c = layout.controls ?? { top: 0, right: 0, width: 0, height: 0 };
  const safe: Record<keyof SafeArea, string> = layout.source === "browser"
    ? { top: "env(safe-area-inset-top, 0px)", bottom: "env(safe-area-inset-bottom, 0px)", left: "env(safe-area-inset-left, 0px)", right: "env(safe-area-inset-right, 0px)" }
    : { top: px(s.top), bottom: px(s.bottom), left: px(s.left), right: px(s.right) };
  return {
    [v.safeTop]: safe.top, [v.safeBottom]: safe.bottom, [v.safeLeft]: safe.left, [v.safeRight]: safe.right,
    [v.controlsTop]: px(c.top), [v.controlsRight]: px(c.right), [v.controlsWidth]: px(c.width), [v.controlsHeight]: px(c.height),
  };
}

interface Doc {
  documentElement?: { style?: { setProperty(name: string, value: string): void } };
  body?: { appendChild(node: unknown): unknown };
  createElement?(tag: string): { style: { cssText: string }; remove(): void };
}

/** The browser's own insets in pixels, measured where there is a document (0 elsewhere). */
export function browserInsets(): SafeArea {
  const g = globalThis as unknown as { document?: Doc; getComputedStyle?: (e: unknown) => Record<string, string> };
  const d = g.document;
  if (!d?.body || !d.createElement || typeof g.getComputedStyle !== "function") return { ...ZERO };
  const probe = d.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  d.body.appendChild(probe);
  const style = g.getComputedStyle(probe);
  const read = (v: string | undefined) => length(parseFloat(v ?? ""));
  const out = { top: read(style.paddingTop), bottom: read(style.paddingBottom), left: read(style.paddingLeft), right: read(style.paddingRight) };
  probe.remove();
  return out;
}

/** Set the CSS variables of `layout` on `:root`, where there is a document. */
export function applyLayout(layout: Layout): void {
  const style = (globalThis as unknown as { document?: Doc }).document?.documentElement?.style;
  if (!style) return;
  for (const [name, value] of Object.entries(cssVariables(layout))) style.setProperty(name, value);
}

export class GrainError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "GrainError";
  }
}

export type Theme = "dark" | "light";
export type Network = "mainnet" | "testnet" | "devnet";

export interface GrainInfo {
  slug: string;
  version: number;
  form: "hosted" | "sealed";
  /** How the wallet sees the grain: on its verified list, in the network's registry, or neither (12-grains §9). */
  listing: "verified" | "listed" | "unlisted";
  host: string;
  host_version: string;
  bridge: number;
  language: string;
  theme: Theme;
  /** How far the system's UI reaches into the page (bridge 3; `left` and `right` from bridge 3): 0 inside the safe area,
   *  the real reach for a page that declared `viewport-fit=cover`, and 0 in bridge 1–2, whose header sits above the
   *  page. Read it through `grain.layout()`, which takes a missing field as 0. */
  safe_area: SafeArea;
  /** The wallet's controls over the page (bridge 3): keep every tappable element out of this box. Null inside the safe
   *  area (they sit in the band above the page), absent before bridge 3. */
  controls?: Controls | null;
  network: Network;
  start: string | null;
}

/** What `login` returns: check it on your server (`@saltix/grain-server`). */
export interface Login {
  /** The user's key in this grain, hex. */
  key: string;
  signature: string;
  /** Unix ms the wallet signed at. */
  at: number;
  origin: string;
}

export type PayRequest =
  | { invoice: string }
  | { to: string; asset?: "SALT" | "WORK"; amount: string; memo?: string };

export interface Paid {
  id: string;
  status?: "unknown" | "already_sent";
}

export type Haptic = "light" | "medium" | "heavy" | "success" | "warning" | "error" | "selection";

export interface Events {
  theme: { theme: Theme };
  visibility: { visible: boolean };
  /** The page's insets or the wallet's controls changed (bridge 3): the phone turned, unfolded or folded, the window
   *  resized, a keyboard opened or closed, the page's frame changed. `grain.layout()` follows it. */
  insets: { safe_area: SafeArea; controls: Controls | null };
  /** A frame to the grain's alias at the relay (`relay.open`), opened by the wallet: `payload` is hex. */
  relay: { from: string; payload: string };
}

/** The sections of the app's manage page a grain may open it at (`grain.manage.open`, 12-grains §5). */
export const MANAGE_SECTIONS = ["members"] as const;
export type ManageSection = (typeof MANAGE_SECTIONS)[number];

/** The most a frame through the relays carries, in bytes (12-grains §11). */
export const MAX_RELAY_PAYLOAD = 48_000;

interface Provider {
  request(args: { method: string; params?: object }): Promise<unknown>;
  on?(event: string, handler: (data: unknown) => void): void;
  off?(event: string, handler: (data: unknown) => void): void;
  isGrain?: boolean;
}

/** The simulator's frame name: requests then go to the parent page. */
export const SIMULATOR_FRAME = "saltix-simulator";

function simulatorProvider(): Provider | null {
  const w = globalThis as unknown as Window;
  if (typeof w.parent === "undefined" || w.parent === w || w.name !== SIMULATOR_FRAME) return null;
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  w.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== w.parent) return;
    const m = event.data as { saltixSim?: number; id?: number; result?: unknown; error?: { code: number; message: string }; event?: string; data?: unknown };
    if (!m || m.saltixSim !== 1) return;
    if (m.event) {
      listeners.get(m.event)?.forEach((h) => h(m.data));
      return;
    }
    const p = m.id === undefined ? undefined : pending.get(m.id);
    if (!p) return;
    pending.delete(m.id!);
    if (m.error) p.reject(new GrainError(m.error.code, m.error.message));
    else p.resolve(m.result);
  });
  return {
    isGrain: true,
    request: ({ method, params }) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        w.parent.postMessage({ saltixSim: 1, id, method, params: params ?? {} }, "*");
      }),
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    off: (event, handler) => listeners.get(event)?.delete(handler),
  };
}

let cached: Provider | null | undefined;

function provider(): Provider | null {
  if (cached !== undefined) return cached;
  const w = globalThis as unknown as { saltix?: Provider };
  cached = w.saltix?.isGrain ? w.saltix : simulatorProvider();
  return cached;
}

/** For tests: forget the provider found, and the guidance given. */
export function _reset(): void {
  cached = undefined;
  guided = false;
}

/** Whether the page runs in a wallet (or the simulator) that speaks the grain bridge. */
export function inWallet(): boolean {
  return provider() !== null;
}

/** The link that opens the grain whose manifest is at `manifestUrl` in a wallet (12-grains §4). */
export function walletLink(manifestUrl: string, start?: string): string {
  checkStart(start);
  return "salt:grain?manifest=" + encodeURIComponent(manifestUrl) + (start ? "&start=" + start : "");
}

/** The link that opens a registered grain by its slug (12-grains §4): `salt:grain/<slug>[?start=…]`. */
export function slugLink(slug: string, start?: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(slug)) throw new GrainError(ErrorCode.InvalidParams, "slug: 3 to 32 of [a-z0-9-], not starting with -");
  checkStart(start);
  return "salt:grain/" + slug + (start ? "?start=" + start : "");
}

/**
 * The link that opens a registered grain's chat (22-grain-chats §6): `salt:grain/<slug>?chat`, with the server key's
 * certificate (the hex your server's `encodeCert` gives) so the wallet starts without fetching it. A grain whose
 * registry record names its server keys (24-app-studio §2) needs no certificate: the wallet writes to the first key.
 */
export function chatLink(slug: string, cert?: string): string {
  const link = slugLink(slug) + "?chat";
  if (cert === undefined) return link;
  if (!/^([0-9a-fA-F]{2})+$/.test(cert)) throw new GrainError(ErrorCode.InvalidParams, "cert: the hex of the certificate's Borsh");
  return link + "&cert=" + base64url(unhex(cert.toLowerCase()));
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkStart(start?: string): void {
  if (start !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(start)) throw new GrainError(ErrorCode.InvalidParams, "start: 1 to 64 of [A-Za-z0-9_-]");
}

async function call<T>(method: string, params: object = {}): Promise<T> {
  const p = provider();
  if (!p) throw new GrainError(ErrorCode.NoWallet, "not in a Saltix wallet");
  try {
    return (await p.request({ method, params })) as T;
  } catch (e) {
    if (e instanceof GrainError) throw e;
    const err = e as { code?: number; message?: string };
    throw new GrainError(typeof err.code === "number" ? err.code : ErrorCode.Failed, err.message ?? String(e));
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const grain = {
  info: () => call<GrainInfo>("grain_info"),
  /** The grain is drawn: the wallet hides its splash. */
  ready: () => call<null>("grain_ready"),
  close: () => call<null>("grain_close"),
  /** Changes nothing since bridge 3: a grain always opens as a full app. */
  expand: () => call<null>("grain_expand"),
  /** The colour at the top of the page (`#rrggbb`): the wallet draws the status bar's icons and its controls to contrast
   *  with it (bridge 3; before, the colour of its header above the grain). */
  setHeader: (color: string) => call<null>("grain_setHeader", { color }),
  /**
   * The page's frame as Saltix lays it out (12-grains §5, §7): inside the safe area by default, edge to edge with the
   * wallet's controls `⋯ | ✕` floating in the top right corner for a page that declares `viewport-fit=cover`. Resolves
   * with the safe area and the controls' box, and keeps both current (the `insets` event, window resizes and theme
   * changes), calling `onChange` with each new layout. It sets, on `:root`, `--saltix-safe-top`, `--saltix-safe-bottom`,
   * `--saltix-safe-left`, `--saltix-safe-right`, `--saltix-controls-top`, `--saltix-controls-right`,
   * `--saltix-controls-width` and `--saltix-controls-height`, so CSS alone can keep text inside the safe area and a top
   * bar clear of the controls: the same values Saltix sets itself, which matter where it does not (an older Saltix, a
   * plain browser). The returned object's fields are the current layout (a destructured copy is not); `stop()` stops
   * following. In a wallet, a page that has not declared `viewport-fit=cover` is told so on the console: it stays inside
   * the safe area, where everything is 0.
   *
   * Outside Saltix bridge 3 it falls back (`layoutOf`): an older Saltix draws its header above the page, so the safe area
   * is 0 and there are no controls; a plain browser gives its own insets (`env(safe-area-inset-*)`) and no controls.
   */
  layout: (onChange?: (layout: Layout) => void): Promise<LayoutWatch> => watchLayout(onChange),
  haptic: (kind: Haptic = "light") => call<null>("grain_haptic", { kind }),
  copy: (text: string) => call<null>("grain_copy", { text }),
  share: (text: string, url?: string) => call<null>("grain_share", url ? { text, url } : { text }),
  /** Open an https link outside the grain. */
  openLink: (url: string) => call<null>("grain_openLink", { url }),
  /** The text of a QR code the user scans; rejects with `UserRejected` when they cancel. */
  scanQr: async (hint?: string) => (await call<{ text: string }>("grain_scanQr", hint ? { hint } : {})).text,
  /**
   * Sign in under the user's key in this grain. `challenge` (at most 64 bytes, hex or bytes) comes
   * from your server, which checks the answer with `@saltix/grain-server`.
   */
  login: (challenge: Uint8Array | string) =>
    call<Login>("grain_login", { challenge: typeof challenge === "string" ? challenge.toLowerCase() : hex(challenge) }),
  /** The account's address, when the manifest asks for it and the user agrees. */
  requestAddress: async () => (await call<{ address: string }>("grain_requestAddress")).address,
  /** A contact's address the user picks. */
  pickContact: async () => (await call<{ address: string }>("grain_pickContact")).address,
  /**
   * A payment in the wallet's own sheet, confirmed with the user's PIN. Call it from a tap: the
   * wallet refuses a payment without one. Pass an invoice your server signed to have the sheet say
   * it is from your grain.
   */
  pay: (request: PayRequest) => call<Paid>("grain_pay", request),
  /** Strings synced across the user's devices: keys up to 128 bytes, values up to 60 KiB, 1 MiB in all. */
  storage: {
    get: async (key: string) => (await call<{ value: string | null }>("grain_storage_get", { key })).value,
    set: (key: string, value: string) => call<null>("grain_storage_set", { key, value }),
    remove: (key: string) => call<null>("grain_storage_remove", { key }),
    keys: async () => (await call<{ keys: string[] }>("grain_storage_keys")).keys,
  },
  /**
   * Real time between the grain's users, and with its server, through the relays (12-grains §5.4),
   * under the user's key in this grain. Frames are sealed by the wallet to the recipient's key.
   */
  relay: {
    /**
     * Register the grain's alias at the wallet's relay; resolves with the address others send to. With `grant` (the
     * hex your server's `issueSponsorCert`/`grantFor` gave for this user's grain key) the frames are paid from your
     * sponsor channel when the relay's free share is busy; without it they use the free share only.
     */
    open: async (options: { grant?: string } = {}) =>
      (await call<{ address: string }>("grain_relay_open", options.grant ? { grant: options.grant.toLowerCase() } : {})).address,
    /**
     * Send `payload` (at most `MAX_RELAY_PAYLOAD` bytes) to `to`: live only, or with `keep` kept in the
     * recipient's mailbox until its wallet takes it. Rejects when it did not go out.
     */
    send: (to: string, payload: Uint8Array, options: { keep?: boolean } = {}) => {
      if (payload.length === 0 || payload.length > MAX_RELAY_PAYLOAD) {
        return Promise.reject(new GrainError(ErrorCode.InvalidParams, `payload: 1 to ${MAX_RELAY_PAYLOAD} bytes`));
      }
      return call<null>("grain_relay_send", { to, payload: hex(payload), keep: options.keep ?? false });
    },
    /** Unregister the alias (it stays while the grain's notifications are allowed). */
    close: () => call<null>("grain_relay_close"),
    /** Frames to the alias, as bytes; returns what stops listening. */
    onFrame(handler: (from: string, payload: Uint8Array) => void): () => void {
      const wrapped = (data: unknown) => {
        const { from, payload } = data as Events["relay"];
        handler(from, unhex(payload));
      };
      provider()?.on?.("relay", wrapped);
      return () => {
        provider()?.off?.("relay", wrapped);
      };
    },
  },
  /** The grain's chat (22-grain-chats, bridge version 2): signed cards from your server and typed actions. */
  chat: {
    /**
     * Open the grain's chat in the wallet. Pass the spec, and the certificate when the server key has one, that your
     * server serves at `/.well-known/saltix-grain-chat` (hex) when the page has them, so the wallet need not fetch them;
     * it checks both against the registry's record and manifest either way.
     */
    open: (options: { cert?: string; spec?: string } = {}) => {
      const params: Record<string, string> = {};
      for (const name of ["cert", "spec"] as const) {
        const value = options[name];
        if (value === undefined) continue;
        if (!/^([0-9a-fA-F]{2})+$/.test(value)) return Promise.reject(new GrainError(ErrorCode.InvalidParams, `${name}: hex of its Borsh`));
        params[name] = value.toLowerCase();
      }
      return call<null>("grain_chat_open", params);
    },
  },
  /** The app's own manage page in the wallet (12-grains §5, 24-app-studio §4; bridge version 3). */
  manage: {
    /**
     * Open the grain's own manage page above it, at `section` (`"members"`) when given, so that the team adds people
     * where it sees them: the owner's wallet alone signs what changes the registry. Call it from a tap: the wallet opens
     * it only within 5 seconds of one, and only for the grain's team (its owner, developers and viewers); anyone else
     * gets `NotPermitted` (4100). An older wallet answers `Unsupported` (4200): say in words where the page is (My apps →
     * the app).
     */
    open: (options: { section?: ManageSection } = {}) => {
      if (options.section !== undefined && !MANAGE_SECTIONS.includes(options.section)) {
        return Promise.reject(new GrainError(ErrorCode.InvalidParams, `section: one of ${MANAGE_SECTIONS.join(", ")}`));
      }
      return call<null>("grain_manage_open", options.section === undefined ? {} : { section: options.section });
    },
  },
  /** Notifications from your server while the grain is closed (12-grains §5.5). */
  notifications: {
    /** Ask the user once whether the grain may notify them; resolves with the answer. */
    allow: async () => (await call<{ allowed: boolean }>("grain_notifications_allow")).allowed,
  },
  on<E extends keyof Events>(event: E, handler: (data: Events[E]) => void): void {
    provider()?.on?.(event, handler as (data: unknown) => void);
  },
  off<E extends keyof Events>(event: E, handler: (data: Events[E]) => void): void {
    provider()?.off?.(event, handler as (data: unknown) => void);
  },
};

/** What `grain.layout()` resolves with: the current layout, kept current until `stop()`. */
export interface LayoutWatch extends Layout {
  stop(): void;
}

interface WindowEvents {
  addEventListener?(type: string, handler: () => void): void;
  removeEventListener?(type: string, handler: () => void): void;
}

/** The console's word, once per page, to a page in a wallet that asks for its layout without declaring
 *  `viewport-fit=cover`: Saltix keeps it inside the safe area, where every value is 0. */
let guided = false;
export const COVER_GUIDANCE =
  "grain.layout(): this page does not declare viewport-fit=cover, so Saltix lays it out inside the safe area, below " +
  "its controls: the safe area is 0 and no controls are over it. To draw it edge to edge, add " +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"> and keep its content ' +
  "inside --saltix-safe-* and clear of --saltix-controls-* (AGENTS.md).";

function guide(): void {
  const g = globalThis as unknown as { document?: Parameters<typeof viewportOf>[0]; console?: { warn(m: string): void } };
  if (guided || !g.document?.querySelectorAll) return;
  if (viewportFitCover(viewportOf(g.document))) return;
  guided = true;
  g.console?.warn(COVER_GUIDANCE);
}

async function watchLayout(onChange?: (layout: Layout) => void): Promise<LayoutWatch> {
  const p = provider();
  const w = globalThis as unknown as WindowEvents;
  if (p) guide();
  let current: Layout = layoutOf(p ? { bridge: 1 } : null, p ? undefined : browserInsets());
  let bridge = 1;
  let stopped = false;
  // Each change bumps `seq`: a read that started before a newer `insets` event does not undo it.
  let seq = 0;
  let reading = false;
  let again = false;

  const apply = (next: Layout) => {
    if (stopped) return;
    current = next;
    applyLayout(next);
    onChange?.(next);
  };
  const read = async (): Promise<Layout> => {
    if (!p) return layoutOf(null, browserInsets());
    try {
      const info = await call<LayoutInfo>("grain_info");
      bridge = info.bridge ?? 1;
      return layoutOf(info);
    } catch {
      return current;
    }
  };
  // One `grain_info` at a time, and one more after it when something changed meanwhile: a window being dragged sends
  // resizes by the dozen, and the wallet rate-limits its bridge.
  const refresh = (): void => {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    const mine = ++seq;
    void read().then((next) => {
      if (seq === mine) apply(next);
    }).finally(() => {
      reading = false;
      if (again) {
        again = false;
        refresh();
      }
    });
  };
  const onInsets = (data: unknown) => {
    const e = data as Partial<Events["insets"]>;
    seq++;
    apply(layoutOf({ bridge: Math.max(bridge, FULL_SCREEN_BRIDGE), safe_area: e.safe_area, controls: e.controls }));
  };

  // Listening first: an `insets` event that comes while `grain_info` is answered wins over its answer.
  p?.on?.("insets", onInsets);
  p?.on?.("theme", refresh);
  w.addEventListener?.("resize", refresh);
  const first = ++seq;
  const initial = await read();
  if (seq === first) apply(initial);
  return {
    get safeArea() {
      return current.safeArea;
    },
    get controls() {
      return current.controls;
    },
    get source() {
      return current.source;
    },
    stop() {
      stopped = true;
      p?.off?.("insets", onInsets);
      p?.off?.("theme", refresh);
      w.removeEventListener?.("resize", refresh);
    },
  };
}

export default grain;
