/**
 * The wallet's side of the bridge on a computer (Saltix 12-grains §10): it opens a grain in an
 * iframe named `saltix-simulator`, and `@saltix/grain` in the page sends its requests here. The
 * page is framed as Saltix frames it (bridge version 3, `./phone.ts`): inside the safe area below
 * the band that holds the wallet's ⋯ | ✕, or edge to edge when it declares `viewport-fit=cover`, at a
 * phone's, the Galaxy Z Fold's and an iPhone-like screen's sizes. `npm run dev` serves it with the example grain, `grain dev` with yours
 * (`?manifest=<url>` loads a manifest and opens its page).
 * Sign-in uses a test grain secret kept in this browser (real signatures, checkable by
 * `@saltix/grain-server`), with this account's member proof when the development registry puts it on the app's team or
 * among a private app's members (12-grains §5.1a; "Wallet" plays Saltix 0.1.53, whose sign-ins carry no member), and a
 * sealed grain's sign-in names its virtual origin as Saltix's does; invoices are checked like a wallet checks them, a
 * registered server key's too; payments are not made (it answers a made-up id); storage lives in this browser. Every
 * request is held to Saltix's rules (`@saltix/grain/rules`): a tap before a payment, the chat, the app's page and the
 * first asks for the address and notifications; the manifest's permissions; the team for the app's page; rate limits;
 * storage's bounds; 64 KiB an answer or an event. Relay frames the grain sends are logged,
 * and "Frame to the grain" plays one arriving; "Check a notification" checks your server's like a
 * wallet does. The chat pane talks to the grain's chat server through the development relay as a wallet would
 * (22-grain-chats; `npm run dev`).
 */
import { ed25519 } from "@noble/curves/ed25519";
// Module by module: the package's index also exports the relay client, which needs Node.
import { derive, fromHex, toHex } from "../packages/server/src/bytes";
import { accountId, encodeAddress } from "../packages/server/src/address";
import { loginMessage } from "../packages/server/src/login";
import { invoiceProblem, decodeInvoice } from "../packages/server/src/invoice";
import { notificationProblem, decodeNotification } from "../packages/server/src/notification";
import { type DeviceKey, deviceKeyOf } from "../packages/server/src/keys";
import { setupChat } from "./chat";
import { sealedOrigin } from "../packages/server/src/sign-in";
import { BridgeLimiter, bridgeAnswer, bridgeEvent, devPageUrl, manageRule, permissionRule, storageRule, tapRule } from "../packages/grain/src/rules";
import { type SheetManifest, fetchProfile, showConnectSheet } from "./connect-sheet";
import { DEVICES, setupPhone } from "./phone";
import { ICON_PATH } from "./icon";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = $<HTMLIFrameElement>("grain");
const log = $<HTMLPreElement>("log");

