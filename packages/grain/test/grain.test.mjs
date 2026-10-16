// The bridge as a wallet answers it: a fake `window.saltix` records what the SDK sends.
import test from "node:test";
import assert from "node:assert/strict";
import {
  grain, inWallet, walletLink, slugLink, chatLink, GrainError, ErrorCode, MAX_RELAY_PAYLOAD, _reset, layoutOf, cssVariables, controlsFor,
  CONTROLS_BOX, LAYOUT_VARIABLES, BAND, viewportFitCover, viewportOf, frameFor, cornerDepth, COVER_GUIDANCE,
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

/** A document whose `:root` records the CSS variables set, and a window whose resizes the test fires. */
function screen() {
  const vars = {};
  const resize = new Set();
  globalThis.document = { documentElement: { style: { setProperty: (name, value) => { vars[name] = value; } } } };
  globalThis.addEventListener = (type, h) => type === "resize" && resize.add(h);
  globalThis.removeEventListener = (type, h) => type === "resize" && resize.delete(h);
  return {
    vars,
    resize: () => [...resize].forEach((h) => h()),
    listening: () => resize.size,
    restore() {
      delete globalThis.document;
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
