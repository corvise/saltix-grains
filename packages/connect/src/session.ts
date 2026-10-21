/*
 * One Saltix Connect attempt of the page (Saltix 19-connect §2–§5, §14), a port of the explorer's
 * `explorer/src/connect/session.ts`: a slot at a relay, the offer for the QR code and the link, the wallet's notice that
 * it saw the offer, and the grant, checked before the page takes it — then the page's confirmation to the wallet's
 * reply slot (§14.2), sent before the slot closes, so the wallet shows "connected" on the page's word.
 *
 *   opening ──► offer ──► seen ──► checking ──► connected (the page shows it at once; the confirmation goes out behind)
 *      │          │  ▲       │          │
 *      ▼          ▼  │       ▼          └─► a refused grant: back to offer or seen, with the reason
 *    failed    (2 minutes unseen: a new slot and new keys)
 *
 * The slot belongs to the connection that opened it, so a dropped connection (a phone's browser in the background)
 * opens the same slot again at the same relay; the wallet's delivery finds it then. Everything that waits is a timer
 * the session owns, so `stop()` leaves nothing running. Telemetry never carries a key, a slot or an account.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { b64url, equal, fromB64Loose } from "./codec.js";
import {
  CONFIRM_DELIVERED_MS, CONFIRM_VERSION, ConnectError, type ConnectGrant, type ConnectReply, type Session, decodePayload, encodeConfirm,
  loginMessage, signerKind,
} from "./grant.js";
import { type Offer, offerAppLink, offerLink, offerText } from "./offer.js";
import type { Dial, Frame, RelayLink } from "./relay.js";
import { boxPublic, openLinkPayload, randomSecret, sealLinkPayload } from "./seal.js";

/** How long one offer is shown unseen before a new slot and new keys replace it. */
export const QR_LIFE_MS = 2 * 60_000;
/** The slot is opened again this often, so it never goes idle (5 minutes, 09-relay §10.3). */
export const KEEP_MS = 60_000;
/** A slot lives this long in all; the page gives up waiting then. */
export const SLOT_LIFE_MS = 30 * 60_000;
/** How long the relay has to answer `link_open`. */
export const OPEN_MS = 10_000;
/** Waits between attempts to open the same slot again after its connection dropped. */
const REOPEN_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** How often a hidden page looks whether it is in front again, between a dropped connection and `wake()`. */
const HIDDEN_CHECK_MS = 15_000;

export interface SessionKeys {
  sid: Uint8Array;
  boxSecret: Uint8Array;
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

export type Phase =
  | { kind: "opening" }
  | { kind: "offer"; offer: Offer; text: string; link: string; app: string; expiresAt: number }
  | { kind: "seen"; offer: Offer; text: string; link: string; app: string }
  | { kind: "checking"; offer: Offer; text: string; link: string; app: string }
  | { kind: "connected" }
  | { kind: "failed"; reason: "no_relay" | "refused" | "network" };

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
  /** The network's genesis hash and its kind (`relay`'s hello must name the same kind). */
  network: Uint8Array;
  networkKind: string;
  origin: string;
  name: string;
  dial: Dial;
  keys: () => Promise<SessionKeys>;
  /** The chain's side of §5 (rule 5, and whatever the page keeps): throws a [ConnectError] to refuse. */
  verify: (grant: ConnectGrant, bytes: Uint8Array, session: Session) => Promise<T>;
  /** Called once with what `verify` returned. */
  connected: (value: T) => void;
  events: SessionEvents;
  now?: () => number;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  random?: () => number;
  /** Whether the page is in front of the visitor: an offer is replaced only then. */
  visible?: () => boolean;
  /** The browser's user agent: on Android the link that opens Saltix is an intent link (§14.1). */
  userAgent?: string;
  /**
   * Where the slot is kept across a reload of the page (§14.1): `sessionStorage` by default, so a page the browser
   * unloaded while handing the offer to Saltix and loaded again opens the same slot with the same keys, and the
   * wallet's delivery, tried again for 30 seconds, still lands. Null keeps nothing.
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

/** A slot as the page keeps it: enough to open it again and to open what the wallet delivers to it. */
interface KeptSlot {
  base: string;
  relay: string;
  sid: string;
  boxSecret: string;
  page: string;
  opened: number;
  seen: boolean;
  held: boolean;
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
  /** The visitor took the offer to the wallet on this phone: it stays until the slot's end. */
  private held = false;
  /** The slot's connection while the page's confirmation is on its way, after the page connected. */
  private confirming: RelayLink | null = null;

