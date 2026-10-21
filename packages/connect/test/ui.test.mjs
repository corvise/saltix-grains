// The button standard (Saltix 19-connect §13) and the dialog: their markup and classes in a DOM that refuses inline
// styles, the words in both languages, and the stylesheet's numbers (navy and white, at least 44 px, a quarter-height
// radius).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUTTON_CLASSES, DIALOG_CLASSES, MARK_PATH, WORDS, openConnectDialog, signInButton } from "../dist/index.js";
import { FakeDocument, flush } from "./helpers.mjs";

const css = readFileSync(new URL("../dist/connect.css", import.meta.url), "utf8");
const rule = (selector) => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `connect.css has ${selector}`);
  return m[1];
};

test("the button: the mark at its left, the words, navy on a light page and white on a dark one, classes only", () => {
  const doc = new FakeDocument();
  const host = doc.createElement("div");
  let clicks = 0;
  const button = signInButton(host, { onClick: () => clicks++ });
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.parent, host);
  assert.equal(button.getAttribute("type"), "button");
  assert.deepEqual(button.className.split(" ").sort(), [BUTTON_CLASSES.button, BUTTON_CLASSES.navy].sort());
  assert.equal(button.children.length, 2);
  const [mark, label] = button.children;
  assert.equal(mark.tagName, "svg");
  assert.equal(mark.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(mark.getAttribute("class"), BUTTON_CLASSES.mark);
  assert.equal(mark.getAttribute("aria-hidden"), "true");
  assert.equal(mark.children[1].getAttribute("d"), MARK_PATH);
  assert.equal(label.className, BUTTON_CLASSES.label);
  assert.equal(label.textContent, "Sign in with Saltix");
  assert.equal(button.textContent, "Sign in with Saltix", "the mark adds no text");
  button.click();
  assert.equal(clicks, 1);

  // A button of the page's own is decorated in place; a dark page gets the white one; Russian words.
  const own = doc.createElement("button");
  own.className = `${BUTTON_CLASSES.navy} page-class`;
  assert.equal(signInButton(own, { lang: "ru", theme: "dark" }), own);
  assert.ok(own.classList.contains(BUTTON_CLASSES.white) && !own.classList.contains(BUTTON_CLASSES.navy));
  assert.equal(own.textContent, "Войти через Saltix");
  assert.equal(own.getAttribute("lang"), "ru");
  assert.equal(own.getAttribute("type"), null, "the page's own button keeps its type");
});

test("connect.css draws the standard: navy #0B1220 and white, at least 44 px, corners a quarter of the height", () => {
  const base = rule(".saltix-signin");
  assert.match(base, /--saltix-signin-height:\s*44px/);
  assert.match(base, /--saltix-signin-h:\s*max\(44px, var\(--saltix-signin-height\)\)/);
  assert.match(base, /\n\s*height:\s*var\(--saltix-signin-h\)/);
  assert.match(base, /min-height:\s*44px/);
  assert.match(base, /border-radius:\s*calc\(var\(--saltix-signin-h\) \/ 4\)/);
  assert.match(rule(".saltix-signin--navy"), /background:\s*#0b1220;\s*color:\s*#ffffff/i);
  assert.match(rule(".saltix-signin--white"), /background:\s*#ffffff;\s*color:\s*#0b1220/i);
  for (const name of [...Object.values(BUTTON_CLASSES), ...Object.values(DIALOG_CLASSES)]) {
    assert.ok(css.includes(`.${name}`), `connect.css styles .${name}`);
  }
  // Nothing in it reaches outside its own classes.
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}]+)\{/g)) {
    for (const selector of m[2].split(",")) assert.match(selector.trim(), /^\.saltix-/, selector.trim());
  }
});

test("the words are the standard's, in English and Russian", () => {
  assert.equal(WORDS.en.signIn, "Sign in with Saltix");
  assert.equal(WORDS.ru.signIn, "Войти через Saltix");
  assert.equal(WORDS.en.title, "Saltix Connect");
  assert.equal(WORDS.en.scan, "Scan with Saltix to sign in");
  assert.equal(WORDS.en.open, "Open Saltix");
  assert.deepEqual(Object.keys(WORDS.ru).sort(), Object.keys(WORDS.en).sort());
});

