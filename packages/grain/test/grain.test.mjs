// The bridge as a wallet answers it: a fake `window.saltix` records what the SDK sends.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  grain, inWallet, walletLink, slugLink, chatLink, GrainError, ErrorCode, MAX_RELAY_PAYLOAD, _reset, layoutOf, cssVariables, controlsFor,
  CONTROLS_BOX, LAYOUT_VARIABLES, BAND, viewportFitCover, viewportOf, frameFor, cornerDepth, COVER_GUIDANCE, pageColorOf, frameColors, layoutCss,
} from "../dist/index.js";

function wallet(answer) {
  const sent = [];
  globalThis.saltix = {
    isGrain: true,
    request: async (args) => { sent.push(args); return answer(args); },
    on: (e, h) => sent.push({ on: e }),
  };
  _reset();
  return sent;
}

test("outside a wallet nothing is asked, and the link opens the grain in one", async () => {
  delete globalThis.saltix;
  _reset();
  assert.equal(inWallet(), false);
  await assert.rejects(grain.info(), (e) => e instanceof GrainError && e.code === ErrorCode.NoWallet);
  assert.equal(walletLink("https://chess.example/.well-known/saltix-grain", "room-7"),
    "salt:grain?manifest=https%3A%2F%2Fchess.example%2F.well-known%2Fsaltix-grain&start=room-7");
  assert.throws(() => walletLink("https://a.example/m", "a b"), GrainError);
  assert.equal(slugLink("chess"), "salt:grain/chess");
  assert.equal(slugLink("chess", "room-7"), "salt:grain/chess?start=room-7");
  for (const bad of ["Chess", "go", "-chess", "a".repeat(33)]) assert.throws(() => slugLink(bad), GrainError, bad);
  assert.throws(() => slugLink("chess", "a b"), GrainError);
});

test("methods and parameters are the wallet's", async () => {
  const sent = wallet(({ method }) => ({
    grain_login: { key: "aa", signature: "bb", at: 1, origin: "https://chess.example" },
    grain_storage_get: { value: "1640" },
    grain_storage_keys: { keys: ["rating"] },
    grain_requestAddress: { address: "dsalt1q..." },
    grain_scanQr: { text: "hello" },
  })[method] ?? null);
  assert.equal(inWallet(), true);
  await grain.login(new Uint8Array([10, 11, 255]));
  await grain.login("ABCD");
  assert.equal(await grain.storage.get("rating"), "1640");
  assert.deepEqual(await grain.storage.keys(), ["rating"]);
  assert.equal(await grain.requestAddress(), "dsalt1q...");
  assert.equal(await grain.scanQr(), "hello");
  await grain.pay({ invoice: "00ff" });
  await grain.setHeader("#112233");
  grain.on("theme", () => {});
  assert.deepEqual(sent.slice(0, 2), [
    { method: "grain_login", params: { challenge: "0a0bff" } },
    { method: "grain_login", params: { challenge: "abcd" } },
  ]);
  assert.deepEqual(sent[6], { method: "grain_pay", params: { invoice: "00ff" } });
  assert.deepEqual(sent[7], { method: "grain_setHeader", params: { color: "#112233" } });
  assert.deepEqual(sent[8], { on: "theme" });
});

test("the wallet's refusals arrive with their code", async () => {
  wallet(() => { const e = new Error("the user declined"); e.code = 4001; throw e; });
  await assert.rejects(grain.pay({ to: "dsalt1q", amount: "1" }), (e) => e instanceof GrainError && e.code === ErrorCode.UserRejected);
  wallet(() => { throw new Error("boom"); });
  await assert.rejects(grain.ready(), (e) => e.code === ErrorCode.Failed && e.message === "boom");
});

test("ready() tells the wallet the first screen is drawn and holds nothing: Saltix's splash goes when the page loads", async () => {
  const sent = wallet(() => null);
  assert.equal(await grain.ready(), null);
  assert.deepEqual(sent, [{ method: "grain_ready", params: {} }], "grain_ready, with nothing else");
  delete globalThis.saltix;
  _reset();
  await assert.rejects(grain.ready(), (e) => e instanceof GrainError && e.code === ErrorCode.NoWallet, "outside a wallet");
  // What the page's developer reads says what Saltix does (12-grains §7: its splash shows while the page loads; Saltix
  // ignores grain_ready): never that the call hides the splash, nor that the wallet waits for it.
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const doc = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*ready:/.exec(source)?.[1] ?? "";
  assert.match(doc, /ignores/, "ready()'s doc says Saltix ignores it");
  assert.match(doc, /while the page loads/);
  assert.doesNotMatch(doc, /hides its splash/);
});

