/**
 * `@salarium/grain`: the bridge between a grain and the Salarium wallet it runs in
 * (Salarium specs/12-grains.md §5, bridge version 1).
 *
 * In a wallet the page has `window.salarium`, defined before its scripts run; in the simulator
 * (an iframe named `salarium-simulator`) requests go to the simulator page instead. Outside both,
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
  safe_area: { top: number; bottom: number };
  network: Network;
  start: string | null;
}

/** What `login` returns: check it on your server (`@salarium/grain-server`). */
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
}

interface Provider {
  request(args: { method: string; params?: object }): Promise<unknown>;
  on?(event: string, handler: (data: unknown) => void): void;
  off?(event: string, handler: (data: unknown) => void): void;
  isGrain?: boolean;
}

/** The simulator's frame name: requests then go to the parent page. */
export const SIMULATOR_FRAME = "salarium-simulator";

function simulatorProvider(): Provider | null {
  const w = globalThis as unknown as Window;
  if (typeof w.parent === "undefined" || w.parent === w || w.name !== SIMULATOR_FRAME) return null;
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  w.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== w.parent) return;
    const m = event.data as { salariumSim?: number; id?: number; result?: unknown; error?: { code: number; message: string }; event?: string; data?: unknown };
    if (!m || m.salariumSim !== 1) return;
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
        w.parent.postMessage({ salariumSim: 1, id, method, params: params ?? {} }, "*");
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
  const w = globalThis as unknown as { salarium?: Provider };
  cached = w.salarium?.isGrain ? w.salarium : simulatorProvider();
  return cached;
}

/** For tests: forget the provider found. */
export function _reset(): void {
  cached = undefined;
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

function checkStart(start?: string): void {
  if (start !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(start)) throw new GrainError(ErrorCode.InvalidParams, "start: 1 to 64 of [A-Za-z0-9_-]");
}

async function call<T>(method: string, params: object = {}): Promise<T> {
  const p = provider();
  if (!p) throw new GrainError(ErrorCode.NoWallet, "not in a Salarium wallet");
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

export const grain = {
  info: () => call<GrainInfo>("grain_info"),
  /** The grain is drawn: the wallet hides its splash. */
  ready: () => call<null>("grain_ready"),
  close: () => call<null>("grain_close"),
  expand: () => call<null>("grain_expand"),
  /** The wallet's header colour above the grain: `#rrggbb`. */
  setHeader: (color: string) => call<null>("grain_setHeader", { color }),
  haptic: (kind: Haptic = "light") => call<null>("grain_haptic", { kind }),
  copy: (text: string) => call<null>("grain_copy", { text }),
  share: (text: string, url?: string) => call<null>("grain_share", url ? { text, url } : { text }),
  /** Open an https link outside the grain. */
  openLink: (url: string) => call<null>("grain_openLink", { url }),
  /** The text of a QR code the user scans; rejects with `UserRejected` when they cancel. */
  scanQr: async (hint?: string) => (await call<{ text: string }>("grain_scanQr", hint ? { hint } : {})).text,
  /**
   * Sign in under the user's key in this grain. `challenge` (at most 64 bytes, hex or bytes) comes
   * from your server, which checks the answer with `@salarium/grain-server`.
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
  on<E extends keyof Events>(event: E, handler: (data: Events[E]) => void): void {
    provider()?.on?.(event, handler as (data: unknown) => void);
  },
  off<E extends keyof Events>(event: E, handler: (data: Events[E]) => void): void {
    provider()?.off?.(event, handler as (data: unknown) => void);
  },
};

export default grain;
