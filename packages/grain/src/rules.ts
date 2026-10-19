// The wallet's side of the bridge as Saltix applies it (Saltix 12-grains §5, §7, §8, docs/protocol/grains.md; as its
// Android app's bridge, container, storage and sealed site do): what needs a tap of the user, what the manifest must ask for, who
// may open the app's page, how often each method may be asked, how long an answer or an event may be, what storage
// keeps, and how a sealed grain is served. The simulator plays by these, so that a page meets Saltix's refusals on a
// computer first; a page never needs them (`@saltix/grain/rules`, not part of `index.js`).

/** Every method the bridge answers (bridge version 3): anything else is 4200, and is never counted. */
export const BRIDGE_METHODS = [
  "grain_info", "grain_ready", "grain_close", "grain_expand", "grain_setHeader", "grain_haptic", "grain_copy", "grain_share",
  "grain_openLink", "grain_scanQr", "grain_login", "grain_requestAddress", "grain_pickContact", "grain_pay",
  "grain_storage_get", "grain_storage_set", "grain_storage_remove", "grain_storage_keys",
  "grain_relay_open", "grain_relay_send", "grain_relay_close", "grain_chat_open", "grain_manage_open", "grain_notifications_allow",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

const KNOWN: ReadonlySet<string> = new Set(BRIDGE_METHODS);

/** Whether `method` is one the bridge answers. */
export const isBridgeMethod = (method: string): method is BridgeMethod => KNOWN.has(method);

/** A refusal as the page reads it (`{code, message}`). */
export interface Refusal {
  refuse: number;
  message: string;
}

// ── A tap of the user ────────────────────────────────────────────────────────

/** How long after the user touched the app a request counts as theirs (the wallet's own record, never the page's word). */
export const USER_ACTIVATION_MS = 5_000;

/** What a request may do as to the user: go ahead (`ask`: the user is asked first), be refused, or have its answer. */
export type TapOutcome = { go: true; ask: boolean } | Refusal | { answer: unknown };

/**
 * A request's rule as to the user (`tapped`: within `USER_ACTIVATION_MS` of a touch; `consented`: the user's yes kept
 * for this app, as the Connect sheet or an earlier ask left it): a payment, the app's chat and its page in the wallet
 * only on a tap; the address and notifications asked again only on a tap; a sign-in asked once, tap or not.
 */
export function tapRule(method: string, o: { tapped: boolean; consented: boolean }): TapOutcome {
  switch (method) {
    case "grain_pay":
      return o.tapped ? { go: true, ask: false } : { refuse: 4100, message: "a payment needs a tap of the user" };
    case "grain_chat_open":
      return o.tapped ? { go: true, ask: false } : { refuse: 4100, message: "opening the chat needs a tap of the user" };
    case "grain_manage_open":
      return o.tapped ? { go: true, ask: false } : { refuse: 4100, message: "opening the app's page needs a tap of the user" };
    case "grain_requestAddress":
      if (o.consented) return { go: true, ask: false };
      return o.tapped ? { go: true, ask: true } : { refuse: 4001, message: "the user has not shared the address: ask from a tap" };
    case "grain_notifications_allow":
      if (o.consented) return { answer: { allowed: true } };
      return o.tapped ? { go: true, ask: true } : { answer: { allowed: false } };
    case "grain_login":
      return { go: true, ask: !o.consented };
    default:
      return { go: true, ask: false };
  }
}

// ── The manifest's permissions and the team ──────────────────────────────────

/** The permission bit (12-grains §2, `PERMISSIONS`) each method needs. */
const NEEDS: Partial<Record<BridgeMethod, number>> = {
  grain_storage_get: 1, grain_storage_set: 1, grain_storage_remove: 1, grain_storage_keys: 1,
  grain_relay_open: 2, grain_relay_send: 2, grain_relay_close: 2,
  grain_notifications_allow: 4,
  grain_requestAddress: 64,
};

/** Why the manifest's `permissions` do not let `method` through, or null. */
export function permissionRule(method: string, permissions: number): Refusal | null {
  const bit = NEEDS[method as BridgeMethod];
  if (bit === undefined || (permissions & bit) !== 0) return null;
  return { refuse: 4100, message: method === "grain_requestAddress" ? "the manifest does not ask for the address" : "the manifest does not ask for this" };
}

/** `grain_manage_open`'s rule once tapped: the app's page is for its team (`onTeam` by the registry; null when it
 *  cannot be read now). */
export function manageRule(onTeam: boolean | null): Refusal | null {
  if (onTeam === true) return null;
  return onTeam === false ? { refuse: 4100, message: "the app's page is for its team" } : { refuse: 5000, message: "the wallet cannot read the app's team now" };
}

// ── How often ────────────────────────────────────────────────────────────────

/** Requests a second and the burst a method may have; any other known method has `DEFAULT_BRIDGE_RATE`. */
export const BRIDGE_RATES: Readonly<Partial<Record<BridgeMethod, readonly [number, number]>>> = {
  grain_pay: [0.5, 1],
  grain_login: [1, 3],
  grain_scanQr: [0.5, 1],
  grain_share: [0.5, 2],
  grain_openLink: [1, 3],
  grain_storage_get: [100, 200],
  grain_storage_set: [50, 100],
  grain_storage_remove: [50, 100],
  grain_storage_keys: [20, 40],
  grain_relay_open: [1, 3],
  grain_notifications_allow: [0.5, 1],
  grain_chat_open: [0.5, 1],
  grain_manage_open: [0.5, 1],
};

export const DEFAULT_BRIDGE_RATE = [20, 40] as const;

/**
 * A page's requests counted per method, a token bucket each. Only a method the bridge answers has a bucket: a name made
 * up by the page is `unsupported` and costs nothing to keep, so a page cannot grow the wallet's memory one name at a
 * time.
 */
export class BridgeLimiter {
  private readonly buckets = new Map<BridgeMethod, { tokens: number; at: number }>();

  /** Buckets kept: one per known method asked. */
  get size(): number {
    return this.buckets.size;
  }

  /** Count one request of `method` at `now` (ms). */
  take(method: string, now: number): "ok" | "rate_limited" | "unsupported" {
    if (!isBridgeMethod(method)) return "unsupported";
    const [rate, burst] = BRIDGE_RATES[method] ?? DEFAULT_BRIDGE_RATE;
    const b = this.buckets.get(method) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) * rate) / 1000);
    b.at = now;
    this.buckets.set(method, b);
    if (b.tokens < 1) return "rate_limited";
    b.tokens -= 1;
    return "ok";
  }
}