test("relay frames go out as hex and come back as bytes; notifications are asked", async () => {
  const handlers = new Map();
  const sent = [];
  globalThis.saltix = {
    isGrain: true,
    request: async (args) => {
      sent.push(args);
      return { grain_relay_open: { address: "dsalt1qalias" }, grain_notifications_allow: { allowed: true } }[args.method] ?? null;
    },
    on: (e, h) => handlers.set(h, e),
    off: (e, h) => handlers.delete(h),
  };
  _reset();
  assert.equal(await grain.relay.open(), "dsalt1qalias");
  await grain.relay.open({ grant: "ABCD" });
  assert.deepEqual(sent.splice(0, 2).map((r) => r.params), [{}, { grant: "abcd" }]);
  await grain.relay.send("dsalt1qpeer", new Uint8Array([1, 2, 255]), { keep: true });
  await grain.relay.send("dsalt1qpeer", new Uint8Array(MAX_RELAY_PAYLOAD));
  assert.deepEqual(sent[0], { method: "grain_relay_send", params: { to: "dsalt1qpeer", payload: "0102ff", keep: true } });
  assert.equal(sent[1].params.keep, false, "live unless kept");
  for (const bad of [new Uint8Array(0), new Uint8Array(MAX_RELAY_PAYLOAD + 1)]) {
    await assert.rejects(grain.relay.send("dsalt1qpeer", bad), (e) => e.code === ErrorCode.InvalidParams);
  }
  assert.equal(sent.length, 2, "a refused frame is not sent");

  const frames = [];
  const stop = grain.relay.onFrame((from, payload) => frames.push([from, [...payload]]));
  const [[wrapped, event]] = handlers;
  assert.equal(event, "relay");
  wrapped({ from: "dsalt1qpeer", payload: "0aff" });
  assert.deepEqual(frames, [["dsalt1qpeer", [10, 255]]]);
  stop();
  assert.equal(handlers.size, 0, "stopped listening");

  assert.equal(await grain.notifications.allow(), true);
  await grain.relay.close();
  assert.deepEqual(sent.slice(2).map((r) => r.method), ["grain_notifications_allow", "grain_relay_close"]);
});

test("the app's own manage page opens from the page, at its members", async () => {
  const sent = wallet(() => null);
  await grain.manage.open();
  await grain.manage.open({ section: "members" });
  assert.deepEqual(sent, [
    { method: "grain_manage_open", params: {} },
    { method: "grain_manage_open", params: { section: "members" } },
  ]);
  await assert.rejects(grain.manage.open({ section: "keys" }), (e) => e.code === ErrorCode.InvalidParams);
  assert.equal(sent.length, 2, "a refused call is not sent");
  wallet(() => { const e = new Error("not on the app's team"); e.code = 4100; throw e; });
  await assert.rejects(grain.manage.open({ section: "members" }), (e) => e instanceof GrainError && e.code === ErrorCode.NotPermitted);
});

test("the chat opens from the page and from a link", async () => {
  const sent = wallet(() => null);
  await grain.chat.open();
  await grain.chat.open({ cert: "0A0B", spec: "ff" });
  assert.deepEqual(sent, [
    { method: "grain_chat_open", params: {} },
    { method: "grain_chat_open", params: { cert: "0a0b", spec: "ff" } },
  ]);
  await assert.rejects(grain.chat.open({ cert: "xyz" }), (e) => e.code === ErrorCode.InvalidParams);
  assert.equal(sent.length, 2, "a refused call is not sent");
  assert.equal(chatLink("access"), "salt:grain/access?chat");
  // Base64url of the certificate's Borsh, without padding.
  assert.equal(chatLink("access", "fbff00"), "salt:grain/access?chat&cert=-_8A");
  assert.throws(() => chatLink("Access"), GrainError);
  assert.throws(() => chatLink("access", "abc"), GrainError);
});

/** The declarations of a `:root{…}` rule, by name (every rule here is `:root`'s, so they compare by order alone). */
function declarations(text) {
  const out = new Map();
  for (const [, body] of String(text).matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const d of body.split(";")) {
      const at = d.indexOf(":");
      if (at > 0) out.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
    }
  }
  return out;
}

/**
 * A document as far as `:root`'s CSS variables go, and a window whose resizes the test fires. Its `vars` are the values
 * the cascade gives (CSS Cascading 4 §6, CSSOM §6.2): `:root`'s inline style first, then the adopted sheets, the last
 * winning, then the document's own `<style>` elements, the last winning. Saltix's frame script keeps its values in an
 * adopted sheet at the end of the list (12-grains §5: they win over the page's own stylesheets). `adopt: false` is a
 * browser without constructable sheets.
 */
