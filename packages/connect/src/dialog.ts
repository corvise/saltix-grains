// The dialog a tap on "Sign in with Saltix" opens (Saltix 19-connect §13 step 3): titled "Saltix Connect", the offer's
// QR code with "Scan with Saltix to sign in", and on a phone the "Open Saltix" link that opens the wallet on the phone
// itself. It follows the session: "continue in Saltix" once the wallet read the code, a refusal with its reason, and
// under the code the quiet countdown to the next one, which comes by itself (19-connect §15.4: no button for a new code;
// "Try again" only after a failure). Built with DOM calls and the classes of `connect.css`: no inline style, no markup
// parsed.
import { type ConnectEvents, ConnectFailed, type OfferView, type SaltixConnect } from "./client.js";
import { markElement } from "./mark.js";
import type { Connection } from "./store.js";
import { type Lang, WORDS } from "./words.js";

const SVG = "http://www.w3.org/2000/svg";

export interface DialogOptions {
  lang?: Lang;
  /** The dialog's colours: `light` (the default) or `dark`. */
  theme?: "light" | "dark";
  /** Whether the page is on a phone, which shows "Open Saltix"; by default a coarse pointer says so. */
  phone?: boolean;
  /** The document to draw in: the page's by default. */
  document?: Document;
  /** The clock the countdown reads and ticks by (tests): `Date.now` and the page's own timers by default. */
  clock?: DialogClock;
}

