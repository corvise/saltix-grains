/**
 * The wallet's side of the bridge on a computer (Saltix 12-grains §10): it opens a grain in an
 * iframe named `saltix-simulator`, and `@saltix/grain` in the page sends its requests here. The
 * page is framed as Saltix frames it (bridge version 3, `./phone.ts`): inside the safe area below
 * the band that holds the wallet's ⋯ | ✕, or edge to edge when it declares `viewport-fit=cover`, at a
 * phone's, the Galaxy Z Fold's and an iPhone-like screen's sizes. `npm run dev` serves it with the example grain, `grain dev` with yours
 * (`?manifest=<url>` loads a manifest and opens its page).
 * Sign-in uses a test grain secret kept in this browser (real signatures, checkable by
 * `@saltix/grain-server`), with this account's member proof when the development registry puts it on the app's team or
 * among a private app's members (12-grains §5.1a; "Wallet" plays Saltix 0.1.53, whose sign-ins carry no member); invoices are checked like a wallet checks them; payments are not made
 * (it answers a made-up id); storage lives in this browser. Relay frames the grain sends are logged,
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
import { type SheetManifest, fetchProfile, showConnectSheet } from "./connect-sheet";
import { setupPhone } from "./phone";

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

/** The user's key in the grain, as the wallet derives it (12-grains §5.1). */
const grainSeed = (slug: string) => derive("Saltix grain key v1", secret(), new TextEncoder().encode(slug));
/** The grain alias's address once `relay.open` registered it. */
let alias: string | null = null;

async function handle(origin: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const s = settings();
  const storageKey = (k: unknown) => `sim.storage.${s.slug}.${String(k)}`;
  switch (method) {
    case "grain_info":
      // Bridge version 3: the page's frame (12-grains §5, §7): zeros and no controls inside the safe area, the bars'
      // reach and the controls' box edge to edge.
      return {
        slug: s.slug, version: 1, form: "hosted", listing: "unlisted", host: "simulator", host_version: "0.1.0",
        bridge: 3, language: s.language, theme: s.theme, ...phone.insets(), network: "devnet", start: s.start,
      };
    case "grain_login": {
      if (!consents.has("login") && !confirm(`${s.slug} asks to sign you in under a key of its own.`)) throw new Refusal(4001, "the user declined");
      consents.add("login");
      const challenge = fromHex(String(params.challenge ?? ""));
      if (challenge.length > 64) throw new Refusal(-32602, "challenge: at most 64 bytes");
      const seed = grainSeed(s.slug);
      const at = Date.now();
      const answer = { key: toHex(ed25519.getPublicKey(seed)), signature: toHex(ed25519.sign(loginMessage(s.slug, origin, challenge, at), seed)), at, origin };
      // Saltix 0.1.53 puts no `member` in a sign-in; a newer one always does, the team's proof or null (12-grains §5.1a).
      if ($<HTMLSelectElement>("wallet").value === "legacy") return answer;
      return { ...answer, member: await chat.loginMember() };
    }
    case "grain_requestAddress":
      // Switched off on the Connect sheet: Saltix shows the sheet again with that one row, within 5 seconds of a tap.
      if (!consents.has("address") && !confirm(`${s.slug} asks for your address: it could follow your activity on the blockchain (balances, transfers, names).`)) {
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
      let line: string;
      if (typeof params.invoice === "string") {
        if (s.owner && s.genesis) {
          const problem = invoiceProblem(params.invoice, s.slug, s.owner, s.genesis);
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
      if (!consents.has("notifications")) {
        if (!confirm(`${s.slug} asks to send you notifications.`)) return { allowed: false };
        consents.add("notifications");
      }
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
      window.open(String(params.url), "_blank", "noopener");
      return null;
    case "grain_manage_open": {
      // The wallet's own manage page (bridge 3): only for the app's team, within 5 seconds of a tap. The simulator has
      // no manage page; it checks the section and says what Saltix would open.
      const section = params.section;
      if (section !== undefined && section !== "members") throw new Refusal(-32602, "section: members");
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
  const m = event.data as { saltixSim?: number; id?: number; method?: string; params?: Record<string, unknown> };
  if (!m || m.saltixSim !== 1 || !m.method) return;
  const reply = (body: object) => frame.contentWindow?.postMessage({ saltixSim: 1, id: m.id, ...body }, event.origin);
  try {
    const result = await handle(event.origin, m.method, m.params ?? {});
    write(`${m.method} ${JSON.stringify(m.params)} → ${JSON.stringify(result)}`);
    reply({ result });
  } catch (e) {
    const err = e instanceof Refusal ? { code: e.code, message: e.message } : { code: 5000, message: String(e) };
    write(`${m.method} ${JSON.stringify(m.params)} ✖ ${err.code} ${err.message}`);
    reply({ error: err });
  }
});

function emit(event: string, data: object) {
  frame.contentWindow?.postMessage({ saltixSim: 1, event, data }, "*");
}

/** The manifest loaded and where it came from: what the Connect sheet shows. */
let loaded: { manifest: SheetManifest; url: string } | null = null;

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
  $<HTMLInputElement>("url").value = m.entry.hosted?.url ?? (m.entry.sealed ? new URL(m.entry.sealed.start, url).href : "");
  loaded = { manifest: m, url };
  consents.clear();
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
