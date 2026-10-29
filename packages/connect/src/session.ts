/*
 * One Saltix Connect attempt of the page (Saltix 19-connect §2–§5, §14, §15), a port of the explorer's
 * `explorer/src/connect/session.ts`: a slot at a relay, the offer for the QR code and the link, the wallet's notice that
 * it saw the offer, and the grant, checked before the page takes it — then the page's confirmation to the wallet's
 * reply slot (§14.2), sent before the slot closes, so the wallet shows "connected" on the page's word.
 *
 *   opening ──► offer ──► seen ──► checking ──► connected (the page shows it at once; the confirmation goes out behind)
 *      │          │  ▲       │          │
 *      ▼          ▼  │       ▼          └─► a refused grant: back to offer or seen, with the reason
 *    failed    (the code's life unseen, 2 minutes unless the page says; read and no login for 3: a new slot and keys)
 *
 * Two modes. In the page's own (§2–§5) the keys are made here, and the grant is opened and checked here. In the
 * server-held mode (§15) the site's server makes the keys and keeps `Q`'s secret; the page holds no secret, forwards
 * every payload that reaches its slot sealed, as it came, through a `Courier`, and takes the server's word: the
 * wallet's notice, a refusal, or the session the server opened, with the confirmation the server sealed for the page
 * to deliver. The slot, the offer, the link to Saltix and the slot kept across a reload are the same in both.
 *
 * The slot belongs to the connection that opened it, so a dropped connection (a phone's browser in the background)
 * opens the same slot again at the same relay; the wallet's delivery finds it then. Everything that waits is a timer
 * the session owns, so `stop()` leaves nothing running. Telemetry never carries a key, a slot or an account.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { b64url, equal, fromB64Loose } from "./codec.js";
import type { Courier, CourierAnswer } from "./courier.js";
import {
  CONFIRM_DELIVERED_MS, CONFIRM_VERSION, ConnectError, type ConnectGrant, type ConnectReply, type Session, decodePayload, encodeConfirm,
  loginMessage, signerKind,
} from "./grant.js";
import { type Offer, offerAppLink, offerLink, offerText } from "./offer.js";
import type { Dial, Frame, RelayLink } from "./relay.js";
import { boxPublic, openLinkPayload, randomSecret, sealLinkPayload } from "./seal.js";

/** How long one offer is shown unseen before a new slot and new keys replace it, unless the page gives its code another
 *  life (`qrLifeMs`, within `QR_LIFE_MIN_MS` and the mode's longest). */
export const QR_LIFE_MS = 2 * 60_000;
/** The shortest life a page may give its code: time to take out a phone and scan it. */
export const QR_LIFE_MIN_MS = 30_000;
/** The longest in the page's own mode: a third of the slot's life; a code shown longer is a door left open. */
export const QR_LIFE_MAX_MS = 10 * 60_000;
/** An offer lives this long at the site's server, from its making, with its keys (19-connect §15.4): a code shown for
 *  a minute or two, then the scan, the sheet and the PIN fit in it, and a relayed or photographed code dies sooner. */
export const SERVER_OFFER_LIFE_MS = 5 * 60_000;
/** The longest life of a code in the server-held mode: the server's offer outlives it by two minutes, for the scan,
 *  the sheet and the PIN (§15.4). */
export const SERVER_QR_LIFE_MAX_MS = SERVER_OFFER_LIFE_MS - 2 * 60_000;
/** How long a code the wallet read waits for its login before a new code replaces it by itself: the person cancelled in
 *  Saltix or put the phone down, and no page shows a button for a new code. Counted again from a refused grant; only
 *  while the page is in front with its slot connected and no grant being checked, so that a login the relay parked for
 *  a page in the background is taken first. */
export const SEEN_WAIT_MS = 3 * 60_000;
/** The slot is opened again this often, so it never goes idle (5 minutes, 09-relay §10.3). */
export const KEEP_MS = 60_000;
/** A slot lives this long in all; the page gives up waiting then (09-relay §10.3). A server's offer lives less
 *  (`SERVER_OFFER_LIFE_MS`, §15.4). */
export const SLOT_LIFE_MS = 30 * 60_000;
/** How long the relay has to answer `link_open`. */
export const OPEN_MS = 10_000;
/** Waits between attempts to open the same slot again after its connection dropped. */
const REOPEN_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** How often a hidden page looks whether it is in front again, between a dropped connection and `wake()`. */
const HIDDEN_CHECK_MS = 15_000;

export interface SessionKeys {
  sid: Uint8Array;
  /** `Q`'s secret, the page's own; null in the server-held mode, where the server keeps it and the page holds none. */
  boxSecret: Uint8Array | null;
  boxKey: Uint8Array;
  /** `P`: its public key, and the private key as a non-extractable Web Crypto key where the browser offers Ed25519. */
  page: Uint8Array;
  pageKey: CryptoKey | null;
  webCrypto: boolean;
}

