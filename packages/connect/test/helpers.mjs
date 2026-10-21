// What the tests share: a clock the test moves, a relay the test drives, and a minimal DOM for the button and the dialog.
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { b64url } from "../dist/index.js";

/** Let promises and queued microtasks run. */
export async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Timers the test runs by moving the clock: nothing waits for real time, and nothing is left running. */
export class Clock {
  now = 1_700_000_000_000;
  timers = new Map();
  next = 0;
  setTimeout = (f, ms) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + ms, f });
    return id;
  };
  clearTimeout = (id) => {
    this.timers.delete(id);
  };
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      await flush();
      let due = null;
      for (const [id, t] of this.timers) if (t.at <= end && (due === null || t.at < due[1].at)) due = [id, t];
      if (due === null) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].f();
    }
    this.now = end;
    await flush();
  }
}

/** A relay the test drives: what the page sends, and frames and closes the test makes happen. */
export class FakeLink {
  sent = [];
  closed = false;
  onFrame = () => {};
  onClose = () => {};
  constructor(relay, network, answer) {
    this.relay = relay;
    this.network = network;
    this.answer = answer;
  }
  send(frame) {
    if (this.closed) return false;
    this.sent.push(frame);
    const reply = this.answer(frame);
    if (reply) {
      const { then, ...first } = reply;
      queueMicrotask(() => {
        this.onFrame(first);
        for (const f of then ?? []) this.onFrame(f);
      });
    }
    return true;
  }
  close() {
    this.closed = true;
  }
  /** The relay drops the connection. */
  drop() {
    this.closed = true;
    this.onClose();
  }
  deliver(payload, sid) {
    this.onFrame({ type: "link_payload", sid, payload: b64url(payload) });
  }
}

export const RELAY_KEY = new Uint8Array(32).fill(0x35);

export const opened = (f, relay = RELAY_KEY) => (f.type === "link_open" ? { type: "link_opened", sid: f.sid, relay: b64url(relay) } : null);

/** Fresh session keys without Web Crypto. */
export async function keys() {
  const boxSecret = crypto.getRandomValues(new Uint8Array(32));
  return {
    sid: crypto.getRandomValues(new Uint8Array(32)),
    boxSecret,
    boxKey: x25519.getPublicKey(boxSecret),
    page: ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))),
    pageKey: null,
    webCrypto: false,
  };
}

/** `localStorage`'s three methods over a map. */
export class MemoryStorage {
  map = new Map();
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

// ── A minimal DOM: what the button and the dialog call, and nothing else ─────

class ClassList {
  constructor(el) {
    this.el = el;
  }
  get items() {
    return (this.el.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
  }
  add(...names) {
    this.el.attributes.set("class", [...new Set([...this.items, ...names])].join(" "));
  }
  remove(...names) {
    this.el.attributes.set("class", this.items.filter((n) => !names.includes(n)).join(" "));
  }
  contains(name) {
    return this.items.includes(name);
  }
}

export class FakeElement {
  attributes = new Map();
  children = [];
  parent = null;
  listeners = new Map();
  hidden = false;
  textValue = "";
  constructor(doc, tagName, namespace = null) {
    this.ownerDocument = doc;
    this.tagName = namespace ? tagName : tagName.toUpperCase();
    this.namespaceURI = namespace;
    this.classList = new ClassList(this);
  }
  get className() {
    return this.attributes.get("class") ?? "";
  }
  set className(v) {
    this.attributes.set("class", v);
  }
  get style() {
    // A strict CSP refuses inline styles: touching `style` is a failure of the standard.
    throw new Error("an inline style was set");
  }
  setAttribute(k, v) {
    if (k === "style") throw new Error("an inline style was set");
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  appendChild(child) {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...children) {
    for (const c of children) this.appendChild(c);
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
  }
  replaceChildren(...children) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    this.parent?.removeChild(this);
  }
  set textContent(v) {
    this.children = [];
    this.textValue = String(v);
  }
  get textContent() {
    return this.textValue + this.children.map((c) => c.textContent).join("");
  }
  addEventListener(type, f) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  dispatch(type, event = {}) {
    for (const f of this.listeners.get(type) ?? []) f({ type, preventDefault() {}, ...event });
  }
  click() {
    this.dispatch("click");
  }
  /** Every element below, this one first. */
  *all() {
    yield this;
    for (const c of this.children) yield* c.all();
  }
  find(className) {
    for (const el of this.all()) if (el.classList.contains(className)) return el;
    return null;
  }
}

export class FakeDialog extends FakeElement {
  open = false;
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}

export class FakeDocument {
  constructor(coarse = false) {
    this.body = new FakeElement(this, "body");
    this.defaultView = { matchMedia: (q) => ({ matches: q === "(pointer: coarse)" && coarse }) };
  }
  createElement(tag) {
    return tag === "dialog" ? new FakeDialog(this, tag) : new FakeElement(this, tag);
  }
  createElementNS(ns, tag) {
    return new FakeElement(this, tag, ns);
  }
}