/** A test key kept in this browser under `name`, made the first time. */
function kept(name: string): Uint8Array {
  let hex = localStorage.getItem(name);
  if (!hex) {
    hex = toHex(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(name, hex);
  }
  return fromHex(hex, 32);
}
/** The simulator's grain secret (12-grains §5.1). */
const secret = () => kept("sim.secret");
/** The simulator's account key: a plain account's own key, which signs member proofs (24-app-studio §2a). */
const account = () => kept("sim.account");

const settings = () => ({
  slug: $<HTMLInputElement>("slug").value.trim(),
  start: $<HTMLInputElement>("start").value.trim() || null,
  language: $<HTMLSelectElement>("language").value,
  theme: $<HTMLSelectElement>("theme").value as "dark" | "light",
  address: $<HTMLInputElement>("address").value.trim(),
  owner: ownerKey($<HTMLInputElement>("owner").value.trim()),
  genesis: $<HTMLInputElement>("genesis").value.trim(),
});

/** The owner key typed in: an Ed25519 key's hex, or the manifest's JSON form (`{"p256": "<hex>"}`). */
function ownerKey(text: string): DeviceKey | null {
  if (text.startsWith("{")) {
    try {
      return deviceKeyOf(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return /^[0-9a-f]{64}$/.test(text) ? { ed25519: text } : null;
}

function write(line: string) {
  log.textContent = `${new Date().toLocaleTimeString()} ${line}\n` + log.textContent;
}

class Refusal extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const consents = new Set<string>();
/** The consent each method's first ask records. */
const CONSENT: Record<string, string> = { grain_login: "login", grain_requestAddress: "address", grain_notifications_allow: "notifications" };
/** Requests counted per method, as Saltix counts them; a new one with each manifest. */
let limiter = new BridgeLimiter();
let unknownActivation = false;

/** What this browser's storage keeps for `slug`. */
function storageOf(slug: string): Map<string, string> {
  const prefix = `sim.storage.${slug}.`;
  const kept = new Map<string, string>();
  for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) kept.set(k.slice(prefix.length), localStorage.getItem(k) ?? "");
  return kept;
}

/** Saltix's rules for a request before it is answered (`@saltix/grain/rules`): known and not too often, asked for by
 *  the manifest, and from a tap where it needs one. What the page gets instead of an answer, or whether to ask the user. */
function rulesFor(method: string, params: Record<string, unknown>, activation: boolean | null, slug: string): { answer: unknown } | { ask: boolean } {
  const counted = limiter.take(method, Date.now());
  if (counted === "unsupported") throw new Refusal(4200, `unsupported method ${method}`);
  if (counted === "rate_limited") throw new Refusal(4290, `${method}: too often`);
  if (loaded) {
    const refused = permissionRule(method, loaded.manifest.permissions);
    if (refused) throw new Refusal(refused.refuse, refused.message);
  }
  if (activation === null && !unknownActivation) {
    unknownActivation = true;
    write("this browser cannot tell a tap (navigator.userActivation): requests that need one are taken as if tapped");
  }
  const tap = tapRule(method, { tapped: activation !== false, consented: consents.has(CONSENT[method] ?? "") });
  if ("refuse" in tap) throw new Refusal(tap.refuse, `${tap.message} (Saltix: within 5 seconds of a touch)`);
  if ("answer" in tap) return tap;
  if (method.startsWith("grain_storage_") && method !== "grain_storage_keys") {
    const refused = storageRule(method.slice("grain_storage_".length) as "get" | "set" | "remove", params, storageOf(slug));
    if (refused) throw new Refusal(refused.refuse, refused.message);
  }
  return { ask: tap.ask };
}

/** The user's key in the grain, as the wallet derives it (12-grains §5.1). */
const grainSeed = (slug: string) => derive("Saltix grain key v1", secret(), new TextEncoder().encode(slug));
/** The grain alias's address once `relay.open` registered it. */
let alias: string | null = null;

/** Whether the loaded manifest is a sealed grain's: Saltix serves it at its virtual origin. */
const isSealed = () => loaded !== null && "sealed" in loaded.manifest.entry;

async function handle(origin: string, method: string, params: Record<string, unknown>, activation: boolean | null): Promise<unknown> {
  const s = settings();
  const storageKey = (k: unknown) => `sim.storage.${s.slug}.${String(k)}`;
  const rule = rulesFor(method, params, activation, s.slug);
  if ("answer" in rule) return rule.answer;
  switch (method) {
    case "grain_info":
      // Bridge version 3: the page's frame (12-grains §5, §7): zeros and no controls inside the safe area, the bars'
      // reach and the controls' box edge to edge.
      return {
        slug: s.slug, version: loaded?.manifest.version ?? 1, form: isSealed() ? "sealed" : "hosted", listing: "unlisted", host: "simulator",
        host_version: "0.1.0", bridge: 3, language: s.language, theme: s.theme, ...phone.insets(), network: "devnet", start: s.start,
      };
    case "grain_login": {
      if (rule.ask && !confirm(`${s.slug} asks to sign you in under a key of its own.`)) throw new Refusal(4001, "the user declined");
      consents.add("login");
      const challenge = fromHex(String(params.challenge ?? ""));
      if (challenge.length > 64) throw new Refusal(-32602, "challenge: at most 64 bytes");
      const seed = grainSeed(s.slug);
      const at = Date.now();
      // A sealed grain's page runs at its virtual origin in Saltix, and its sign-ins name that (12-grains §8), whatever
      // address this computer serves it from.
      const named = isSealed() ? sealedOrigin(s.slug) : origin;
      const answer = { key: toHex(ed25519.getPublicKey(seed)), signature: toHex(ed25519.sign(loginMessage(s.slug, named, challenge, at), seed)), at, origin: named };
      // Saltix 0.1.53 puts no `member` in a sign-in; a newer one always does, the team's proof or null (12-grains §5.1a).
      if ($<HTMLSelectElement>("wallet").value === "legacy") return answer;
      return { ...answer, member: await chat.loginMember() };
    }
    case "grain_requestAddress":
      // Switched off on the Connect sheet: Saltix shows the sheet again with that one row, within 5 seconds of a tap.
      if (rule.ask && !confirm(`${s.slug} asks for your address: it could follow your activity on the blockchain (balances, transfers, names).`)) {
        throw new Refusal(4001, "the user declined");
      }
      consents.add("address");
      return { address: s.address };
    case "grain_pickContact": {
      const a = prompt("A contact's address");
      if (!a) throw new Refusal(4001, "the user cancelled");
      return { address: a };
    }
    case "grain_pay": {
      // Driven by grain dev --check: no payment is ever asked for, as a user may decline one.
      if (driven) throw new Refusal(4001, "declined: grain dev --check makes no payment");
      let line: string;
      if (typeof params.invoice === "string") {
        if (s.owner && s.genesis) {
          // Against the development registry too: an invoice of a server key it names pays the owner (12-grains §5.2).
          const problem = invoiceProblem(params.invoice, s.slug, s.owner, s.genesis, Date.now(), await chat.record());
          if (problem) throw new Refusal(-32602, `invoice: ${problem}`);
        }
        const { invoice } = decodeInvoice(params.invoice);
        line = `Invoice from ${s.slug}: ${invoice.amount} base units of ${invoice.asset} — ${invoice.memo}`;
      } else {
        line = `${s.slug} asks to pay ${params.amount} ${params.asset ?? "SALT"} to ${params.to}`;
      }
      if (!confirm(line + "\n\nThe simulator makes no payment.")) throw new Refusal(4001, "the user declined");
      return { id: "sim-" + toHex(crypto.getRandomValues(new Uint8Array(8))) };
    }
    case "grain_storage_get":
      return { value: localStorage.getItem(storageKey(params.key)) };
    case "grain_storage_set":
      localStorage.setItem(storageKey(params.key), String(params.value));
      return null;
    case "grain_storage_remove":
      localStorage.removeItem(storageKey(params.key));
      return null;
    case "grain_storage_keys": {
      const prefix = storageKey("");
      return { keys: Object.keys(localStorage).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort() };
    }
    case "grain_relay_open":
      alias = encodeAddress("devnet", accountId(ed25519.getPublicKey(grainSeed(s.slug))));
      // A wallet checks a grant against the manifest's sponsor; the simulator pays no relay, so it only says so.
      if (typeof params.grant === "string") write(`relay: opened with a sponsor's grant (${params.grant.length / 2} bytes)`);
      return { address: alias };
    case "grain_relay_send": {
      if (!alias) throw new Refusal(5000, "the frame did not go out: open the relay first");
      const payload = String(params.payload ?? "");
      if (!/^([0-9a-f]{2}){1,48000}$/.test(payload)) throw new Refusal(-32602, "payload: lowercase hex of 1 to 48000 bytes");
      write(`relay → ${params.to}${params.keep ? " (kept)" : ""}: ${payload.length / 2} bytes`);
      return null;
    }
    case "grain_relay_close":
      alias = null;
      return null;
    case "grain_notifications_allow":
      // Asked again only from a tap (rulesFor); once allowed, allowed.
      if (rule.ask && !confirm(`${s.slug} asks to send you notifications.`)) return { allowed: false };
      consents.add("notifications");
      return { allowed: true };
    case "grain_scanQr": {
      const t = prompt(String(params.hint ?? "The text of a QR code"));
      if (!t) throw new Refusal(4001, "the user cancelled");
      return { text: t };
    }
    case "grain_copy":
      await navigator.clipboard?.writeText(String(params.text));
      return null;
    case "grain_openLink":
      // Driven by grain dev --check: nothing outside this computer is opened.
      if (driven) {
        write(`grain_openLink ${String(params.url)}: not opened (grain dev --check)`);
        return null;
      }
      window.open(String(params.url), "_blank", "noopener");
      return null;
    case "grain_manage_open": {
      // The wallet's own manage page (bridge 3): only for the app's team, within 5 seconds of a tap. The simulator has
      // no manage page; it checks the section and the team, and says what Saltix would open.
      const section = params.section;
      if (section !== undefined && section !== null && section !== "members") throw new Refusal(-32602, "section: one of members");
      const team = manageRule(await chat.onTeam());
      if (team) throw new Refusal(team.refuse, team.message);
      write(`grain_manage_open: Saltix opens ${s.slug}'s manage page${section ? ` at its ${section}` : ""}, above the app, for its team (a mock here)`);
      return null;
    }
    case "grain_chat_open":
      await chat.open(typeof params.cert === "string" ? params.cert : undefined, typeof params.spec === "string" ? params.spec : undefined);
      return null;
    case "grain_ready":
      // Saltix ignores it today (12-grains §7): its splash shows while the page loads and goes once it has loaded.
      write("grain_ready: nothing to do; the splash went when the page loaded, as in Saltix");
      return null;
    case "grain_close":
      phone.close("grain_close");
      return null;
    case "grain_setHeader": {
      const color = String(params.color ?? "");
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Refusal(-32602, "color: #rrggbb");
      phone.setHeader(color);
      return null;
    }
    // A grain always opens as a full app (bridge 3): expanding changes nothing.
    case "grain_expand": case "grain_haptic": case "grain_share":
      return null;
    default:
      throw new Refusal(4200, `unsupported method ${method}`);
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const m = event.data as { saltixSim?: number; id?: number; method?: string; params?: Record<string, unknown>; activation?: boolean | null };
  if (!m || m.saltixSim !== 1 || !m.method) return;
  // What Saltix posts, at most 64 KiB of JSON: a longer answer becomes its error (bridgeAnswer).
  const reply = (body: { result: unknown } | { error: { code: number; message: string } }) => {
    const answer = JSON.parse(bridgeAnswer(m.id ?? 0, body)) as Record<string, unknown>;
    if ("error" in answer && "result" in body) write(`${m.method} ✖ 5000: the answer is over 64 KiB, so Saltix answers this error instead`);
    frame.contentWindow?.postMessage({ saltixSim: 1, ...answer, id: m.id }, event.origin);
  };
  try {
    const result = await handle(event.origin, m.method, m.params ?? {}, typeof m.activation === "boolean" ? m.activation : null);
    write(`${m.method} ${JSON.stringify(m.params)} → ${JSON.stringify(result)}`);
    calls.push({ method: m.method, ok: true });
    reply({ result });
  } catch (e) {
    const err = e instanceof Refusal ? { code: e.code, message: e.message } : { code: 5000, message: String(e) };
    write(`${m.method} ${JSON.stringify(m.params)} ✖ ${err.code} ${err.message}`);
    refused.push({ method: m.method, code: err.code, message: err.message });
    calls.push({ method: m.method, ok: false, code: err.code, message: err.message });
    reply({ error: err });
  }
});

function emit(event: string, data: object) {
  // An event over 64 KiB of JSON never reaches a page in Saltix (a relay frame's hex is twice its size).
  if (bridgeEvent(event, data) === null) return write(`${event} event dropped: over 64 KiB, as Saltix drops it`);
  frame.contentWindow?.postMessage({ saltixSim: 1, event, data }, "*");
}

/** The manifest loaded and where it came from: what the Connect sheet shows. */
let loaded: { manifest: SheetManifest; url: string } | null = null;

/** The loaded manifest's icon where `grain dev` serves it, when the manifest names one; null for none (the monogram). */
const iconUrl = (): string | null => (loaded && loaded.manifest.icon && !/^0+$/.test(loaded.manifest.icon) ? new URL(ICON_PATH, loaded.url).href : null);

/** Requests the simulator refused, as the page got them: what `grain dev --check` reports. */
const refused: Array<{ method: string; code: number; message: string }> = [];
/** Every request the page made, answered or refused, in order: what `grain dev --check --tap` reads after each tap. */
const calls: Array<{ method: string; ok: boolean; code?: number; message?: string }> = [];
/** Whether a tool drives the simulator (`grain dev --check`): no payment is asked for and no link is opened. */
let driven = false;

/** The Connect sheet the first time this account opens the app (19-connect §12.2): Continue records the sign-in and the
 *  switches as set; Cancel opens nothing and sends nothing. Whether the app may open. */
async function connectFirst(): Promise<boolean> {
  if (!loaded || consents.has("login") || !$<HTMLInputElement>("connect-first").checked) return true;
  const { profile, problem } = await fetchProfile(loaded.url, loaded.manifest.owner);
  if (problem) write(`connect.json ✖ ${problem}: a wallet shows the app as having no Connect profile`);
  const choice = await showConnectSheet({
    phone: $("phone"),
    frame: phone.sheetFrame,
    lang: () => settings().language,
    theme: () => settings().theme,
    log: write,
    icon: iconUrl,
  }, loaded.manifest, profile, problem);
  if (choice === null) {
    write("Connect sheet: Cancel; Saltix opens nothing and sends nothing");
    return false;
  }
  consents.add("login");
  // A switch left off is a refusal the app learns as 4001 when it asks.
  if (choice.address) consents.add("address");
  if (choice.notifications) consents.add("notifications");
  write(`Connect sheet: Continue (address ${choice.address ? "on" : "off"}, notifications ${choice.notifications ? "on" : "off"})`);
  return true;
}

/** Open the grain's page at the URL the form holds, after the Connect sheet the first time. */
async function openGrain(): Promise<void> {
  if (!(await connectFirst())) return;
  const url = $<HTMLInputElement>("url").value.trim();
  if (!url) return write("no page to open: a chat-only app has none (its home is Saltix's own screen)");
  phone.opened();
  frame.src = url;
  write(`opened ${frame.src}`);
}

const phone = setupPhone({
  frame,
  name: () => settings().slug,
  theme: () => settings().theme,
  log: write,
  emit,
  openChat: () => void chat.open(),
  reopen: () => void openGrain(),
  icon: iconUrl,
});

const chat = setupChat({
  slug: () => settings().slug,
  owner: () => settings().owner,
  language: () => settings().language,
  secret,
  account,
  log: write,
  open: (start) => {
    $<HTMLInputElement>("start").value = start;
    void openGrain();
  },
});

$<HTMLButtonElement>("open").onclick = () => void openGrain();
// The sheet again, as for an account that never opened the app (or revoked it: Settings → Connected apps and sites).
$<HTMLButtonElement>("connect-again").onclick = () => {
  consents.clear();
  void openGrain();
};
$<HTMLSelectElement>("theme").onchange = () => {
  emit("theme", { theme: settings().theme });
  phone.repaint();
};
$<HTMLButtonElement>("hide").onclick = () => emit("visibility", { visible: false });
$<HTMLButtonElement>("show").onclick = () => emit("visibility", { visible: true });
$<HTMLButtonElement>("frame").onclick = () => {
  if (!alias) return write("relay: the grain has not opened its relay");
  const from = prompt("From (an address)", "dsalt1q…");
  const text = from && prompt("The frame, as text");
  if (!from || text == null) return;
  emit("relay", { from, payload: toHex(new TextEncoder().encode(text)) });
  write(`relay ← ${from}: ${text.length} characters`);
};
/** The server keys the development registry names, if `npm run dev` serves one: a notification may be signed by one. */
let registered: string[] = [];
void fetch("/api/dev").then((r) => r.json()).then((d: { servers?: string[] }) => { registered = d.servers ?? []; }).catch(() => {});

$<HTMLButtonElement>("notification").onclick = () => {
  const s = settings();
  const hex = prompt("A signed notification from your server (hex)");
  if (!hex) return;
  if (!s.owner || !s.genesis) return write("notification: set the owner key and the genesis hash first");
  let bytes: Uint8Array;
  try {
    bytes = fromHex(hex.trim().toLowerCase());
  } catch {
    return write("notification ✖ malformed");
  }
  const problem = notificationProblem(bytes, s.slug, s.owner, s.genesis, Date.now(), registered);
  if (problem) return write(`notification ✖ ${problem}`);
  const { notification: n } = decodeNotification(bytes);
  write(`notification ✔ "${n.title}" ${n.body}${n.start ? ` (opens with ${n.start})` : ""}`);
};
/** Load the manifest at `url`: its slug, owner key and page (a hosted grain's URL, a sealed grain's start page where
 *  `grain dev` serves `public/`, or none for a chat-only grain). */
async function loadManifest(url: string): Promise<void> {
  const signed = await (await fetch(url)).json();
  const m = signed.manifest;
  $<HTMLInputElement>("slug").value = m.slug;
  const key = m.owner_key;
  $<HTMLInputElement>("owner").value = "ed25519" in key ? key.ed25519 : JSON.stringify(key);
  $<HTMLInputElement>("url").value = devPageUrl(m.entry, url) ?? "";
  loaded = { manifest: m, url };
  consents.clear();
  limiter = new BridgeLimiter();
  phone.repaint();
  write(`manifest of ${m.slug} v${m.version} loaded`);
}

$<HTMLButtonElement>("manifest").onclick = async () => {
  const url = prompt("The grain's manifest URL", new URL("/.well-known/saltix-grain", location.href).href);
  if (url) await loadManifest(url);
};

// `grain dev` opens the simulator with its manifest: load it and open the page.
const asked = new URLSearchParams(location.search).get("manifest");
if (asked) {
  void loadManifest(new URL(asked, location.href).href).then(openGrain, (e: Error) => write(`manifest ✖ ${e.message}`));
}

// ── For a tool: `grain dev --check` drives this page headless (packages/cli/src/check.ts) ──
//
// What a person does with the controls, a tool does here: pick a device, a theme and a language, pass the Connect sheet,
// and read what the simulator saw: the sheet, the page's load, the requests it refused, and the page's geometry in the
// phone's coordinates (CSS px). What is wrong in it is the tool's to judge (pure functions, tested there).

/** A box, CSS px from the phone's top left corner. */
interface Box { x: number; y: number; width: number; height: number }

/** `r` in the coordinates whose origin is at (`left`, `top`). */
const boxIn = (r: DOMRect, left: number, top: number): Box => ({ x: r.left - left, y: r.top - top, width: r.width, height: r.height });

/** Elements a user can tap. */
const TAPPABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, label[for], [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]:not([tabindex="-1"])';

/** An element as a person reads it in a report: its tag, id and first words. */
function nameOf(el: Element): string {
  const words = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${words ? ` "${words}"` : ""}`;
}

/** Whether `el` stays at its place low on the screen as the page scrolls: it, or an element around it, is fixed, or
 *  sticky to the bottom (a bottom inset). One sticky to the top scrolls up with the page until it sticks there. */
function pinnedOf(el: Element, view: Window): boolean {
  for (let e: Element | null = el; e !== null; e = e.parentElement) {
    const style = view.getComputedStyle(e);
    if (style.position === "fixed" || (style.position === "sticky" && style.bottom !== "auto")) return true;
  }
  return false;
}

/** `read()` with the page and every box in it that scrolls scrolled to its end (instantly), then each put back where it
 *  was; null when nothing scrolls. */
function scrolledToEnd<T>(doc: Document, view: Window, read: () => T): T | null {
  const scrolling = doc.scrollingElement;
  const boxes = Array.from(doc.querySelectorAll("*")).filter((e) => {
    if (e === scrolling) return false;
    const overflow = view.getComputedStyle(e).overflowY;
    return (overflow === "auto" || overflow === "scroll") && e.scrollHeight > e.clientHeight + 1;
  });
  const all = [...(scrolling && scrolling.scrollHeight > scrolling.clientHeight + 1 ? [scrolling] : []), ...boxes];
  if (all.length === 0) return null;
  const before = all.map((e) => [e.scrollLeft, e.scrollTop] as const);
  try {
    for (const e of all) e.scrollTo({ top: e.scrollHeight, behavior: "instant" });
    return read();
  } finally {
    all.forEach((e, i) => e.scrollTo({ left: before[i]![0], top: before[i]![1], behavior: "instant" }));
  }
}

function measure() {
  const phoneEl = $("phone");
  const phoneRect = phoneEl.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const capsule = $("capsule");
  const capsuleRect = capsule.getBoundingClientRect();
  const status = $("status-bar").getBoundingClientRect();
  const nav = $("nav-bar").getBoundingClientRect();
  let doc: Document | null = null;
  try {
    doc = frame.contentDocument;
  } catch {
    doc = null;
  }
  const view = doc?.defaultView ?? null;
  const tappables: Array<{ name: string; box: Box; pinned: boolean; end: Box | null }> = [];
  if (doc && view) {
    // The page's own coordinates are its frame's: the frame sits at its place in the phone.
    const inPhone = (r: DOMRect) => boxIn(r, phoneRect.left - frameRect.left, phoneRect.top - frameRect.top);
    const shown: Element[] = [];
    for (const el of Array.from(doc.querySelectorAll(TAPPABLE))) {
      const style = view.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      if ((el as HTMLElement).closest("[hidden]")) continue;
      shown.push(el);
      tappables.push({ name: nameOf(el), box: inPhone(r), pinned: pinnedOf(el, view), end: null });
    }
    // Where each is with everything scrolled to its end, as high as a user can bring it: a button at the fold of a long
    // page is under the navigation bar only until the page scrolls (grain dev --check judges that), then put back.
    const ends = scrolledToEnd(doc, view, () => shown.map((el) => inPhone(el.getBoundingClientRect())));
    if (ends) ends.forEach((box, i) => (tappables[i]!.end = box));
  }
  const navigation = view?.performance.getEntriesByType("navigation")[0] as (PerformanceEntry & { responseStatus?: number }) | undefined;
  const body = doc?.body ?? null;
  return {
    device: $<HTMLSelectElement>("size").value,
    theme: settings().theme,
    language: settings().language,
    mode: $("frame-mode").textContent ?? "",
    phone: { width: phoneRect.width, height: phoneRect.height, page: { x: phoneRect.left + scrollX, y: phoneRect.top + scrollY } },
    frame: boxIn(frameRect, phoneRect.left, phoneRect.top),
    controls: capsule.hidden || capsuleRect.width === 0 ? null : boxIn(capsuleRect, phoneRect.left, phoneRect.top),
    bars: { top: Math.max(0, status.bottom - phoneRect.top), bottom: Math.max(0, phoneRect.bottom - nav.top) },
    // The page as it loaded (never the frame's first, empty document).
    page: doc && view && body && doc.URL !== "about:blank" ? {
      url: doc.URL,
      ready: doc.readyState,
      status: typeof navigation?.responseStatus === "number" ? navigation.responseStatus : null,
      title: doc.title,
      scrollWidth: doc.documentElement.scrollWidth,
      clientWidth: doc.documentElement.clientWidth,
      background: view.getComputedStyle(body).backgroundColor,
      color: view.getComputedStyle(body).color,
      rootBackground: view.getComputedStyle(doc.documentElement).backgroundColor,
    } : null,
    tappables,
  };
}

/** What `grain dev --check --tap` taps: the page's buttons (never a link, which leaves the page), each once. */
const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
/** At most this many buttons are tapped: a page with more is a list of the same, and the check stays bounded. */
const MAX_TAPS = 30;
/** The buttons `buttons()` found, held to be tapped one by one while the page changes under them. */
let toTap: Element[] = [];

/** The page's document, when it has loaded one. */
function pageDocument(): Document | null {
  try {
    const doc = frame.contentDocument;
    return doc && doc.URL !== "about:blank" ? doc : null;
  } catch {
    return null;
  }
}

/** Whether a user can see and tap `el` now. */
function shownAndEnabled(el: Element, view: Window): boolean {
  const style = view.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
  if ((el as HTMLElement).closest("[hidden]")) return false;
  return !((el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true");
}

/** The page's buttons a user can tap, in the document's order, at most `MAX_TAPS`: their names, and how many there are. */
function buttons(): { names: string[]; total: number } {
  const doc = pageDocument();
  const view = doc?.defaultView;
  if (!doc || !view) return { names: [], total: 0 };
  const all = Array.from(doc.querySelectorAll(BUTTONS)).filter((el) => shownAndEnabled(el, view));
  toTap = all.slice(0, MAX_TAPS);
  return { names: toTap.map(nameOf), total: all.length };
}

/**
 * Where to tap the `i`th button, in the coordinates of the simulator's own viewport (where a tool's pointer goes): its
 * middle, scrolled into view inside the page. `gone` or `hidden` when an earlier tap took it away; `covered` when another
 * element is over its middle, which a user's tap would reach instead.
 */
function aim(i: number): { state: "ready"; x: number; y: number } | { state: "gone" | "hidden" } | { state: "covered"; by: string } {
  const el = toTap[i];
  const doc = pageDocument();
  const view = doc?.defaultView;
  if (!el || !doc || !view || !el.isConnected || el.ownerDocument !== doc) return { state: "gone" };
  if (!shownAndEnabled(el, view)) return { state: "hidden" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const hit = doc.elementFromPoint(cx, cy);
  if (hit === null || (hit !== el && !el.contains(hit))) return { state: "covered", by: hit ? nameOf(hit) : "nothing of the page (it is outside the frame)" };
  const f = frame.getBoundingClientRect();
  return { state: "ready", x: f.left + cx, y: f.top + cy };
}

const select = (id: string, value: string) => {
  const el = $<HTMLSelectElement>(id);
  if (!Array.from(el.options).some((o) => o.value === value)) throw new Error(`${id}: no ${value}`);
  el.value = value;
  el.dispatchEvent(new Event("change"));
};

(window as unknown as { saltixSimulator: unknown }).saltixSimulator = {
  version: 1,
  devices: () => DEVICES.map((d) => d.id),
  set(o: { device?: string; theme?: "dark" | "light"; language?: string }) {
    if (o.language) $<HTMLSelectElement>("language").value = o.language;
    if (o.theme) select("theme", o.theme);
    if (o.device) select("size", o.device);
  },
  /** The Connect sheet on the phone now: its words, and why connect.json would be refused (null: it checks). */
  sheet() {
    const sheet = document.querySelector<HTMLElement>(".connect-sheet");
    if (!sheet) return null;
    const iconState = sheet.querySelector<HTMLElement>(".cs-icon")?.dataset.iconState ?? "none";
    return {
      text: sheet.innerText,
      problem: sheet.querySelector(".cs-bad")?.textContent ?? null,
      profile: sheet.querySelector(".cs-tagline") !== null,
      icon: iconState === "loaded",
      iconState,
    };
  },
  continue() {
    const go = document.querySelector<HTMLButtonElement>(".connect-sheet .cs-continue");
    go?.click();
    return go !== null;
  },
  refused: () => refused.slice(),
  /** Every request the page made, in order (`from`: the first one to give). */
  calls: (from = 0) => calls.slice(from),
  /** A tool drives the simulator from now on: no payment is asked for (declined, 4001) and no link opened. */
  drive() {
    driven = true;
  },
  buttons,
  aim,
  measure,
};