/** Fresh keys for one offer. */
export async function makeKeys(): Promise<SessionKeys> {
  const sid = crypto.getRandomValues(new Uint8Array(32));
  const boxSecret = randomSecret();
  const boxKey = boxPublic(boxSecret);
  try {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const page = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    if (page.length !== 32) throw new Error("not an Ed25519 key");
    return { sid, boxSecret, boxKey, page, pageKey: pair.privateKey, webCrypto: true };
  } catch {
    // Without Ed25519 in Web Crypto the key lives in this page's memory only; the page signs nothing with it yet.
    const seed = randomSecret();
    const page = ed25519.getPublicKey(seed);
    seed.fill(0);
    return { sid, boxSecret, boxKey, page, pageKey: null, webCrypto: false };
  }
}

/** Why a session failed before any offer: no relay answers, a relay is of another network, or — in the server-held
 *  mode — the site's server gave no offer the page can show. */
export type FailKind = "no_relay" | "refused" | "network" | "server";

export type Phase =
  | { kind: "opening" }
  | { kind: "offer"; offer: Offer; text: string; link: string; app: string; expiresAt: number }
  | { kind: "seen"; offer: Offer; text: string; link: string; app: string }
  | { kind: "checking"; offer: Offer; text: string; link: string; app: string }
  | { kind: "connected" }
  | { kind: "failed"; reason: FailKind };

/** What a refused grant tells the visitor: the reason, and whether it may help to try again. */
export interface Refused {
  reason: string;
  at: number;
}

export interface SessionEvents {
  phase(p: Phase): void;
  /** A grant came that the page cannot take; the offer stays. */
  refused(r: Refused): void;
  /** The connection to the relay dropped and is being opened again (true) or is back (false). */
  reconnecting(on: boolean): void;
  telemetry(event: string, meta?: Record<string, string | number | boolean>): void;
}

export interface SessionOptions<T> {
  relays: readonly string[];
  /** The network's kind (`relay`'s hello must name the same kind). */
  networkKind: string;
  origin: string;
  dial: Dial;
  /** Called once with what `verify` returned, or with what the server told of the sign-in. */
  connected: (value: T) => void;
  events: SessionEvents;
  // ── The page's own mode (§2–§5): all four, and no courier ─────────────────
  /** The network's genesis hash. */
  network?: Uint8Array;
  /** What the page calls itself in the offer. */
  name?: string;
  keys?: () => Promise<SessionKeys>;
  /** The chain's side of §5 (rule 5, and whatever the page keeps): throws a [ConnectError] to refuse. */
  verify?: (grant: ConnectGrant, bytes: Uint8Array, session: Session) => Promise<T>;
  // ── The server-held mode (§15): the courier alone ─────────────────────────
  /** The site's server, which made the offer's keys and takes every payload: the offer's origin must be this page's
   *  (the courier holds it to that), and the offer's name is the server's. */
  courier?: Courier<T>;
  now?: () => number;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  random?: () => number;
  /** Whether the page is in front of the visitor: an offer is replaced only then. */
  visible?: () => boolean;
  /** How long a code is shown unseen before a new one replaces it: `QR_LIFE_MS` by default; see `qrLifeOf`. */
  qrLifeMs?: number;
  /** The browser's user agent: on Android the link that opens Saltix is an intent link (§14.1). */
  userAgent?: string;
  /**
   * Where the slot is kept across a reload of the page (§14.1): `sessionStorage` by default, so a page the browser
   * unloaded while handing the offer to Saltix and loaded again opens the same slot with the same keys, and the
   * wallet's delivery, tried again for 30 seconds, still lands. Null keeps nothing. In the server-held mode nothing
   * secret is kept: the server gave the page none (§15.1 step 1).
   */
  keep?: KeptSlotStore | null;
}

/** Three methods of `sessionStorage`. */
export interface KeptSlotStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where a page keeps its slot across a reload. */
export const KEPT_SLOT_KEY = "saltix-connect-slot";

/** A slot as the page keeps it: enough to open it again and to show the same offer; `Q`'s secret only in the page's
 *  own mode, where the page opens what the wallet delivers. */
interface KeptSlot {
  base: string;
  relay: string;
  sid: string;
  boxKey: string;
  boxSecret?: string;
  page: string;
  name: string;
  opened: number;
  seen: boolean;
  held: boolean;
}

/** The life of a page's code (`qrLifeMs`): the default without one, the one given within its mode's bounds, and a
 *  `TypeError` for anything else — a code that changes faster than a phone scans it, or one the slot (or, in the
 *  server-held mode, the server's offer) would not outlive. */
