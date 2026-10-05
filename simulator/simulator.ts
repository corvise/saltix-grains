/**
 * The wallet's side of the bridge on a computer (Salarium 12-grains §10): it opens a grain in an
 * iframe named `salarium-simulator`, and `@salarium/grain` in the page sends its requests here.
 * Sign-in uses a test grain secret kept in this browser (real signatures, checkable by
 * `@salarium/grain-server`); invoices are checked like a wallet checks them; payments are not made
 * (it answers a made-up id); storage lives in this browser. Relay frames the grain sends are logged,
 * and "Frame to the grain" plays one arriving; "Check a notification" checks your server's like a
 * wallet does.
 */
import { ed25519 } from "@noble/curves/ed25519";
// Module by module: the package's index also exports the relay client, which needs Node.
import { derive, fromHex, toHex } from "../packages/server/src/bytes";
import { accountId, encodeAddress } from "../packages/server/src/address";
import { loginMessage } from "../packages/server/src/login";
import { invoiceProblem, decodeInvoice } from "../packages/server/src/invoice";
import { notificationProblem, decodeNotification } from "../packages/server/src/notification";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = $<HTMLIFrameElement>("grain");
const log = $<HTMLPreElement>("log");

function secret(): Uint8Array {
  let hex = localStorage.getItem("sim.secret");
  if (!hex) {
    hex = toHex(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem("sim.secret", hex);
  }
  return fromHex(hex, 32);
}

const settings = () => ({
  slug: $<HTMLInputElement>("slug").value.trim(),
  start: $<HTMLInputElement>("start").value.trim() || null,
  language: $<HTMLSelectElement>("language").value,
  theme: $<HTMLSelectElement>("theme").value as "dark" | "light",
  address: $<HTMLInputElement>("address").value.trim(),
  owner: $<HTMLInputElement>("owner").value.trim(),
  genesis: $<HTMLInputElement>("genesis").value.trim(),
});

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
const grainSeed = (slug: string) => derive("Salarium grain key v1", secret(), new TextEncoder().encode(slug));
/** The grain alias's address once `relay.open` registered it. */
let alias: string | null = null;

async function handle(origin: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const s = settings();
  const storageKey = (k: unknown) => `sim.storage.${s.slug}.${String(k)}`;
  switch (method) {
    case "grain_info":
      return {
        slug: s.slug, version: 1, form: "hosted", listing: "unlisted", host: "simulator", host_version: "0.1.0",
        bridge: 1, language: s.language, theme: s.theme, safe_area: { top: 0, bottom: 0 }, network: "devnet", start: s.start,
      };
    case "grain_login": {
      if (!consents.has("login") && !confirm(`${s.slug} asks to sign you in under a key of its own.`)) throw new Refusal(4001, "the user declined");
      consents.add("login");
      const challenge = fromHex(String(params.challenge ?? ""));
      if (challenge.length > 64) throw new Refusal(-32602, "challenge: at most 64 bytes");
      const seed = grainSeed(s.slug);
      const at = Date.now();
      return { key: toHex(ed25519.getPublicKey(seed)), signature: toHex(ed25519.sign(loginMessage(s.slug, origin, challenge, at), seed)), at, origin };
    }
    case "grain_requestAddress":
      if (!consents.has("address") && !confirm(`${s.slug} asks for your address.`)) throw new Refusal(4001, "the user declined");
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
    case "grain_ready": case "grain_close": case "grain_expand": case "grain_setHeader": case "grain_haptic": case "grain_share":
      return null;
    default:
      throw new Refusal(4200, `unsupported method ${method}`);
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const m = event.data as { salariumSim?: number; id?: number; method?: string; params?: Record<string, unknown> };
  if (!m || m.salariumSim !== 1 || !m.method) return;
  const reply = (body: object) => frame.contentWindow?.postMessage({ salariumSim: 1, id: m.id, ...body }, event.origin);
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
  frame.contentWindow?.postMessage({ salariumSim: 1, event, data }, "*");
}

$<HTMLButtonElement>("open").onclick = () => {
  frame.src = $<HTMLInputElement>("url").value.trim();
  write(`opened ${frame.src}`);
};
$<HTMLSelectElement>("theme").onchange = () => emit("theme", { theme: settings().theme });
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
  const problem = notificationProblem(bytes, s.slug, s.owner, s.genesis);
  if (problem) return write(`notification ✖ ${problem}`);
  const { notification: n } = decodeNotification(bytes);
  write(`notification ✔ "${n.title}" ${n.body}${n.start ? ` (opens with ${n.start})` : ""}`);
};
$<HTMLButtonElement>("manifest").onclick = async () => {
  const url = prompt("The grain's manifest URL", new URL("/.well-known/salarium-grain", location.href).href);
  if (!url) return;
  const signed = await (await fetch(url)).json();
  $<HTMLInputElement>("slug").value = signed.manifest.slug;
  $<HTMLInputElement>("owner").value = signed.manifest.owner_key;
  $<HTMLInputElement>("url").value = signed.manifest.entry.hosted?.url ?? "";
  write(`manifest of ${signed.manifest.slug} v${signed.manifest.version} loaded`);
};
