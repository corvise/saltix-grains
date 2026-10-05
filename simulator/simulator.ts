/**
 * The wallet's side of the bridge on a computer (Salarium 12-grains §10): it opens a grain in an
 * iframe named `salarium-simulator`, and `@salarium/grain` in the page sends its requests here.
 * Sign-in uses a test grain secret kept in this browser (real signatures, checkable by
 * `@salarium/grain-server`); invoices are checked like a wallet checks them; payments are not made
 * (it answers a made-up id); storage lives in this browser.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { derive, fromHex, toHex, loginMessage, invoiceProblem, decodeInvoice } from "../packages/server/src/index";

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
      const seed = derive("Salarium grain key v1", secret(), new TextEncoder().encode(s.slug));
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
$<HTMLButtonElement>("manifest").onclick = async () => {
  const url = prompt("The grain's manifest URL", new URL("/.well-known/salarium-grain", location.href).href);
  if (!url) return;
  const signed = await (await fetch(url)).json();
  $<HTMLInputElement>("slug").value = signed.manifest.slug;
  $<HTMLInputElement>("owner").value = signed.manifest.owner_key;
  $<HTMLInputElement>("url").value = signed.manifest.entry.hosted?.url ?? "";
  write(`manifest of ${signed.manifest.slug} v${signed.manifest.version} loaded`);
};