export function qrLifeOf(ms: number | undefined, serverHeld: boolean): number {
  if (ms === undefined) return QR_LIFE_MS;
  const max = serverHeld ? SERVER_QR_LIFE_MAX_MS : QR_LIFE_MAX_MS;
  if (!Number.isSafeInteger(ms) || ms < QR_LIFE_MIN_MS || ms > max) {
    const why = serverHeld ? ", in the server-held mode, whose server keeps an offer 5 minutes" : "";
    throw new TypeError(`Saltix Connect: qrLifeMs is a whole number of milliseconds from ${QR_LIFE_MIN_MS} to ${max}${why}`);
  }
  return ms;
}

function defaultKeep(): KeptSlotStore | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

interface Slot {
  base: string;
  keys: SessionKeys;
  offer: Offer;
  text: string;
  link: string;
  /** The link that opens Saltix on this device without unloading the page. */
  app: string;
  opened: number;
  link_: RelayLink | null;
  /** The latest reply that opened for the slot: where the wallet waits for the page's confirmation (§14.2). */
  reply: ConnectReply | null;
  /** The server-held mode: payloads waiting for the server's word, forwarded one at a time in the order they came, so
   *  the wallet's reply is at the server before the grant it goes with (§14.2 step 1); and whether the server took a
   *  reply, after which what comes is the grant. */
  queue: Uint8Array[];
  forwarding: boolean;
  replied: boolean;
}