// ── How long ─────────────────────────────────────────────────────────────────

/** The most a message between the page and the wallet carries, as JSON text (its length in UTF-16 units). */
export const BRIDGE_MESSAGE_MAX = 64 * 1024;

/** The answer to request `id` as the wallet posts it: `body` and the id, or in its place the error Saltix answers when
 *  that is over `BRIDGE_MESSAGE_MAX` (a value of storage escaped as JSON may be, a relay frame's hex may be). */
export function bridgeAnswer(id: number | string, body: { result: unknown } | { error: { code: number; message: string } }): string {
  const text = JSON.stringify({ ...body, id });
  return text.length <= BRIDGE_MESSAGE_MAX ? text : JSON.stringify({ id, error: { code: 5000, message: "the answer is over 64 KiB" } });
}

/** The event as the wallet posts it, or null when it is over `BRIDGE_MESSAGE_MAX`: Saltix drops it and says nothing.
 *  A relay frame arrives as hex, twice its size: one over about 32 KB never reaches the page. */
export function bridgeEvent(event: string, data: unknown): string | null {
  const text = JSON.stringify({ event, data });
  return text.length <= BRIDGE_MESSAGE_MAX ? text : null;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export const STORAGE_MAX_KEY_BYTES = 128;
export const STORAGE_MAX_VALUE_BYTES = 60 * 1024;
export const STORAGE_MAX_GRAIN_BYTES = 1 << 20;

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * Why a storage request (`get`, `set`, `remove`; `keys` takes nothing) is refused with what the app keeps now (`kept`),
 * or null: a key of 1 to 128 bytes without U+0000, a string value of at most 60 KiB, and at most 1 MiB of keys and values
 * in all.
 */
export function storageRule(op: "get" | "set" | "remove", params: { key?: unknown; value?: unknown }, kept: ReadonlyMap<string, string>): Refusal | null {
  const key = params.key;
  if (typeof key !== "string" || key.length === 0 || utf8(key) > STORAGE_MAX_KEY_BYTES || key.includes("\u0000")) {
    return { refuse: -32602, message: `key: 1 to ${STORAGE_MAX_KEY_BYTES} bytes` };
  }
  if (op !== "set") return null;
  const value = params.value;
  if (typeof value !== "string") return { refuse: -32602, message: "value: a string" };
  if (utf8(value) > STORAGE_MAX_VALUE_BYTES) return { refuse: -32602, message: `value: at most ${STORAGE_MAX_VALUE_BYTES} bytes` };
  let used = 0;
  for (const [k, v] of kept) if (k !== key) used += utf8(k) + utf8(v);
  if (used + utf8(key) + utf8(value) > STORAGE_MAX_GRAIN_BYTES) return { refuse: 4100, message: "the grain's storage holds at most 1 MiB" };
  return null;
}

// ── A sealed grain ───────────────────────────────────────────────────────────

/** The Content-Security-Policy every file of a sealed grain carries, served at its virtual origin (`sealedOrigin` of
 *  `@saltix/grain-server`): its own origin, and its `connect` origins (https, and the same hosts over wss) for data. */
export function sealedCsp(connect: readonly string[]): string {
  const https = connect.join(" ");
  const wss = connect.map((o) => "wss://" + o.replace(/^https:\/\//, "")).join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${https}`,
    `media-src 'self' data: blob: ${https}`,
    "font-src 'self' data:",
    `connect-src 'self' ${https} ${wss}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].map((d) => d.trimEnd()).join("; ");
}

/**
 * Where a development wallet opens a grain's first page, from its manifest loaded at `manifestUrl`: a hosted grain at its
 * `url`; a sealed grain at its `start` page from the root of the bundle, which Saltix serves at the grain's own origin
 * (`https://<slug>.grain.invalid/<start>`) and a development server (`grain dev`) at the root of its own origin, where
 * it serves `public/` (the bundle's files); null for a chat-only grain, which has no page. Never relative to the
 * manifest's own path (`/.well-known/`), where no page is.
 */
export function devPageUrl(entry: { hosted?: { url: string }; sealed?: { start: string }; chat?: unknown }, manifestUrl: string): string | null {
  if (entry.hosted) return entry.hosted.url;
  if (entry.sealed) return new URL(entry.sealed.start.replace(/^\/+/, ""), new URL("/", manifestUrl)).href;
  return null;
}