/** What the countdown under the code needs of a clock. */
export interface DialogClock {
  now(): number;
  setInterval(f: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
}

const PAGE_CLOCK: DialogClock = {
  now: () => Date.now(),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
};

/** The time left until `expiresAt` as the dialog writes it under the code: `m:ss`, rounded up, never below 0:00. */
export function codeCountdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** The classes the dialog uses (connect.css). */
export const DIALOG_CLASSES = {
  dialog: "saltix-connect-dialog",
  dark: "saltix-connect-dialog--dark",
  head: "saltix-connect-dialog__head",
  mark: "saltix-connect-dialog__mark",
  title: "saltix-connect-dialog__title",
  close: "saltix-connect-dialog__close",
  scan: "saltix-connect-dialog__scan",
  qr: "saltix-connect-dialog__qr",
  open: "saltix-connect-dialog__open",
  countdown: "saltix-connect-dialog__countdown",
  status: "saltix-connect-dialog__status",
  actions: "saltix-connect-dialog__actions",
  action: "saltix-connect-dialog__action",
  note: "saltix-connect-dialog__note",
  qrLight: "saltix-qr__light",
  qrDark: "saltix-qr__dark",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The offer's QR code as an `svg` element: a light square and one dark path, coloured by classes. */
function qrElement(doc: Document, offer: OfferView, label: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg") as SVGSVGElement;
  svg.setAttribute("class", DIALOG_CLASSES.qr);
  svg.setAttribute("viewBox", `0 0 ${offer.qr.size} ${offer.qr.size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const light = doc.createElementNS(SVG, "rect");
  light.setAttribute("class", DIALOG_CLASSES.qrLight);
  light.setAttribute("width", String(offer.qr.size));
  light.setAttribute("height", String(offer.qr.size));
  const dark = doc.createElementNS(SVG, "path");
  dark.setAttribute("class", DIALOG_CLASSES.qrDark);
  dark.setAttribute("d", offer.qr.path);
  svg.append(light, dark);
  return svg;
}

/**
 * Open the Saltix Connect dialog for `connect`: it starts a session (or shows the one running), and resolves with the
 * connection once the visitor signed in, or null when the dialog is closed first (the session is then cancelled).
 */
export function openConnectDialog(connect: SaltixConnect, o: DialogOptions = {}): Promise<Connection | null> {
  const doc = o.document ?? document;
  const words = WORDS[o.lang ?? "en"];
  const phone = o.phone ?? doc.defaultView?.matchMedia?.("(pointer: coarse)").matches ?? false;

  const dialog = element(doc, "dialog", DIALOG_CLASSES.dialog) as HTMLDialogElement;
  if (o.theme === "dark") dialog.classList.add(DIALOG_CLASSES.dark);
  dialog.setAttribute("lang", o.lang ?? "en");
  dialog.setAttribute("aria-label", words.title);
  const head = element(doc, "div", DIALOG_CLASSES.head);
  const title = element(doc, "h2", DIALOG_CLASSES.title, words.title);
  const close = element(doc, "button", DIALOG_CLASSES.close, "×");
  close.setAttribute("type", "button");
  close.setAttribute("aria-label", words.close);
  head.append(markElement(doc, DIALOG_CLASSES.mark), title, close);
  const scan = element(doc, "p", DIALOG_CLASSES.scan, words.scan);
  const code = element(doc, "div", "saltix-connect-dialog__code");
  // The link that opens Saltix without unloading this page (19-connect §14.1): an intent link on Android, which the
  // browser hands to the installed app as an external intent instead of navigating; the https link elsewhere. Never a
  // new tab (the visitor would come back to a page still offering a consumed offer), never a navigation of this tab
  // (the page, its socket and its slot would go, and the wallet would have nothing to deliver to).
  const open = element(doc, "a", DIALOG_CLASSES.open, words.open);
  open.setAttribute("rel", "noopener noreferrer");
  open.hidden = true;
  // When the code changes by itself: read by eye, so out of the screen reader's way (it would speak every second).
  const countdown = element(doc, "p", DIALOG_CLASSES.countdown);
  countdown.setAttribute("aria-hidden", "true");
  countdown.hidden = true;
  const status = element(doc, "p", DIALOG_CLASSES.status);
  status.setAttribute("role", "status");
  status.hidden = true;
  // Only after a failure: there is no code to wait for then.
  const actions = element(doc, "div", DIALOG_CLASSES.actions);
  actions.hidden = true;
  const retry = element(doc, "button", DIALOG_CLASSES.action, words.retry);
  retry.setAttribute("type", "button");
  actions.append(retry);
  const note = element(doc, "p", DIALOG_CLASSES.note, words.note);
  dialog.append(head, scan, code, countdown, open, status, actions, note);
  doc.body.append(dialog);

  const clock = o.clock ?? PAGE_CLOCK;
  /** The code on screen, and why the last grant for it was refused: the reason stays while that code does (the session
   *  shows the same code again right after a refusal), and goes with it. */
  let shown: string | null = null;
  let refusal: string | null = null;
  let expiresAt: number | null = null;
  let ticker: unknown = null;
  const tick = () => {
    if (expiresAt !== null) countdown.textContent = words.changesIn.replace("{time}", codeCountdown(expiresAt, clock.now()));
  };
  /** The countdown under an unseen code, ticking every second; none once the wallet read it or nothing is shown. */
  const count = (until: number | null) => {
    expiresAt = until;
    countdown.hidden = until === null;
    if (until !== null) {
      tick();
      if (ticker === null) ticker = clock.setInterval(tick, 1000);
    } else if (ticker !== null) {
      clock.clearInterval(ticker);
      ticker = null;
    }
  };
  const say = (text: string | null) => {
    status.textContent = text ?? "";
    status.hidden = text === null;
  };
  const show = (offer: OfferView) => {
    if (offer.text !== shown) {
      shown = offer.text;
      refusal = null;
      code.replaceChildren(qrElement(doc, offer, words.qr));
    }
    open.setAttribute("href", offer.app);
    open.hidden = !phone;
    actions.hidden = true;
    count(offer.expiresAt);
  };

  return new Promise<Connection | null>((resolve) => {
    let done = false;
    const off: Array<() => void> = [];
    const finish = (result: Connection | null) => {
      if (done) return;
      done = true;
      for (const f of off) f();
      count(null);
      if (result === null) connect.cancel();
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      dialog.remove();
      resolve(result);
    };
    const failed = () => {
      count(null);
      say(words.failed);
      actions.hidden = false;
    };
    const on = <E extends keyof ConnectEvents>(event: E, f: (data: ConnectEvents[E]) => void) => off.push(connect.on(event, f));
    on("offer", (offer) => {
      show(offer);
      say(refusal);
    });
    on("seen", () => {
      count(null);
      say(refusal ?? words.seen);
    });
    on("checking", () => {
      refusal = null;
      say(words.checking);
    });
    on("refused", ({ reason }) => {
      refusal = reason === "unchecked" ? words.unchecked : words.refused.replace("{reason}", reason);
      say(refusal);
    });
    on("failed", failed);
    on("connected", (c) => finish(c));
    close.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    });
    open.addEventListener("click", () => connect.handOff());
    retry.addEventListener("click", () => {
      say(null);
      actions.hidden = true;
      connect.renew().catch(() => {});
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    // Closed before the session answered: nothing is drawn, and no countdown starts ticking for a dialog that is gone.
    connect.offer().then(
      (offer) => {
        if (!done) show(offer);
      },
      (e: unknown) => {
        if (!done && (!(e instanceof ConnectFailed) || e.reason !== "cancelled")) failed();
      },
    );
  });
}