  constructor(private readonly o: SessionOptions<T>) {
    this.now = o.now ?? (() => Date.now());
    this.setT = o.setTimeout ?? ((f, ms) => setTimeout(f, ms));
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.random = o.random ?? Math.random;
    this.visible = o.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
    this.userAgent = o.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
    this.keep = o.keep === undefined ? defaultKeep() : o.keep;
  }

  get current(): Phase {
    return this.phase;
  }

  /**
   * Open a slot and show its offer; again with new keys whenever asked (`fresh`) or when an unseen offer expires. Not
   * fresh, a slot the page kept across a reload (§14.1) is opened again first — the same id at the same relay, with the
   * same keys and the same offer — so that a wallet already delivering to it still reaches the page; a relay that no
   * longer answers with the same node key, or a kept slot past its life, gives way to a fresh one.
   */
  async start(options: { fresh?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    this.clearTimers();
    this.closeLink();
    this.slot?.keys.boxSecret.fill(0);
    this.slot = null;
    this.seen = false;
    this.held = false;
    this.reopenAttempt = 0;
    this.setPhase({ kind: "opening" });
    if (this.o.relays.length === 0) return this.fail("no_relay");
    const kept = options.fresh ? null : this.kept();
    if (options.fresh) this.forget();
    if (kept) {
      const keys: SessionKeys = { sid: fromB64Loose(kept.sid)!, boxSecret: fromB64Loose(kept.boxSecret)!, boxKey: boxPublic(fromB64Loose(kept.boxSecret)!), page: fromB64Loose(kept.page)!, pageKey: null, webCrypto: false };
      const opened = await this.open(kept.base, keys.sid);
      if (this.stopped || generation !== this.generation) {
        opened?.link.close();
        return;
      }
      if (opened && opened.link.network === this.o.networkKind && equal(opened.relay, fromB64Loose(kept.relay) ?? new Uint8Array())) {
        const offer: Offer = { relay: opened.relay, sid: keys.sid, boxKey: keys.boxKey, page: keys.page, origin: this.o.origin, name: this.o.name };
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
    const keys = await this.o.keys();
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
      const offer: Offer = { relay: opened.relay, sid: keys.sid, boxKey: keys.boxKey, page: keys.page, origin: this.o.origin, name: this.o.name };
      this.place(base, keys, offer, this.now(), opened.link, opened.early);
      this.o.events.telemetry("connect_open", { relay: this.o.relays.indexOf(base) + 1, webcrypto: keys.webCrypto });
      return;
    }
    this.o.events.telemetry("connect_slot_failed", { kind: "no_relay", relays: this.o.relays.length });
    this.fail("no_relay");
  }

  /** The slot is held: its offer shown, kept across a reload, kept open, and its times set. */
  private place(base: string, keys: SessionKeys, offer: Offer, opened: number, link: RelayLink, early: Frame[] = []): void {
    const text = offerText(offer);
    this.slot = { base, keys, offer, text, link: offerLink(offer), app: offerAppLink(offer, this.userAgent), opened, link_: link, reply: null };
    this.remember();
    const slot = this.slot;
    if (this.seen) this.setPhase({ kind: "seen", offer, text, link: slot.link, app: slot.app });
    else this.setPhase({ kind: "offer", offer, text, link: slot.link, app: slot.app, expiresAt: opened + QR_LIFE_MS });
    // Attached after the offer is shown: a payload the relay held for a parked slot goes straight to its check.
    this.attach(link, early);
    this.every(KEEP_MS, () => this.keepOpen());
    const left = Math.max(0, opened + SLOT_LIFE_MS - this.now());
    this.after(Math.max(0, opened + QR_LIFE_MS - this.now()), () => this.expire());
    this.after(left, () => {
      if (this.phase.kind !== "connected" && this.phase.kind !== "checking") void this.start({ fresh: true });
    });
  }

  // ── The slot across a reload (§14.1) ───────────────────────────────────────

  /** The slot kept by a page that was unloaded within its life, or null. */
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
    const sound =
      typeof kept.base === "string" && this.o.relays.includes(kept.base) && typeof kept.opened === "number" &&
      [kept.relay, kept.sid, kept.boxSecret, kept.page].every((v) => typeof v === "string" && fromB64Loose(v)?.length === 32);
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
      base: slot.base, relay: b64url(slot.offer.relay), sid: b64url(slot.keys.sid), boxSecret: b64url(slot.keys.boxSecret), page: b64url(slot.keys.page),
      opened: slot.opened, seen: this.seen, held: this.held,
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
    this.slot?.keys.boxSecret.fill(0);
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

  /** The page came back to the foreground: a dropped connection is opened again at once. */
  wake(): void {
    if (this.slot && !this.slot.link_ && !this.stopped) {
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
    const plain = sealed ? openLinkPayload(slot.keys.boxSecret, slot.keys.sid, slot.keys.page, sealed) : null;
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
      if (!this.seen && this.phase.kind === "offer") {
        this.seen = true;
        this.remember();
        this.o.events.telemetry("connect_seen", { ms: this.now() - slot.opened });
        this.setPhase({ kind: "seen", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app });
      }
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

  private async check(slot: Slot, grant: ConnectGrant, bytes: Uint8Array): Promise<void> {
    const back: Phase = this.seen
      ? { kind: "seen", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app }
      : { kind: "offer", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app, expiresAt: slot.opened + QR_LIFE_MS };
    this.setPhase({ kind: "checking", offer: slot.offer, text: slot.text, link: slot.link, app: slot.app });
    const session: Session = { network: this.o.network, origin: this.o.origin, sid: slot.keys.sid, page: slot.keys.page };
    try {
      const value = await this.o.verify(grant, bytes, session);
      if (this.slot !== slot || this.stopped) return;
      this.o.events.telemetry("connect_grant", {
        ms: this.now() - slot.opened,
        signer: signerKind(grant.signer),
        seen: this.seen,
      });
      this.clearTimers();
      // The page shows the connection now (§14.1); the confirmation goes to the wallet behind it, and the slot closes
      // once it is on its way (§14.2 step 3).
      const link = slot.link_;
      slot.link_ = null;
      this.slot = null;
      this.forget();
      this.setPhase({ kind: "connected" });
      this.o.connected(value);
      void this.confirm(link, slot, grant);
    } catch (e) {
      if (this.slot !== slot || this.stopped) return;
      const reason = e instanceof ConnectError ? e.reason : "unchecked";
      const kind = (e as { kind?: unknown } | null)?.kind;
      this.o.events.telemetry("connect_refused", { reason, signer: signerKind(grant.signer), ...(typeof kind === "string" ? { kind } : {}) });
      this.o.events.refused({ reason, at: this.now() });
      this.setPhase(back);
      // The offer's two minutes may have passed while the grant was checked: its expiry found it `checking` and let it
      // be, so it is due now, or the offer would stay to the slot's thirty.
      if (back.kind === "offer" && this.now() >= back.expiresAt) this.expire();
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
    slot.keys.boxSecret.fill(0);
    if (!link) {
      this.o.events.telemetry("connect_confirm", { outcome: "no_link" });
      return;
    }
    if (!reply || !equal(reply.login, login)) {
      this.o.events.telemetry("connect_confirm", { outcome: reply ? "other_login" : "no_reply" });
      link.close();
      return;
    }
    this.confirming = link;
    const confirm = encodeConfirm({ version: CONFIRM_VERSION, login, at: BigInt(this.now()) });
    const payload = sealLinkPayload(reply.key, reply.sid, slot.keys.page, confirm);
    const sid = b64url(reply.sid);
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
      if (!link.send({ type: "link_deliver", relay: b64url(reply.relay), sid, payload: b64url(payload) })) {
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

  private fail(reason: "no_relay" | "refused" | "network"): void {
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