function screen({ adopt = true } = {}) {
  const inline = new Map();
  const styles = [];
  const resize = new Set();
  class Sheet {
    constructor() { this.rules = new Map(); }
    replaceSync(text) { this.rules = declarations(text); }
  }
  const element = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), attributes: {}, textContent: "",
      setAttribute(name, value) { this.attributes[name] = String(value); },
      remove() { const i = styles.indexOf(el); if (i >= 0) styles.splice(i, 1); },
    };
    return el;
  };
  const doc = {
    documentElement: {
      style: {
        setProperty: (name, value) => inline.set(name, value),
        removeProperty: (name) => inline.delete(name),
        getPropertyValue: (name) => inline.get(name) ?? "",
      },
    },
    head: { appendChild: (el) => { styles.push(el); return el; } },
    createElement: element,
  };
  if (adopt) {
    doc.adoptedStyleSheets = [];
    globalThis.CSSStyleSheet = Sheet;
  }
  globalThis.document = doc;
  globalThis.addEventListener = (type, h) => type === "resize" && resize.add(h);
  globalThis.removeEventListener = (type, h) => type === "resize" && resize.delete(h);
  const computed = (name) => {
    if (inline.has(name)) return inline.get(name);
    for (const sheet of [...(doc.adoptedStyleSheets ?? [])].reverse()) if (sheet.rules.has(name)) return sheet.rules.get(name);
    for (const el of [...styles].reverse()) {
      const found = declarations(el.textContent);
      if (found.has(name)) return found.get(name);
    }
    return undefined;
  };
  return {
    doc, inline, styles,
    vars: new Proxy({}, { get: (_, name) => computed(name) }),
    /** The page's own stylesheet in its head, as `grain init`'s index.html has it. */
    pageStyle(text) {
      const el = element("style");
      el.textContent = text;
      styles.push(el);
      return el;
    },
    /** Saltix's frame script (saltix-wallet assets/grain/frame.js): its sheet adopted at the end of the list from the
     *  document's start, its values replaced from every `insets` event. */
    walletFrame(values) {
      const sheet = new Sheet();
      const write = ({ safe_area: s, controls }) => {
        const c = controls ?? { top: 0, right: 0, width: 0, height: 0 };
        sheet.replaceSync(`:root{--saltix-safe-top:${s.top}px;--saltix-safe-right:${s.right}px;--saltix-safe-bottom:${s.bottom}px;` +
          `--saltix-safe-left:${s.left}px;--saltix-controls-top:${c.top}px;--saltix-controls-right:${c.right}px;` +
          `--saltix-controls-width:${c.width}px;--saltix-controls-height:${c.height}px}`);
        if (!doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      };
      write(values);
      return { sheet, update: write };
    },
    resize: () => [...resize].forEach((h) => h()),
    listening: () => resize.size,
    restore() {
      delete globalThis.document;
      delete globalThis.CSSStyleSheet;
      delete globalThis.addEventListener;
      delete globalThis.removeEventListener;
    },
  };
}