/** A session the dialog follows: events the test fires, an offer it gives. */
function fakeConnect(offer) {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    fire(event, data) {
      for (const h of handlers.get(event) ?? []) h(data);
    },
    on(event, h) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((x) => x !== h));
    },
    offer: async () => {
      calls.push("offer");
      return offer;
    },
    renew: async () => {
      calls.push("renew");
      return offer;
    },
    cancel: () => calls.push("cancel"),
    handOff: () => calls.push("handOff"),
  };
}

const OFFER = {
  text: "saltix-connect:1:x",
  link: "https://saltix.io/connect#saltix-connect:1:x",
  app: "intent:1:x#Intent;scheme=saltix-connect;package=io.saltix.app;S.browser_fallback_url=https%3A%2F%2Fsaltix.io%2Fconnect%23saltix-connect%3A1%3Ax;end",
  qr: { size: 33, path: "M4 4h7v1h-7z", svg: "" },
  expiresAt: 0,
};

test("the dialog: Saltix Connect, the QR code, its words; on a phone Open Saltix; it follows the session", async () => {
  const doc = new FakeDocument(true);
  const connect = fakeConnect(OFFER);
  const result = openConnectDialog(connect, { document: doc });
  await flush();
  const dialog = doc.body.children[0];
  assert.ok(dialog.classList.contains(DIALOG_CLASSES.dialog));
  assert.equal(dialog.open, true, "shown modal");
  assert.equal(dialog.find(DIALOG_CLASSES.title).textContent, "Saltix Connect");
  assert.equal(dialog.find(DIALOG_CLASSES.scan).textContent, "Scan with Saltix to sign in");
  const qr = dialog.find(DIALOG_CLASSES.qr);
  assert.equal(qr.getAttribute("viewBox"), "0 0 33 33");
  assert.equal(qr.find(DIALOG_CLASSES.qrDark).getAttribute("d"), OFFER.qr.path);
  const open = dialog.find(DIALOG_CLASSES.open);
  assert.equal(open.hidden, false, "a phone shows Open Saltix");
  assert.equal(open.getAttribute("href"), OFFER.app, "the link that opens Saltix without unloading the page (19-connect §14.1)");
  assert.equal(open.getAttribute("rel"), "noopener noreferrer");
  assert.equal(open.getAttribute("target"), null, "never a new tab: the visitor would come back to a page still offering a consumed offer");
  open.click();
  assert.deepEqual(connect.calls, ["offer", "handOff"]);
  const status = dialog.find(DIALOG_CLASSES.status);
  assert.equal(status.hidden, true);
  connect.fire("seen", OFFER);
  assert.equal(status.textContent, WORDS.en.seen);
  connect.fire("refused", { reason: "time" });
  assert.match(status.textContent, /\(time\)/);
  connect.fire("refused", { reason: "unchecked" });
  assert.equal(status.textContent, WORDS.en.unchecked);
  const connection = { account: "11".repeat(32) };
  connect.fire("connected", connection);
  assert.equal(await result, connection);
  assert.equal(doc.body.children.length, 0, "the dialog is gone");
  assert.ok(!connect.calls.includes("cancel"), "a connected session is not cancelled");
});

test("the dialog on a computer has no Open Saltix; closing it cancels the session; a failure offers to try again", async () => {
  const doc = new FakeDocument(false);
  const connect = fakeConnect(OFFER);
  const result = openConnectDialog(connect, { document: doc, lang: "ru", theme: "dark" });
  await flush();
  const dialog = doc.body.children[0];
  assert.ok(dialog.classList.contains(DIALOG_CLASSES.dark));
  assert.equal(dialog.find(DIALOG_CLASSES.open).hidden, true);
  assert.equal(dialog.find(DIALOG_CLASSES.scan).textContent, WORDS.ru.scan);
  connect.fire("failed", { reason: "no_relay" });
  const action = dialog.find(DIALOG_CLASSES.action);
  assert.equal(action.textContent, WORDS.ru.retry);
  assert.equal(dialog.find(DIALOG_CLASSES.status).textContent, WORDS.ru.failed);
  action.click();
  assert.ok(connect.calls.includes("renew"));
  dialog.find(DIALOG_CLASSES.close).click();
  assert.equal(await result, null);
  assert.ok(connect.calls.includes("cancel"));
  assert.equal(doc.body.children.length, 0);
  // Escape closes it the same way.
  const again = openConnectDialog(connect, { document: doc });
  await flush();
  doc.body.children[0].dispatch("cancel");
  assert.equal(await again, null);
});