export class ConnectSession<T> {
  private slot: Slot | null = null;
  private phase: Phase = { kind: "opening" };
  private seen = false;
  private stopped = false;
  private timers = new Set<unknown>();
  private reopenAttempt = 0;
  private generation = 0;
  private readonly now: () => number;
  private readonly setT: (f: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;
  private readonly random: () => number;
  private readonly visible: () => boolean;
  private readonly userAgent: string;
  private readonly keep: KeptSlotStore | null;
  /** How long an unseen code is shown (`qrLifeMs`). */
  private readonly qrLife: number;
  /** The visitor took the offer to the wallet on this phone: it stays until the slot's end. */
  private held = false;
  /** When the code was last shown as read: the wait for its login counts from it (`SEEN_WAIT_MS`). */
  private seenAt = 0;
  /** The slot's connection while the page's confirmation is on its way, after the page connected. */
  private confirming: RelayLink | null = null;

  constructor(private readonly o: SessionOptions<T>) {
    if (!o.courier && (!o.keys || !o.verify || !o.network || o.name === undefined)) {
      throw new TypeError("ConnectSession: the page's own mode needs keys, verify, network and name; the server-held mode a courier");
    }
    this.now = o.now ?? (() => Date.now());
    this.setT = o.setTimeout ?? ((f, ms) => setTimeout(f, ms));
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.random = o.random ?? Math.random;
    this.visible = o.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
    this.userAgent = o.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
    this.keep = o.keep === undefined ? defaultKeep() : o.keep;
    this.qrLife = qrLifeOf(o.qrLifeMs, !!o.courier);
  }

  get current(): Phase {
    return this.phase;
  }

  /**
   * Open a slot and show its offer; again with new keys whenever asked (`fresh`) or when an unseen offer expires. Not
   * fresh, a slot the page kept across a reload (§14.1) is opened again first — the same id at the same relay, with the
   * same keys and the same offer — so that a wallet already delivering to it still reaches the page; a relay that no
   * longer answers with the same node key, or a kept slot past its life, gives way to a fresh one. In the server-held
   * mode the keys and the offer's words come from the server (§15.1 step 1), before any relay is dialed.
   */
  async start(options: { fresh?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    this.clearTimers();
    this.closeLink();
    this.slot?.keys.boxSecret?.fill(0);
    this.slot = null;
    this.seen = false;
    this.held = false;
    this.reopenAttempt = 0;
    this.setPhase({ kind: "opening" });
    if (this.o.relays.length === 0) return this.fail("no_relay");
    const kept = options.fresh ? null : this.kept();
    if (options.fresh) this.forget();
    if (kept) {
      const boxSecret = kept.boxSecret === undefined ? null : fromB64Loose(kept.boxSecret)!;
      const keys: SessionKeys = {
        sid: fromB64Loose(kept.sid)!, boxSecret, boxKey: boxSecret ? boxPublic(boxSecret) : fromB64Loose(kept.boxKey)!, page: fromB64Loose(kept.page)!,
        pageKey: null, webCrypto: false,
      };
      const opened = await this.open(kept.base, keys.sid);
      if (this.stopped || generation !== this.generation) {
        opened?.link.close();
        return;
      }
      if (opened && opened.link.network === this.o.networkKind && equal(opened.relay, fromB64Loose(kept.relay) ?? new Uint8Array())) {
        const offer: Offer = { relay: opened.relay, sid: keys.sid, boxKey: keys.boxKey, page: keys.page, origin: this.o.origin, name: kept.name };
        this.seen = kept.seen;
        this.held = kept.held;
        this.place(kept.base, keys, offer, kept.opened, opened.link, opened.early);
        this.o.events.telemetry("connect_resumed", { relay: this.o.relays.indexOf(kept.base) + 1, ms: this.now() - kept.opened, held: kept.held });
        return;
      }
      opened?.link.close();
      this.forget();
      this.o.events.telemetry("connect_resume_failed", { kind: opened ? "other_relay" : "unreachable" });
    }
    let keys: SessionKeys;
    let name: string;
    if (this.o.courier) {
      try {
        const given = await this.o.courier.offer();
        keys = { sid: given.sid, boxSecret: null, boxKey: given.boxKey, page: given.page, pageKey: null, webCrypto: false };
        name = given.name;
      } catch (e) {
        if (this.stopped || generation !== this.generation) return;
        const kind = (e as { kind?: unknown } | null)?.kind;
        this.o.events.telemetry("connect_server_failed", { kind: typeof kind === "string" ? kind : "error" });
        return this.fail("server");
      }
      if (this.stopped || generation !== this.generation) return;
    } else {
      keys = await this.o.keys!();
      name = this.o.name!;
    }
    for (const base of this.shuffled(this.o.relays)) {
      if (this.stopped || generation !== this.generation) return;
      const opened = await this.open(base, keys.sid);
      if (this.stopped || generation !== this.generation) {
        opened?.link.close();
        return;
      }
      if (!opened) continue;
      if (opened.link.network !== this.o.networkKind) {
        this.o.events.telemetry("connect_slot_failed", { kind: "network" });
        opened.link.close();
        return this.fail("network");
      }
      const offer: Offer = { relay: opened.relay, sid: keys.sid, boxKey: keys.boxKey, page: keys.page, origin: this.o.origin, name };
      this.place(base, keys, offer, this.now(), opened.link, opened.early);
      this.o.events.telemetry("connect_open", { relay: this.o.relays.indexOf(base) + 1, webcrypto: keys.webCrypto, courier: !!this.o.courier });
      return;
    }
    this.o.events.telemetry("connect_slot_failed", { kind: "no_relay", relays: this.o.relays.length });
    this.fail("no_relay");
  }

  /** The slot is held: its offer shown, kept across a reload, kept open, and its times set. */
  private place(base: string, keys: SessionKeys, offer: Offer, opened: number, link: RelayLink, early: Frame[] = []): void {
    const text = offerText(offer);
    this.slot = { base, keys, offer, text, link: offerLink(offer), app: offerAppLink(offer, this.userAgent), opened, link_: link, reply: null, queue: [], forwarding: false, replied: false };
    this.remember();
    const slot = this.slot;
    if (this.seen) {
      this.setPhase({ kind: "seen", offer, text, link: slot.link, app: slot.app });
      this.awaitLogin();
    } else this.setPhase({ kind: "offer", offer, text, link: slot.link, app: slot.app, expiresAt: opened + this.qrLife });
    // Attached after the offer is shown: a payload the relay held for a parked slot goes straight to its check.
    this.attach(link, early);
    this.every(KEEP_MS, () => this.keepOpen());
    const left = Math.max(0, opened + SLOT_LIFE_MS - this.now());
    this.after(Math.max(0, opened + this.qrLife - this.now()), () => this.expire());
    this.after(left, () => {
      if (this.phase.kind !== "connected" && this.phase.kind !== "checking") void this.start({ fresh: true });
    });
  }

  // ── The slot across a reload (§14.1) ───────────────────────────────────────

  /** The slot kept by a page that was unloaded within its life, or null: one of the other mode (a secret kept where
   *  the server holds it, or none where the page opens the payloads itself) is no slot of this session. */
  private kept(): KeptSlot | null {
    if (!this.keep) return null;
    let kept: KeptSlot;
    try {
      const text = this.keep.getItem(KEPT_SLOT_KEY);
      if (!text) return null;
      kept = JSON.parse(text) as KeptSlot;
    } catch {
      return null;
    }
    const key = (v: unknown) => typeof v === "string" && fromB64Loose(v)?.length === 32;
    const sound =
      typeof kept === "object" && kept !== null && typeof kept.base === "string" && this.o.relays.includes(kept.base) && typeof kept.opened === "number" &&
      typeof kept.name === "string" && [kept.relay, kept.sid, kept.boxKey, kept.page].every(key) &&
      (this.o.courier ? kept.boxSecret === undefined : key(kept.boxSecret));
    if (!sound || this.now() - kept.opened >= SLOT_LIFE_MS || this.now() < kept.opened) {
      this.forget();
      return null;
    }
    return kept;
  }

  private remember(): void {
    const slot = this.slot;
    if (!this.keep || !slot) return;
    const kept: KeptSlot = {
      base: slot.base, relay: b64url(slot.offer.relay), sid: b64url(slot.keys.sid), boxKey: b64url(slot.keys.boxKey), page: b64url(slot.keys.page),
      name: slot.offer.name, opened: slot.opened, seen: this.seen, held: this.held,
      ...(slot.keys.boxSecret ? { boxSecret: b64url(slot.keys.boxSecret) } : {}),
    };
    try {
      this.keep.setItem(KEPT_SLOT_KEY, JSON.stringify(kept));
    } catch {
      /* storage full or blocked: the slot lives in this page alone */
    }
  }

  private forget(): void {
    try {
      this.keep?.removeItem(KEPT_SLOT_KEY);
    } catch {
      /* nothing kept */
    }
  }

  /** Stop everything: the slot goes with its connection, a confirmation still on its way with it. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    this.closeLink();
    this.confirming?.close();
    this.confirming = null;
    this.slot?.keys.boxSecret?.fill(0);
    this.slot = null;
  }

  /** The visitor opened the link to Saltix on this phone: the offer stays while the wallet answers, and the slot is
   *  kept as held, so a page the browser unloads on the way opens it again on its return. */
  handOff(): void {
    if (this.slot && !this.held) {
      this.held = true;
      this.remember();
      this.o.events.telemetry("connect_link_opened");
    }
  }

  /** An unseen offer is replaced after its time, but only in front of the visitor: one in the background may be
   * on its way to the wallet on this phone. While a grant is checked it waits: the check's refusal calls it again. */
  private expire(): void {
    if (this.seen || this.held || this.phase.kind !== "offer") return;
    if (!this.visible()) {
      this.after(KEEP_MS, () => this.expire());
      return;
    }
    this.o.events.telemetry("connect_offer_expired");
    void this.start({ fresh: true });
  }

  /** The page came back to the foreground: an unseen code past its life is replaced at once, not at the next look a
   *  minute later (a page hidden that long shows a code that already changed), and a dropped connection is opened
   *  again at once. */
  wake(): void {
    const slot = this.slot;
    if (!slot || this.stopped) return;
    // An offer the wallet read is no longer in the offer phase; one taken to Saltix here keeps its slot, opened below.
    const p = this.phase;
    if (p.kind === "offer" && !this.held && this.now() >= p.expiresAt) {
      this.expire();
      return;
    }
    if (!slot.link_) {
      this.reopenAttempt = 0;
      void this.reopen();
    }
  }

  // ── The relay ──────────────────────────────────────────────────────────────

  /** A connection to `base` holding slot `sid`, and the relay's node key, or null. */
  private async open(base: string, sid: Uint8Array): Promise<{ link: RelayLink; relay: Uint8Array; early: Frame[] } | null> {
    let link: RelayLink;
    try {
      link = await this.o.dial(base);
    } catch {
      this.o.events.telemetry("connect_slot_failed", { kind: "unreachable", relay: this.o.relays.indexOf(base) + 1 });
      return null;
    }
    // What the relay sends right after `link_opened` — the payload a parked slot held (09-relay §10.3 step 6a) —
    // arrives before the slot is attached: kept, and handed to the slot's handler then.
    const early: Frame[] = [];
    const answer = await new Promise<Frame | null>((resolve) => {
      const timer = this.setT(() => resolve(null), OPEN_MS);
      let opened = false;
      link.onFrame = (f) => {
        if (opened) {
          early.push(f);
          return;
        }
        if (f.type === "link_opened" || (f.type === "error" && f.detail === "link_open")) {
          opened = true;
          this.clearT(timer);
          resolve(f);
        }
      };
      link.onClose = () => {
        this.clearT(timer);
        resolve(null);
      };
      link.send({ type: "link_open", sid: b64url(sid) });
    });
    if (!answer || answer.type !== "link_opened") {
      this.o.events.telemetry("connect_slot_failed", { kind: answer ? String(answer.message ?? "error") : "no_answer", relay: this.o.relays.indexOf(base) + 1 });
      link.close();
      return null;
    }
    const relay = fromB64Loose(String(answer.relay ?? "")) ?? link.relay;
    if (relay.length !== 32) {
      // No relay key to offer: the slot it holds is of no use.
      this.o.events.telemetry("connect_slot_failed", { kind: "relay_key", relay: this.o.relays.indexOf(base) + 1 });
      link.close();
      return null;
    }
    return { link, relay, early };
  }

  private attach(link: RelayLink, early: Frame[] = []): void {
    const slot = this.slot!;
    slot.link_ = link;
    link.onFrame = (f) => this.onFrame(f);
    for (const f of early) this.onFrame(f);
    link.onClose = () => {
      if (this.slot !== slot || this.stopped) return;
      slot.link_ = null;
      if (this.phase.kind === "connected") return;
      this.o.events.reconnecting(true);
      void this.reopen();
    };
  }

  private keepOpen(): void {
    const slot = this.slot;
    if (!slot || !slot.link_ || this.now() - slot.opened >= SLOT_LIFE_MS) return;
    slot.link_.send({ type: "link_open", sid: b64url(slot.keys.sid) });
  }

  /** Open the same slot again at the same relay, with growing waits; a relay that is another one now voids the offer.
   *  While the page is hidden nothing is dialed: a phone's browser in the background has no network, each attempt would
   *  fail and count, and the relay keeps the slot parked with what the wallet delivers (09-relay §10.3 step 6a); `wake()`
   *  opens it the moment the page is in front again. */
  private async reopen(): Promise<void> {
    const slot = this.slot;
    const generation = this.generation;
    if (!slot || slot.link_ || this.stopped) return;
    if (!this.visible()) {
      this.after(HIDDEN_CHECK_MS, () => void this.reopen());
      return;
    }
    const opened = await this.open(slot.base, slot.keys.sid);
    if (this.stopped || generation !== this.generation || this.slot !== slot) {
      opened?.link.close();
      return;
    }
    if (slot.link_) {
      opened?.link.close();
      return;
    }
    if (opened && equal(opened.relay, slot.offer.relay)) {
      this.attach(opened.link, opened.early);
      this.reopenAttempt = 0;
      this.o.events.reconnecting(false);
      this.o.events.telemetry("connect_reconnect", { ok: true });
      return;
    }
    if (opened) {
      // Another relay answers at this path: the offer on the screen names the old one.
      opened.link.close();
      this.o.events.telemetry("connect_reconnect", { ok: false, kind: "other_relay" });
      this.o.events.reconnecting(false);
      void this.start({ fresh: true });
      return;
    }
    const wait = REOPEN_MS[Math.min(this.reopenAttempt++, REOPEN_MS.length - 1)]!;
    this.after(wait, () => void this.reopen());
  }

  // ── What comes to the slot ─────────────────────────────────────────────────

  private onFrame(f: Frame): void {
    const slot = this.slot;
    if (!slot || f.type !== "link_payload" || f.sid !== b64url(slot.keys.sid)) return;
    const sealed = fromB64Loose(String(f.payload ?? ""));
    if (!sealed) return;
    if (this.o.courier) {
      // The server-held mode: sealed as it came, to the server, in the order it came (§15.1 step 3).
      if (this.phase.kind === "connected") return;
      slot.queue.push(sealed);
      void this.forward(slot);
      return;
    }
    const plain = openLinkPayload(slot.keys.boxSecret!, slot.keys.sid, slot.keys.page, sealed);
    // Anyone who saw the QR can deliver to the slot: what does not open or decode is ignored (§5).
    if (!plain) return;
    let payload;
    try {
      payload = decodePayload(plain);
    } catch (e) {
      this.o.events.telemetry("connect_payload_ignored", { reason: e instanceof ConnectError ? e.reason : "encoding" });
      return;
    }
    if (payload.kind === "seen") {
      this.noticed(slot);
      return;
    }
    if (payload.kind === "reply") {
      // Where the wallet waits for the page's word: kept for the grant that follows (§14.2 step 3). Anyone who saw the
      // QR could deliver one, so it counts only for the grant whose login it names.
      slot.reply = payload.reply;
      this.o.events.telemetry("connect_reply");
      return;
    }
    if (this.phase.kind === "checking" || this.phase.kind === "connected") return;
    void this.check(slot, payload.grant, payload.bytes);
  }

  /** The wallet read the offer: "continue on your phone", once. In the page's own mode a notice that comes while a
   *  grant is checked is nothing new; the server's word on a forwarded payload may say it first (§15.1 step 4). */
  private noticed(slot: Slot, whileChecking = false): void {
    if (this.seen || !(this.phase.kind === "offer" || (whileChecking && this.phase.kind === "checking"))) return;
    this.seen = true;
    this.remember();
    this.o.events.telemetry("connect_seen", { ms: this.now() - slot.opened });
    this.setPhase({ kind: "seen", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app });
    this.awaitLogin();
  }

  /** The code was read: its login is waited for `SEEN_WAIT_MS` from now. */
  private awaitLogin(): void {
    const at = (this.seenAt = this.now());
    this.after(SEEN_WAIT_MS, () => this.loginLate(at));
  }

  /** A read code whose login did not come: a new one, once the page is in front with its slot connected and no grant
   *  is being checked; until then it looks again every minute. A refused grant waited for afresh ends this wait. */
  private loginLate(at: number): void {
    const kind = this.phase.kind;
    if (this.seenAt !== at || (kind !== "seen" && kind !== "checking")) return;
    if (kind === "checking" || !this.visible() || !this.slot?.link_) {
      this.after(KEEP_MS, () => this.loginLate(at));
      return;
    }
    this.o.events.telemetry("connect_seen_expired");
    void this.start({ fresh: true });
  }

  /** The phase a refused grant goes back to: the offer, or the wallet's notice. */
  private backPhase(slot: Slot): Phase {
    return this.seen
      ? { kind: "seen", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app }
      : { kind: "offer", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app, expiresAt: slot.opened + this.qrLife };
  }

  /** A refused grant, or one that could not be checked: the reason to the page, the offer back, and the code's life,
   *  which may have passed while the grant was checked (its expiry found it `checking` and let it be). */
  private refused(slot: Slot, reason: string, meta: Record<string, string | number | boolean>): void {
    const back = this.backPhase(slot);
    this.o.events.telemetry("connect_refused", { reason, ...meta });
    this.o.events.refused({ reason, at: this.now() });
    this.setPhase(back);
    if (back.kind === "offer" && this.now() >= back.expiresAt) this.expire();
    // Back to the read code: its login is waited for afresh, so the reason is read before a new code comes.
    if (back.kind === "seen") this.awaitLogin();
  }

  /** The grant checks: the page shows the connection now (§14.1); the confirmation goes to the wallet behind it, and
   *  the slot closes once it is on its way (§14.2 step 3). The slot's connection comes back for that. */
  private taken(slot: Slot, value: T, meta: Record<string, string | number | boolean>): RelayLink | null {
    this.o.events.telemetry("connect_grant", { ms: this.now() - slot.opened, seen: this.seen, ...meta });
    this.clearTimers();
    const link = slot.link_;
    slot.link_ = null;
    this.slot = null;
    this.forget();
    this.setPhase({ kind: "connected" });
    this.o.connected(value);
    return link;
  }

  private async check(slot: Slot, grant: ConnectGrant, bytes: Uint8Array): Promise<void> {
    this.setPhase({ kind: "checking", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app });
    const session: Session = { network: this.o.network!, origin: this.o.origin, sid: slot.keys.sid, page: slot.keys.page };
    try {
      const value = await this.o.verify!(grant, bytes, session);
      if (this.slot !== slot || this.stopped) return;
      const link = this.taken(slot, value, { signer: signerKind(grant.signer) });
      void this.confirm(link, slot, grant);
    } catch (e) {
      if (this.slot !== slot || this.stopped) return;
      const reason = e instanceof ConnectError ? e.reason : "unchecked";
      const kind = (e as { kind?: unknown } | null)?.kind;
      this.refused(slot, reason, { signer: signerKind(grant.signer), ...(typeof kind === "string" ? { kind } : {}) });
    }
  }

  /**
   * The server-held mode (§15.1 steps 3–5): each payload to the server as it came, one at a time, and the server's
   * word on it. The page cannot tell a notice from a grant without `Q`'s secret, so it says it is checking only once
   * the wallet was seen and its reply taken: what comes then is the grant (§14.2 step 1).
   */
  private async forward(slot: Slot): Promise<void> {
    if (slot.forwarding) return;
    slot.forwarding = true;
    try {
      while (slot.queue.length > 0 && this.slot === slot && !this.stopped && this.phase.kind !== "connected") {
        const sealed = slot.queue.shift()!;
        if (this.seen && slot.replied && this.phase.kind === "seen") this.setPhase({ kind: "checking", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app });
        const started = this.now();
        let answer: CourierAnswer<T>;
        try {
          answer = await this.o.courier!.take(slot.keys.sid, sealed);
        } catch (e) {
          const kind = (e as { kind?: unknown } | null)?.kind;
          answer = { kind: "unchecked", detail: typeof kind === "string" ? kind : "server" };
        }
        if (this.slot !== slot || this.stopped) return;
        this.answered(slot, answer, this.now() - started);
      }
    } finally {
      slot.forwarding = false;
    }
  }

  /** The server's word on a forwarded payload. */
  private answered(slot: Slot, answer: CourierAnswer<T>, ms: number): void {
    const checking = this.phase.kind === "checking";
    switch (answer.kind) {
      case "ignored":
        this.o.events.telemetry("connect_payload_ignored", { reason: "server", ms });
        if (checking) this.setPhase(this.backPhase(slot));
        return;
      case "seen":
        if (!this.seen) this.noticed(slot, true);
        else if (checking) this.setPhase(this.backPhase(slot));
        return;
      case "reply":
        slot.replied = true;
        this.o.events.telemetry("connect_reply", { ms });
        if (checking) this.setPhase(this.backPhase(slot));
        return;
      case "refused":
        this.refused(slot, answer.reason, { ms });
        // The server holds no such offer (past its life, or dropped): a fresh one, as an expired offer's.
        if (answer.reason === "offer" && this.slot === slot) void this.start({ fresh: true });
        return;
      case "unchecked":
        this.refused(slot, "unchecked", { kind: answer.detail, ms });
        return;
      case "connected": {
        const link = this.taken(slot, answer.value, { ms_server: ms });
        void this.confirmFromServer(link, answer.confirm);
        return;
      }
    }
  }

  /**
   * The page's confirmation (§14.2 step 3): to the reply slot whose `login` is this grant's, sealed to the reply's key
   * with the reply slot and the page's `P` as its associated data, delivered on the slot's own connection; the relay's
   * `link_delivered` is waited for `CONFIRM_DELIVERED_MS`, then the connection closes. Without a reply (an older
   * wallet), one for another login, or no connection, the slot just closes: the wallet says so on its side.
   */
  private async confirm(link: RelayLink | null, slot: Slot, grant: ConnectGrant): Promise<void> {
    const reply = slot.reply;
    const login = loginMessage(grant.login);
    slot.keys.boxSecret?.fill(0);
    if (!link) {
      this.o.events.telemetry("connect_confirm", { outcome: "no_link" });
      return;
    }
    if (!reply || !equal(reply.login, login)) {
      this.o.events.telemetry("connect_confirm", { outcome: reply ? "other_login" : "no_reply" });
      link.close();
      return;
    }
    const confirm = encodeConfirm({ version: CONFIRM_VERSION, login, at: BigInt(this.now()) });
    await this.deliver(link, reply.relay, reply.sid, sealLinkPayload(reply.key, reply.sid, slot.keys.page, confirm));
  }

  /** The server-held mode's confirmation (§15.3): sealed by the server, which held the reply and `Q`; the page
   *  delivers it as its own. Without one, the slot just closes. */
  private async confirmFromServer(link: RelayLink | null, confirm: { relay: Uint8Array; sid: Uint8Array; payload: Uint8Array } | null): Promise<void> {
    if (!link) {
      this.o.events.telemetry("connect_confirm", { outcome: "no_link" });
      return;
    }
    if (!confirm) {
      this.o.events.telemetry("connect_confirm", { outcome: "no_reply" });
      link.close();
      return;
    }
    await this.deliver(link, confirm.relay, confirm.sid, confirm.payload);
  }

  /** `link_deliver` on the slot's own connection, which a relay takes from a connection holding a slot (09-relay
   *  §10.3 step 5), and the relay's word on it; then the connection closes. */
  private async deliver(link: RelayLink, relay: Uint8Array, replySid: Uint8Array, payload: Uint8Array): Promise<void> {
    this.confirming = link;
    const sid = b64url(replySid);
    const delivered = await new Promise<boolean | null>((resolve) => {
      const timer = this.setT(() => resolve(null), CONFIRM_DELIVERED_MS);
      link.onFrame = (f) => {
        if ((f.type === "link_delivered" && f.sid === sid) || (f.type === "error" && f.detail === "link_deliver")) {
          this.clearT(timer);
          resolve(f.type === "link_delivered" && f.delivered === true);
        }
      };
      link.onClose = () => {
        this.clearT(timer);
        resolve(false);
      };
      if (!link.send({ type: "link_deliver", relay: b64url(relay), sid, payload: b64url(payload) })) {
        this.clearT(timer);
        resolve(false);
      }
    });
    this.o.events.telemetry("connect_confirm", { outcome: delivered === null ? "no_answer" : delivered ? "delivered" : "not_delivered" });
    if (this.confirming === link) this.confirming = null;
    link.close();
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────

  private setPhase(p: Phase): void {
    this.phase = p;
    this.o.events.phase(p);
  }

  private fail(reason: FailKind): void {
    this.clearTimers();
    this.closeLink();
    this.forget();
    this.setPhase({ kind: "failed", reason });
  }

  private closeLink(): void {
    const link = this.slot?.link_;
    if (link) {
      this.slot!.link_ = null;
      link.close();
    }
  }

  private after(ms: number, f: () => void): void {
    const t = this.setT(() => {
      this.timers.delete(t);
      if (!this.stopped) f();
    }, ms);
    this.timers.add(t);
  }

  private every(ms: number, f: () => void): void {
    this.after(ms, () => {
      f();
      this.every(ms, f);
    });
  }

  private clearTimers(): void {
    for (const t of this.timers) this.clearT(t);
    this.timers.clear();
  }

  private shuffled<X>(list: readonly X[]): X[] {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}
