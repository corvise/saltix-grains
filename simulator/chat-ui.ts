/**
 * How the simulator draws a grain's chat (Saltix 22-grain-chats §4–5), as a wallet does: natively, never as web
 * content. Text is text (no markup), secrets are masked until tapped and hidden after they expire, files are checked
 * against the card's hash before they are shown and nothing is opened as code; forms come from the spec.
 */
import { valueOf } from "../packages/server/src/chat-card";
import {
  type Action, type Block, type ChatArgs, type ChatValue, type Command, type GrainChatSpec, type ParamKind, type Texts, dayToIso,
  takesValue,
} from "../packages/server/src/chat";
import { decodeInvoice } from "../packages/server/src/invoice";
import { readPublishText } from "../packages/server/src/publish";
import type { FileRef } from "../packages/server/src/file";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** A text in `language`, else English. */
export const pick = (texts: Texts, language: string) => texts[language] ?? texts.en ?? Object.values(texts)[0] ?? "";

const STATES = ["working", "done", "refused", "failed"];
const human = (s: number) => (s % 86_400 === 0 ? `${s / 86_400} d` : s % 3_600 === 0 ? `${s / 3_600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
const size = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

export interface Handlers {
  /** Fetch, decrypt and check a file: its plaintext. */
  download(file: FileRef): Promise<Uint8Array>;
  /** An invoice's problem as a wallet checks it, or null. */
  invoiceProblem(hex: string): string | null;
  run(command: string, args: ChatArgs, via: string): void;
  open(start: string): void;
  reply(text: string, via: string): void;
}

function secretBlock(b: Extract<Block, { secret: unknown }>["secret"]): HTMLElement {
  const value = el("span", { className: "secret", textContent: "••••••••", title: "Tap to show" });
  let shown = false;
  value.onclick = () => {
    shown = !shown && (b.expires_at === 0 || Date.now() < b.expires_at);
    value.textContent = shown ? b.value : b.expires_at !== 0 && Date.now() >= b.expires_at ? "expired" : "••••••••";
  };
  const copy = el("button", { textContent: "Copy", className: "small" });
  copy.onclick = () => {
    if (b.expires_at === 0 || Date.now() < b.expires_at) void navigator.clipboard?.writeText(b.value);
  };
  if (b.expires_at !== 0) {
    const hide = () => {
      value.textContent = "expired";
      copy.disabled = true;
    };
    if (Date.now() >= b.expires_at) hide();
    else setTimeout(hide, Math.min(b.expires_at - Date.now(), 2 ** 31 - 1));
  }
  const until = b.expires_at ? el("small", { textContent: ` until ${new Date(b.expires_at).toLocaleString()}` }) : "";
  return el("div", { className: "block" }, el("b", { textContent: b.label || "Secret" }), " ", value, " ", copy, until);
}

function fileBlock(b: Extract<Block, { file: unknown }>["file"], h: Handlers): HTMLElement {
  const preview = el("div");
  const button = el("button", { textContent: "Download", className: "small" });
  button.onclick = async () => {
    button.disabled = true;
    try {
      const bytes = await h.download(b.file);
      preview.replaceChildren();
      const textual = ["txt", "md", "csv", "json"].includes(b.format) || /^text\/|\/json$/.test(b.file.mime);
      if (textual) preview.append(el("pre", { className: "preview", textContent: new TextDecoder().decode(bytes.subarray(0, 64 * 1024)) }));
      else if (/^image\/(png|jpeg|gif|webp)$/.test(b.file.mime)) preview.append(el("img", { src: URL.createObjectURL(new Blob([bytes as BlobPart], { type: b.file.mime })), className: "preview" }));
      // Anything else is offered to save, never opened.
      const save = el("a", { textContent: "Save", download: b.file.name, href: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" })) });
      preview.append(el("small", { textContent: "hash checked · " }), save);
    } catch (e) {
      preview.replaceChildren(el("small", { className: "bad", textContent: (e as Error).message }));
      button.disabled = false;
    }
  };
  return el("div", { className: "block" }, el("b", { textContent: b.title || b.file.name }), ` ${b.file.name} · ${b.format} · ${size(b.file.size)} `, button, preview);
}

function invoiceBlock(hex: string, h: Handlers): HTMLElement {
  const problem = h.invoiceProblem(hex);
  const { invoice } = decodeInvoice(hex);
  const pay = el("button", { textContent: "Pay", className: "small", disabled: problem !== null });
  pay.onclick = () => confirm(`Invoice from ${invoice.slug}: ${invoice.amount} base units of ${invoice.asset}\n${invoice.memo}\n\nThe simulator makes no payment.`);
  return el("div", { className: "block" }, el("b", { textContent: "Invoice" }), ` ${invoice.amount} base units of ${invoice.asset} · ${invoice.memo} `,
    problem ? el("span", { className: "bad", textContent: `refused: ${problem}` }) : pay);
}

export function renderBlock(b: Block, h: Handlers): HTMLElement {
  if ("text" in b) return el("div", { className: "block text", textContent: b.text.text });
  if ("fields" in b) return el("table", { className: "block" }, ...b.fields.rows.map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { textContent: v }))));
  if ("secret" in b) return secretBlock(b.secret);
  if ("file" in b) return fileBlock(b.file, h);
  if ("invoice" in b) return invoiceBlock(b.invoice.invoice, h);
  return el("div", { className: `block status s${b.status.state}`, textContent: `${STATES[b.status.state]}${b.status.text ? ": " + b.status.text : ""}` });
}

export function renderActions(actions: Action[], messageId: string, h: Handlers): HTMLElement {
  return el("div", { className: "actions" }, ...actions.map((a) => {
    const k = a.kind;
    // An update for the owner (22-grain-chats §4): Saltix draws it in its own words, for the grain's team only, and the
    // owner approves it in the publishing sheet with the PIN. The simulator only says so.
    if ("publish" in k) {
      let version = "?";
      try {
        version = String(readPublishText(k.publish.manifest).version);
      } catch {
        // The card's bounds were checked before it was shown.
      }
      return el("small", { className: "block", textContent: `App update available: v${version}. The owner approves it in Saltix (Review and approve).` });
    }
    const button = el("button", { textContent: a.label, className: "small" });
    button.onclick = () => ("run" in k ? h.run(k.run.command, k.run.args, messageId) : "open" in k ? h.open(k.open.start) : h.reply(k.reply.text, messageId));
    return button;
  }));
}

/** The intro, the commands and what the server keeps: what a wallet shows before the first action (§5). */
export function renderSpecCard(spec: GrainChatSpec, language: string, verified: string): HTMLElement {
  return el("div", {},
    el("div", { className: "mark", textContent: `${spec.slug} · ${verified} · spec v${spec.version}` }),
    el("p", { textContent: pick(spec.intro, language) }),
    el("ul", {}, ...spec.commands.map((c) => el("li", { textContent: `${pick(c.title, language)}${Object.keys(c.help).length ? " — " + pick(c.help, language) : ""} (free)` }))),
    el("small", { textContent: `The server keeps what you send ${spec.keeps === 0 ? "no longer than its answer" : `for ${spec.keeps} days`}; answers ${spec.ai ? "come from a language model" : "do not come from a language model"}.` }));
}

/** A form for `command`: its inputs, and what reads them back as arguments (or the name of the one that is wrong). */
export function renderForm(command: Command, language: string, prefill: ChatArgs): { form: HTMLElement; read(): Promise<ChatArgs | string>; files: Map<string, File> } {
  const inputs = new Map<string, () => ArgInput>();
  const files = new Map<string, File>();
  const rows = command.params.map((p) => {
    const before = prefill.find(([name]) => name === p.name)?.[1];
    const [input, read] = field(p.kind, language, before, (f) => (f ? files.set(p.name, f) : files.delete(p.name)));
    inputs.set(p.name, read);
    return el("label", {}, `${pick(p.title, language)}${p.required ? " *" : ""}`, input);
  });
  const form = el("div", { className: "form" }, el("b", { textContent: pick(command.title, language) }), ...rows);
  return {
    form, files,
    async read() {
      const args: ChatArgs = [];
      for (const p of command.params) {
        const raw = inputs.get(p.name)!();
        if (raw === null) {
          if (p.required) return p.name;
          continue;
        }
        if (raw instanceof File) continue; // uploaded when the request goes
        const value = valueOf(p.kind, raw);
        if (value === null || !takesValue(p.kind, value)) return p.name;
        args.push([p.name, value]);
      }
      return args.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    },
  };
}

type ArgInput = string | number | boolean | File | null;

/** What a form shows first for a `Run` action's value. */
function prefillOf(before: ChatValue | undefined): string {
  if (before === undefined) return "";
  if ("text" in before) return before.text;
  if ("number" in before) return before.number.toString();
  if ("choice" in before) return before.choice;
  if ("duration" in before) return String(before.duration);
  if ("date" in before) return dayToIso(before.date);
  if ("flag" in before) return before.flag ? "yes" : "";
  return "";
}

function field(kind: ParamKind, language: string, before: ChatValue | undefined, onFile: (f: File | null) => void): [HTMLElement, () => ArgInput] {
  if ("text" in kind) {
    const input: HTMLInputElement | HTMLTextAreaElement = kind.text.max > 80 ? el("textarea") : el("input");
    input.maxLength = kind.text.max;
    input.value = prefillOf(before);
    return [input, () => (input.value === "" ? null : input.value)];
  }
  if ("number" in kind) {
    const { min, max, decimals } = kind.number;
    const input = el("input", { inputMode: "decimal", placeholder: `${min}…${max}${decimals ? ` (units of 10^-${decimals})` : ""}` });
    input.value = prefillOf(before);
    return [input, () => (input.value.trim() === "" ? null : input.value.trim())];
  }
  if ("choice" in kind || "duration" in kind) {
    const select = el("select", {}, el("option", { value: "", textContent: "—" }));
    if ("choice" in kind) for (const o of kind.choice.options) select.append(el("option", { value: o.value, textContent: pick(o.title, language) }));
    else for (const d of kind.duration.options) select.append(el("option", { value: String(d), textContent: human(d) }));
    select.value = prefillOf(before);
    return [select, () => (select.value === "" ? null : "duration" in kind ? Number(select.value) : select.value)];
  }
  if ("date" in kind) {
    const input = el("input", { type: "date" });
    input.value = prefillOf(before);
    return [input, () => (input.value === "" ? null : input.value)];
  }
  if ("flag" in kind) {
    const input = el("input", { type: "checkbox", checked: prefillOf(before) === "yes" });
    return [input, () => input.checked];
  }
  const accept = kind.file.mimes.join(",");
  const input = el("input", { type: "file", accept });
  let chosen: File | null = null;
  input.onchange = () => {
    chosen = input.files?.[0] ?? null;
    onFile(chosen);
  };
  return [el("span", {}, input, el("small", { textContent: ` at most ${size(kind.file.max)}${accept ? `, ${accept}` : ""}` })), () => chosen];
}