/** A Saltix of `bridge` whose `grain_info` answers `info()` (asked each time), whose events the test fires. */
function saltix(bridge, info = () => ({})) {
  const handlers = new Map();
  const asked = [];
  globalThis.saltix = {
    isGrain: true,
    request: async (args) => {
      asked.push(args.method);
      if (args.method !== "grain_info") return null;
      return { slug: "dice", bridge, theme: "dark", safe_area: { top: 0, bottom: 0 }, ...info() };
    },
    on: (e, h) => handlers.set(h, e),
    off: (e, h) => handlers.delete(h),
  };
  _reset();
  return {
    asked,
    fire: (event, data) => [...handlers].filter(([, e]) => e === event).forEach(([h]) => h(data)),
    listening: () => handlers.size,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const SAFE = { top: 32, bottom: 24, left: 0, right: 0 };

test("the layout's fallbacks are decided in one place", () => {
  assert.deepEqual(CONTROLS_BOX, { width: 96, height: 48, right: 8, below: 4 }, "12-grains §11");
  assert.deepEqual(controlsFor(SAFE), { top: 36, right: 8, width: 96, height: 48 });
  assert.deepEqual(controlsFor({ top: 24, bottom: 0, left: 30, right: 44 }), { top: 28, right: 52, width: 96, height: 48 }, "from the insets");
  // Saltix with bridge 3: its values, a field it does not give as 0, controls absent as none.
  assert.deepEqual(layoutOf({ bridge: 3, safe_area: SAFE, controls: controlsFor(SAFE) }), { safeArea: SAFE, controls: { top: 36, right: 8, width: 96, height: 48 }, source: "wallet" });
  assert.deepEqual(layoutOf({ bridge: 4, safe_area: { top: 24 }, controls: { top: 28, width: 96 } }), {
    safeArea: { top: 24, bottom: 0, left: 0, right: 0 }, controls: { top: 28, right: 0, width: 96, height: 0 }, source: "wallet",
  });
  assert.deepEqual(layoutOf({ bridge: 3, safe_area: { top: -5, bottom: "7", left: NaN, right: Infinity } }), {
    safeArea: { top: 0, bottom: 0, left: 0, right: 0 }, controls: null, source: "wallet",
  }, "what is not a length is 0");
  // Saltix with bridge 1 or 2: its header above the page; nothing of the page is under the bars.
  for (const bridge of [1, 2, undefined]) {
    assert.deepEqual(layoutOf({ bridge, safe_area: { top: 24, bottom: 16 }, controls: { top: 1, right: 1, width: 1, height: 1 } }), {
      safeArea: { top: 0, bottom: 0, left: 0, right: 0 }, controls: null, source: "legacy",
    }, `bridge ${bridge}`);
  }
  // No wallet: the browser's own insets, no controls.
  assert.deepEqual(layoutOf(null), { safeArea: { top: 0, bottom: 0, left: 0, right: 0 }, controls: null, source: "browser" });
  assert.deepEqual(layoutOf(null, { top: 47, bottom: 34, left: 0, right: 0 }).safeArea, { top: 47, bottom: 34, left: 0, right: 0 });

  const v = LAYOUT_VARIABLES;
  assert.deepEqual(cssVariables(layoutOf({ bridge: 3, safe_area: SAFE, controls: controlsFor(SAFE) })), {
    [v.safeTop]: "32px", [v.safeBottom]: "24px", [v.safeLeft]: "0px", [v.safeRight]: "0px",
    [v.controlsTop]: "36px", [v.controlsRight]: "8px", [v.controlsWidth]: "96px", [v.controlsHeight]: "48px",
  });
  const zero = { [v.controlsTop]: "0px", [v.controlsRight]: "0px", [v.controlsWidth]: "0px", [v.controlsHeight]: "0px" };
  assert.deepEqual(cssVariables(layoutOf({ bridge: 2 })), { [v.safeTop]: "0px", [v.safeBottom]: "0px", [v.safeLeft]: "0px", [v.safeRight]: "0px", ...zero });
  assert.deepEqual(cssVariables(layoutOf(null)), {
    [v.safeTop]: "env(safe-area-inset-top, 0px)", [v.safeBottom]: "env(safe-area-inset-bottom, 0px)",
    [v.safeLeft]: "env(safe-area-inset-left, 0px)", [v.safeRight]: "env(safe-area-inset-right, 0px)", ...zero,
  }, "a plain browser follows its own viewport");
  // As one `:root` rule, the form grain.layout()'s own stylesheet holds.
  assert.equal(layoutCss(layoutOf({ bridge: 3, safe_area: SAFE, controls: controlsFor(SAFE) })),
    ":root{--saltix-safe-top:32px;--saltix-safe-bottom:24px;--saltix-safe-left:0px;--saltix-safe-right:0px;" +
    "--saltix-controls-top:36px;--saltix-controls-right:8px;--saltix-controls-width:96px;--saltix-controls-height:48px}");
  assert.deepEqual(Object.keys(cssVariables(layoutOf(null))).sort(), [
    "--saltix-controls-height", "--saltix-controls-right", "--saltix-controls-top", "--saltix-controls-width",
    "--saltix-safe-bottom", "--saltix-safe-left", "--saltix-safe-right", "--saltix-safe-top",
  ]);
});

test("in Saltix bridge 3 the layout is the wallet's, set on :root and kept current", async () => {
  const s = screen();
  let insets = SAFE;
  const wallet = saltix(3, () => ({ safe_area: insets, controls: controlsFor(insets) }));
  const seen = [];
  try {
    const layout = await grain.layout((l) => seen.push(l));
    assert.deepEqual(layout.safeArea, SAFE);
    assert.deepEqual(layout.controls, { top: 36, right: 8, width: 96, height: 48 });
    assert.equal(layout.source, "wallet");
    assert.equal(s.vars["--saltix-safe-top"], "32px");
    assert.equal(s.vars["--saltix-safe-bottom"], "24px");
    assert.equal(s.vars["--saltix-controls-top"], "36px");
    assert.equal(s.vars["--saltix-controls-right"], "8px");
    assert.equal(s.vars["--saltix-controls-width"], "96px");
    assert.equal(s.vars["--saltix-controls-height"], "48px");
    assert.equal(seen.length, 1);

    // The phone unfolds: the wallet says so, and nothing is asked.
    const asked = wallet.asked.length;
    const unfolded = { top: 24, bottom: 16, left: 0, right: 40 };
    wallet.fire("insets", { safe_area: unfolded, controls: controlsFor(unfolded) });
    assert.deepEqual(layout.safeArea, unfolded, "the returned layout is current");
    assert.deepEqual(layout.controls, { top: 28, right: 48, width: 96, height: 48 });
    assert.equal(s.vars["--saltix-safe-right"], "40px");
    assert.equal(s.vars["--saltix-controls-right"], "48px");
    assert.equal(seen.length, 2);
    assert.equal(wallet.asked.length, asked);

    // A resize asks the wallet again; resizes by the dozen ask once more at most while one is answered.
    insets = { top: 30, bottom: 20, left: 12, right: 0 };
    for (let i = 0; i < 12; i++) s.resize();
    await settle();
    assert.ok(wallet.asked.length - asked <= 2 && wallet.asked.length > asked, `asked ${wallet.asked.length - asked} times`);
    assert.deepEqual(layout.safeArea, insets);
    assert.equal(s.vars["--saltix-safe-left"], "12px");
    assert.equal(s.vars["--saltix-controls-top"], "34px");
    // A theme change too.
    insets = { top: 28, bottom: 0, left: 0, right: 0 };
    wallet.fire("theme", { theme: "light" });
    await settle();
    assert.equal(layout.safeArea.top, 28);

    // An answer that started before a newer insets event does not undo it.
    insets = { top: 99, bottom: 0, left: 0, right: 0 };
    s.resize();
    wallet.fire("insets", { safe_area: { top: 50, bottom: 0, left: 0, right: 0 }, controls: controlsFor({ top: 50, bottom: 0, left: 0, right: 0 }) });
    await settle();
    assert.equal(layout.safeArea.top, 50);

    // Stopped: nothing follows any more.
    layout.stop();
    assert.equal(wallet.listening(), 0);
    assert.equal(s.listening(), 0);
    const n = seen.length;
    wallet.fire("insets", { safe_area: SAFE, controls: controlsFor(SAFE) });
    s.resize();
    await settle();
    assert.equal(seen.length, n);
    assert.equal(layout.safeArea.top, 50);
  } finally {
    s.restore();
    delete globalThis.saltix;
    _reset();
  }
});

test("an older Saltix and a plain browser fall back: zeros and no controls, or the browser's own insets", async () => {
  const s = screen();
  try {
    saltix(2, () => ({ safe_area: { top: 24, bottom: 0 } }));
    const legacy = await grain.layout();
    assert.deepEqual(legacy.safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
    assert.equal(legacy.controls, null);
    assert.equal(legacy.source, "legacy");
    assert.equal(s.vars["--saltix-safe-top"], "0px");
    assert.equal(s.vars["--saltix-controls-width"], "0px");
    legacy.stop();

    delete globalThis.saltix;
    _reset();
    const browser = await grain.layout();
    assert.equal(browser.source, "browser");
    assert.equal(browser.controls, null);
    assert.equal(s.vars["--saltix-safe-top"], "env(safe-area-inset-top, 0px)");
    assert.equal(s.vars["--saltix-safe-left"], "env(safe-area-inset-left, 0px)");
    assert.equal(s.vars["--saltix-controls-height"], "0px");
    s.resize();
    await settle();
    assert.equal(browser.source, "browser", "a resize measures again, and asks no wallet");
    browser.stop();
    assert.equal(s.listening(), 0);
  } finally {
    s.restore();
    delete globalThis.saltix;
    _reset();
  }
});

// The wallet sets the variables itself and keeps them current (12-grains §5); grain.layout() only fills in where it does
// not, below it in the cascade, and takes back what it set when stopped.
const UNFOLDED = { top: 24, bottom: 16, left: 0, right: 40 };
const TURNED = { top: 0, bottom: 0, left: 48, right: 0 };

test("where Saltix sets the variables, grain.layout() never overrides them, and stop() takes back only its own", async () => {
  const s = screen();
  try {
    // The page's own fallbacks for a plain browser, then Saltix's frame script, from the document's start.
    s.pageStyle(":root{--saltix-safe-top:env(safe-area-inset-top, 0px);--saltix-controls-width:0px}");
    const frame = s.walletFrame({ safe_area: UNFOLDED, controls: controlsFor(UNFOLDED) });
    // grain_info answers what it held a moment before (a fold in flight): the SDK's values are not the wallet's.
    const wallet = saltix(3, () => ({ safe_area: SAFE, controls: controlsFor(SAFE) }));
    const layout = await grain.layout();
    assert.deepEqual(layout.safeArea, SAFE, "the layout object is what grain_info said");
    for (const [name, value] of [["--saltix-safe-top", "24px"], ["--saltix-safe-right", "40px"], ["--saltix-safe-bottom", "16px"],
      ["--saltix-controls-top", "28px"], ["--saltix-controls-right", "48px"], ["--saltix-controls-width", "96px"]]) {
      assert.equal(s.vars[name], value, `${name}: the wallet's value wins`);
    }
    assert.equal(s.inline.size, 0, "nothing in :root's inline style, which would beat the wallet's");
    assert.equal(s.doc.adoptedStyleSheets.at(-1), frame.sheet, "the wallet's sheet stays last");
    assert.equal(s.doc.adoptedStyleSheets.length, 2, "the SDK's own sheet, below it");

    // An insets event: the frame script and grain.layout() each write theirs; the wallet's still decide.
    frame.update({ safe_area: TURNED, controls: controlsFor(TURNED) });
    wallet.fire("insets", { safe_area: SAFE, controls: controlsFor(SAFE) });
    assert.equal(s.vars["--saltix-safe-left"], "48px");
    assert.equal(s.vars["--saltix-safe-top"], "0px");
    // A page that replaced the list gets the SDK's sheet back with the next change, below the wallet's again.
    s.doc.adoptedStyleSheets = [frame.sheet];
    wallet.fire("insets", { safe_area: SAFE, controls: controlsFor(SAFE) });
    assert.equal(s.doc.adoptedStyleSheets.length, 2);
    assert.equal(s.doc.adoptedStyleSheets.at(-1), frame.sheet);
    assert.equal(s.vars["--saltix-safe-left"], "48px");

    // Stopped: the SDK's sheet is gone, the wallet's is untouched, and its later changes show.
    layout.stop();
    assert.deepEqual(s.doc.adoptedStyleSheets, [frame.sheet], "only the wallet's sheet is left");
    assert.equal(s.inline.size, 0);
    assert.equal(s.vars["--saltix-safe-left"], "48px");
    frame.update({ safe_area: UNFOLDED, controls: controlsFor(UNFOLDED) });
    assert.equal(s.vars["--saltix-safe-left"], "0px", "a later change of the wallet's is seen after stop()");
    assert.equal(s.vars["--saltix-safe-right"], "40px");
    assert.equal(s.vars["--saltix-controls-right"], "48px");
    wallet.fire("insets", { safe_area: SAFE, controls: controlsFor(SAFE) });
    assert.deepEqual(s.doc.adoptedStyleSheets, [frame.sheet], "a stopped layout writes nothing");
  } finally {
    s.restore();
    delete globalThis.saltix;
    _reset();
  }
});

test("where Saltix does not set them, grain.layout()'s values win over the page's fallbacks until stop() takes them back", async () => {
  const s = screen();
  try {
    // A web wallet, which cannot reach into the page's document: grain_info alone says the frame.
    s.pageStyle(":root{--saltix-safe-top:env(safe-area-inset-top, 0px);--saltix-controls-width:0px}");
    saltix(3, () => ({ safe_area: SAFE, controls: controlsFor(SAFE) }));
    const layout = await grain.layout();
    assert.equal(s.vars["--saltix-safe-top"], "32px", "over the page's own fallback");
    assert.equal(s.vars["--saltix-controls-width"], "96px");
    assert.equal(s.inline.size, 0);
    layout.stop();
    assert.deepEqual(s.doc.adoptedStyleSheets, []);
    assert.equal(s.vars["--saltix-safe-top"], "env(safe-area-inset-top, 0px)", "the page's own value again");
    assert.equal(s.vars["--saltix-controls-width"], "0px");
    assert.equal(s.vars["--saltix-safe-bottom"], undefined, "nothing of the SDK's is left");
  } finally {
    s.restore();
    delete globalThis.saltix;
    _reset();
  }
});

test("without constructable sheets grain.layout() writes a <style> of the page's own, and stop() removes it", async () => {
  const s = screen({ adopt: false });
  try {
    const own = s.pageStyle(":root{--saltix-safe-top:env(safe-area-inset-top, 0px)}");
    saltix(3, () => ({ safe_area: SAFE, controls: controlsFor(SAFE) }));
    const layout = await grain.layout();
    assert.equal(s.inline.size, 0, "never the inline style");
    assert.equal(s.styles.length, 2);
    assert.equal(s.styles.at(-1).attributes["data-saltix-layout"], "", "marked as the SDK's");
    assert.equal(s.vars["--saltix-safe-top"], "32px");
    layout.stop();
    assert.deepEqual(s.styles, [own], "the page's own stylesheet alone is left");
    assert.equal(s.vars["--saltix-safe-top"], "env(safe-area-inset-top, 0px)");
  } finally {
    s.restore();
    delete globalThis.saltix;
    _reset();
  }
  // A browser whose constructed sheets fail here: the <style> from then on, never both.
  const t = screen();
  try {
    globalThis.CSSStyleSheet = class { replaceSync() { throw new Error("NotAllowedError"); } };
    const wallet = saltix(3, () => ({ safe_area: SAFE, controls: controlsFor(SAFE) }));
    const layout = await grain.layout();
    wallet.fire("insets", { safe_area: UNFOLDED, controls: controlsFor(UNFOLDED) });
    assert.deepEqual(t.doc.adoptedStyleSheets, []);
    assert.equal(t.styles.length, 1, "one <style>");
    assert.equal(t.vars["--saltix-safe-right"], "40px", "kept current");
    layout.stop();
    assert.deepEqual(t.styles, []);
  } finally {
    t.restore();
    delete globalThis.saltix;
    _reset();
  }
});

// ── the page's frame (12-grains §7): safe by default, edge to edge with viewport-fit=cover ──

// The same cases as Saltix's own reading (saltix-wallet PageFrameTest): a page declares edge to edge, or it does not.
const COVER = [
  "width=device-width, initial-scale=1, viewport-fit=cover", "viewport-fit=cover", "width=device-width,viewport-fit=cover",
  "width=device-width; initial-scale=1; viewport-fit=cover;", "width=device-width initial-scale=1 viewport-fit=cover",
  "viewport-fit = cover", "VIEWPORT-FIT=COVER", "Viewport-Fit=Cover, width=device-width", "\tviewport-fit=cover\n",
  "viewport-fit=auto, viewport-fit=cover",
];
const SAFE_AREA_ONLY = [
  null, undefined, "", "width=device-width, initial-scale=1", "viewport-fit=auto", "viewport-fit=contain", "viewport-fit=",
  "viewport-fit", "viewport-fit=cover, viewport-fit=auto", "xviewport-fit=cover", "viewport-fit=covered", "viewport-fit=cove",
  "viewport-fit:cover", "viewport-fitcover", 'viewport-fit="cover"', "viewport_fit=cover", "fit=cover", "width=cover",
  "vıewport-fıt=cover", "VıEWPORT-FıT=COVER",
];

test("only viewport-fit=cover draws a page edge to edge, read as Saltix reads it", () => {
  for (const c of COVER) assert.equal(viewportFitCover(c), true, JSON.stringify(c));
  for (const c of SAFE_AREA_ONLY) assert.equal(viewportFitCover(c), false, JSON.stringify(c));
  // The document's last viewport meta is the one; none is null.
  const doc = (...contents) => ({ querySelectorAll: () => contents.map((c) => ({ getAttribute: () => c })) });
  assert.equal(viewportOf(doc("width=device-width", "viewport-fit=cover")), "viewport-fit=cover");
  assert.equal(viewportOf(doc()), null);
  assert.equal(viewportOf(doc(null)), "");
  assert.equal(viewportOf(undefined), null);
});

test("the frame a wallet gives a page: inside the safe area below the band, or edge to edge with the insets", () => {
  assert.equal(BAND, 56);
  const bars = { top: 32, bottom: 24, left: 0, right: 0 };
  const safe = frameFor({ bars }, false);
  assert.deepEqual(safe, {
    cover: false, view: { top: 88, bottom: 24, left: 0, right: 0 }, safe_area: { top: 0, bottom: 0, left: 0, right: 0 },
    controls: null, capsule: { top: 36, right: 8, width: 96, height: 48 },
  });
  const cover = frameFor({ bars }, true);
  assert.deepEqual(cover, {
    cover: true, view: { top: 0, bottom: 0, left: 0, right: 0 }, safe_area: bars,
    controls: { top: 36, right: 8, width: 96, height: 48 }, capsule: { top: 36, right: 8, width: 96, height: 48 },
  });
  // The controls at one place in both, clear of a cutout on the left and buttons on the right.
  const side = { bars: { top: 24, bottom: 0, left: 32, right: 48 } };
  assert.deepEqual(frameFor(side, false).capsule, frameFor(side, true).controls);
  assert.deepEqual(frameFor(side, false).view, { top: 80, bottom: 0, left: 32, right: 48 });
  // A keyboard: the view ends above it; what the bar reaches beyond it is all the page is told.
  assert.equal(frameFor({ bars, keyboard: 300 }, false).view.bottom, 300);
  assert.equal(frameFor({ bars, keyboard: 300 }, true).view.bottom, 300);
  assert.equal(frameFor({ bars, keyboard: 300 }, true).safe_area.bottom, 0);
  assert.equal(frameFor({ bars, keyboard: 10 }, true).safe_area.bottom, 14);
  // Rounded corners: no deeper than their arcs at 45°; the bars win when deeper; garbage is none.
  assert.deepEqual([cornerDepth(0), cornerDepth(10), cornerDepth(45), cornerDepth(55), cornerDepth(-1)], [0, 3, 14, 17, 0]);
  const iphone = frameFor({ bars: { top: 59, bottom: 0, left: 0, right: 0 }, cornerTop: 55, cornerBottom: 55 }, true);
  assert.deepEqual(iphone.safe_area, { top: 59, bottom: 17, left: 0, right: 0 });
  assert.deepEqual(frameFor({ bars: { top: NaN, bottom: -3, left: "x", right: Infinity }, keyboard: -9 }, true).safe_area,
    { top: 0, bottom: 0, left: 0, right: 0 });
  // What a page inside the safe area is told is what layoutOf reads: zeros and no controls.
  assert.deepEqual(layoutOf({ bridge: 3, safe_area: safe.safe_area, controls: safe.controls }),
    { safeArea: { top: 0, bottom: 0, left: 0, right: 0 }, controls: null, source: "wallet" });
});

// ── the colours around the page (12-grains §7), as Saltix reads and draws them (saltix-wallet frame.js, AppFrame) ──

/** A CSS colour as a browser's canvas normalises it, for the forms these tests use: `#rgb`, `#rrggbb` and `rgb[a](…)`;
 *  `#rrggbb` when it is opaque, else null. */
function opaque(css) {
  const t = css.trim().toLowerCase();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  if (!m || (m[4] !== undefined && Number(m[4]) < 1)) return null;
  return "#" + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
}

/** What Saltix reads of a page: no theme-color, a transparent body and root, no colour scheme, unless `over` says. */
const look = (over = {}) => ({
  themeColors: [], body: true, bodyBackground: "rgba(0, 0, 0, 0)", rootBackground: "rgba(0, 0, 0, 0)", colorScheme: "normal",
  prefersDark: false, ...over,
});
const meta = (content, matches = true) => ({ content, matches });

test("the page's colour is its theme-color, else its background, read in Saltix's order", () => {
  // The first theme-color whose media matches and which is a valid, opaque colour; normalised as a browser does.
  assert.equal(pageColorOf(look({ themeColors: [meta("#2F6BFF")], bodyBackground: "rgb(255, 0, 0)" }), opaque), "#2f6bff");
  assert.equal(pageColorOf(look({ themeColors: [meta("#0b1020", false), meta("#f4f6fb")] }), opaque), "#f4f6fb", "a media that does not match is passed over");
  assert.equal(pageColorOf(look({ themeColors: [meta("#0b1020", false), meta("#f4f6fb", true), meta("#000000")] }), opaque), "#f4f6fb", "the first that matches");
  assert.equal(pageColorOf(look({ themeColors: [meta("not a colour"), meta("rgba(0, 0, 0, 0.5)"), meta(null), meta("#abc")] }), opaque), "#aabbcc",
    "an invalid, a translucent or an empty one is passed over, and any CSS colour is taken");
  // Else the body's background, then the root's: opaque only.
  assert.equal(pageColorOf(look({ bodyBackground: "rgb(1, 2, 3)", rootBackground: "rgb(4, 5, 6)" }), opaque), "#010203");
  assert.equal(pageColorOf(look({ themeColors: [meta("#ff0000", false)], bodyBackground: "rgba(1, 2, 3, 0.5)", rootBackground: "rgb(4, 5, 6)" }), opaque), "#040506");
  // Else the canvas it is drawn on: dark for a dark colour scheme (or a light and dark one, read dark), else white.
  assert.equal(pageColorOf(look(), opaque), "#ffffff");
  assert.equal(pageColorOf(look({ colorScheme: "dark" }), opaque), "#121212");
  assert.equal(pageColorOf(look({ colorScheme: "light dark" }), opaque), "#ffffff");
  assert.equal(pageColorOf(look({ colorScheme: "light dark", prefersDark: true }), opaque), "#121212");
  assert.equal(pageColorOf(look({ colorScheme: "light", prefersDark: true }), opaque), "#ffffff");
  // Before the body starts there is nothing to tell but a theme-color.
  assert.equal(pageColorOf(look({ body: false, bodyBackground: null, rootBackground: "rgb(4, 5, 6)" }), opaque), null);
  assert.equal(pageColorOf(look({ body: false, themeColors: [meta("#123456")] }), opaque), "#123456");
});

test("the band takes setHeader's colour, else the page's; the margins the page's; the icons contrast with them", () => {
  const blue = "#2f6bff";
  const white = "#ffffff";
  const navy = "#0b1020";
  // Nothing known yet: the wallet's own background, the icons by the theme.
  assert.deepEqual(frameColors(null, null), { band: null, around: null, topDark: null, bottomDark: null });
  assert.deepEqual(frameColors(null, white), { band: white, around: white, topDark: false, bottomDark: false });
  assert.deepEqual(frameColors(blue, white), { band: blue, around: white, topDark: true, bottomDark: false });
  assert.deepEqual(frameColors(blue, null), { band: blue, around: null, topDark: true, bottomDark: null });
  // Dark or light as Android's Color.luminance() decides it: sRGB decoded, below one half is dark.
  assert.equal(frameColors("#a0a0a0", null).topDark, true);
  assert.equal(frameColors("#bbbbbb", null).topDark, true);
  assert.equal(frameColors("#bdbdbd", null).topDark, false);
  assert.equal(frameColors(null, "#bdbdbd").bottomDark, false);

  // A page's life in Saltix: its theme-color, then a header colour, then its theme-color changed and removed.
  let header = null;
  let page = pageColorOf(look({ themeColors: [meta(navy)], bodyBackground: "rgb(244, 246, 251)" }), opaque);
  assert.equal(frameColors(header, page).band, navy, "theme-color before any setHeader");
  header = blue;
  assert.equal(frameColors(header, page).band, blue, "a later setHeader wins over theme-color");
  page = pageColorOf(look({ themeColors: [meta("#123456")], bodyBackground: "rgb(244, 246, 251)" }), opaque);
  assert.deepEqual(frameColors(header, page), { band: blue, around: "#123456", topDark: true, bottomDark: true },
    "a changed theme-color moves the margins, never the band setHeader holds");
  page = pageColorOf(look({ bodyBackground: "rgb(244, 246, 251)" }), opaque);
  assert.deepEqual(frameColors(header, page), { band: blue, around: "#f4f6fb", topDark: true, bottomDark: false }, "removed: the background");
  assert.equal(frameColors(null, page).band, "#f4f6fb", "without setHeader the band follows the page");
});

test("grain.layout() in a wallet tells a page without viewport-fit=cover, once, on the console", async () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(m);
  const page = (content) => {
    globalThis.document = {
      documentElement: { style: { setProperty: () => {} } },
      querySelectorAll: () => (content === null ? [] : [{ getAttribute: () => content }]),
    };
  };
  try {
    page("width=device-width, initial-scale=1");
    saltix(3, () => ({ safe_area: { top: 0, bottom: 0, left: 0, right: 0 }, controls: null }));
    (await grain.layout()).stop();
    (await grain.layout()).stop();
    assert.deepEqual(warned, [COVER_GUIDANCE], "once");
    assert.match(COVER_GUIDANCE, /viewport-fit=cover/);
    // A page that declared it hears nothing.
    warned.length = 0;
    page("width=device-width, viewport-fit=cover");
    saltix(3, () => ({}));
    (await grain.layout()).stop();
    assert.deepEqual(warned, []);
    // Outside a wallet there is no frame to speak of.
    page(null);
    delete globalThis.saltix;
    _reset();
    (await grain.layout()).stop();
    assert.deepEqual(warned, []);
  } finally {
    console.warn = warn;
    delete globalThis.document;
    delete globalThis.saltix;
    _reset();
  }
});
