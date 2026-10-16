/**
 * How the simulator draws a grain's chat (Saltix 22-grain-chats §4–5), as a wallet does: natively, never as web
 * content, by the card standard (§5a) that every Saltix follows. Text is text (no markup), secrets are masked until
 * tapped and hidden after they expire, files are checked against the card's hash before they are shown and nothing is
 * opened as code; forms come from the spec.
 */
import { valueOf } from "../packages/server/src/chat-card";
import { CODE_LINES, TEXT_LINES, cardLayout, isImage, isToken, isWide, perRow, pollLook, shares } from "../packages/server/src/card-standard";
import {
  type ActionKind, type Block, type ChatArgs, type ChatMessage, type ChatValue, type Command, type GrainChatSpec, type ParamKind, type Texts,
  dayToIso, takesValue,
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
  /** A tap on an action or a poll's option (`key`: `a<index>` or `p<block>:<option>`): sent at once when it fills the
   *  command's form, else (or with `edit`, the long press) the form opens. */
  tap(key: string, kind: ActionKind, via: string, edit: boolean): void;
  open(start: string): void;
}

/** Where a tap on a card stands (22-grain-chats §5a): the tapped control's key, waiting for the answer (the card's
 *  controls wait too), answered, refused, or a minute without an answer (the card takes taps again). */
export interface TapState {
  key: string;
  phase: "waiting" | "done" | "refused" | "late";
}

const STATE_ICONS = ["◌", "✓", "⊘", "!"];

/** A long text or code collapsed past `lines` lines, with More / Less. */
function collapsible(node: HTMLElement, text: string, lines: number): HTMLElement {
  if (text.split("\n").length <= lines && text.length <= lines * 60) return node;
  node.classList.add("clamped");
  node.style.setProperty("--lines", String(lines));
  const more = el("button", { className: "link", textContent: "More" });
  more.onclick = () => {
    const open = node.classList.toggle("clamped");
    more.textContent = open ? "More" : "Less";
  };
  return el("div", {}, node, more);
}

function copyButton(text: () => string, label = "Copy"): HTMLButtonElement {
  const b = el("button", { className: "icon", textContent: "⧉", title: label, ariaLabel: label });
  b.onclick = () => void navigator.clipboard?.writeText(text());
  return b;
}

function secretBlock(b: Extract<Block, { secret: unknown }>["secret"]): HTMLElement {
  const value = el("span", { className: "mono secret-value", textContent: "•••• •••• ••••" });
  let shown = false;
  const expired = () => b.expires_at !== 0 && Date.now() >= b.expires_at;
  const show = el("button", { className: "icon", textContent: "👁", title: "Show", ariaLabel: "Show" });
  show.onclick = () => {
    shown = !shown && !expired();
    value.textContent = shown ? b.value : expired() ? "expired" : "•••• •••• ••••";
  };
  const copy = copyButton(() => (expired() ? "" : b.value));
  if (b.expires_at !== 0) {
    const hide = () => {
      value.textContent = "expired";
      copy.disabled = show.disabled = true;
    };
    if (expired()) hide();
    else setTimeout(hide, Math.min(b.expires_at - Date.now(), 2 ** 31 - 1));
  }
  const until = b.expires_at ? el("small", { className: "muted", textContent: `until ${new Date(b.expires_at).toLocaleString()}` }) : "";
  return el("div", { className: "block secret" }, el("small", { className: "muted", textContent: b.label || "Secret" }),
    el("div", { className: "line" }, value, show, copy), until);
}

function fileBlock(b: Extract<Block, { file: unknown }>["file"], h: Handlers): HTMLElement {
  const preview = el("div");
  const image = isImage(b.format) && /^image\/(png|jpeg|gif|webp)$/.test(b.file.mime);
  const save = el("button", { className: "icon", textContent: "⤓", title: image ? "Show" : "Save", ariaLabel: image ? "Show" : "Save" });
  const status = el("small", { className: "muted" });
  save.onclick = async () => {
    save.disabled = true;
    status.textContent = "downloading…";
    try {
      const bytes = await h.download(b.file);
      preview.replaceChildren();
      const textual = ["txt", "md", "csv", "json"].includes(b.format) || /^text\/|\/json$/.test(b.file.mime);
      if (textual) preview.append(el("pre", { className: "preview", textContent: new TextDecoder().decode(bytes.subarray(0, 64 * 1024)) }));
      else if (image) preview.append(el("img", { src: URL.createObjectURL(new Blob([bytes as BlobPart], { type: b.file.mime })), className: "image" }));
      // Anything else is offered to save, never opened.
      const link = el("a", { textContent: "Save", download: b.file.name, href: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" })) });
      status.replaceChildren("hash checked · ", link);
    } catch (e) {
      status.replaceChildren(el("span", { className: "bad", textContent: (e as Error).message }));
      save.disabled = false;
    }
  };
  const badge = el("span", { className: "badge", textContent: b.format.toUpperCase() });
  const tile = el("div", { className: "tile" }, badge,
    el("div", { className: "grow" }, el("div", { className: "title", textContent: b.title || b.file.name }),
      el("small", { className: "muted", textContent: `${b.format.toUpperCase()} · ${size(b.file.size)}` }), status), save);
  return el("div", { className: "block" }, tile, preview);
}

function invoiceBlock(hex: string, h: Handlers): HTMLElement {
  const problem = h.invoiceProblem(hex);
  const { invoice } = decodeInvoice(hex);
  const pay = el("button", { className: "btn primary", textContent: "Pay", disabled: problem !== null });
  pay.onclick = () => confirm(`Invoice from ${invoice.slug}: ${invoice.amount} base units of ${invoice.asset}\n${invoice.memo}\n\nThe simulator makes no payment.`);
  return el("div", { className: "block invoice" }, el("small", { className: "muted", textContent: "Invoice" }),
    el("div", { className: "amount", textContent: `${invoice.amount} base units of ${invoice.asset}` }), invoice.memo,
    problem ? el("div", { className: "bad", textContent: `refused: ${problem}` }) : pay);
}

/** A poll (22-grain-chats §5a): segmented when short, open and without a tally, else a list; shares as bars. */
function pollBlock(b: Extract<Block, { poll: unknown }>["poll"], index: number, via: string, h: Handlers, tap: TapState | null): HTMLElement {
  const look = pollLook(b.options, b.closed, b.tally);
  const percent = shares(b.options.map((o) => o.votes));
  const total = b.options.reduce((a, o) => a + o.votes, 0);
  const busy = tap?.phase === "waiting";
  const options = b.options.map((o, j) => {
    const key = `p${index}:${j}`;
    const mark = tap?.key === key ? phaseMark(tap.phase) : b.chosen === j ? "✓ " : "";
    const button = el("button", {
      className: `option${b.chosen === j ? " chosen" : ""}`, disabled: b.closed || busy,
      ariaLabel: `${o.label}${b.tally ? `, ${percent[j]} percent, ${o.votes} votes` : ""}${b.chosen === j ? ", your vote" : ""}`,
    });
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(b.chosen === j));
    if (look === "list" && b.tally) {
      const fill = el("span", { className: "fill" });
      fill.style.width = `${percent[j]}%`;
      button.append(fill,
        el("span", { className: "label", textContent: mark + o.label }), el("span", { className: "share", textContent: `${percent[j]}%` }));
    } else button.append(mark + o.label);
    button.onclick = () => h.tap(key, { run: { command: b.command, args: o.args } }, via, false);
    button.oncontextmenu = (e) => {
      e.preventDefault();
      h.tap(key, { run: { command: b.command, args: o.args } }, via, true);
    };
    return button;
  });
  const foot = [b.tally ? `${total} vote${total === 1 ? "" : "s"}` : "", b.closed ? "Closed" : ""].filter(Boolean).join(" · ");
  return el("div", { className: "block poll" }, el("div", { className: "question", textContent: b.question }),
    el("div", { className: look === "segmented" ? "segmented" : "options", role: "radiogroup" }, ...options),
    foot ? el("small", { className: "muted", textContent: foot }) : "");
}

function phaseMark(phase: TapState["phase"]): string {
  return phase === "waiting" ? "◌ " : phase === "done" ? "✓ " : phase === "refused" ? "⊘ " : "⏱ ";
}

function renderBlock(b: Block, index: number, via: string, h: Handlers, tap: TapState | null): HTMLElement {
  if ("text" in b) return el("div", { className: "block" }, collapsible(el("div", { className: "text", textContent: b.text.text }), b.text.text, TEXT_LINES));
  if ("fields" in b) {
    return el("div", { className: "block fields" }, ...b.fields.rows.map(([k, value]) => el("div", { className: "field" },
      el("span", { className: "muted", textContent: k }),
      isToken(value) ? el("span", { className: "line" }, el("span", { className: "mono", textContent: value }), copyButton(() => value)) : el("span", { textContent: value }))));
  }
  if ("secret" in b) return secretBlock(b.secret);
  if ("file" in b) return fileBlock(b.file, h);
  if ("invoice" in b) return invoiceBlock(b.invoice.invoice, h);
  if ("code" in b) {
    return el("div", { className: "block code" }, collapsible(el("pre", { className: "mono", textContent: b.code.text }), b.code.text, CODE_LINES),
      copyButton(() => b.code.text));
  }
  if ("poll" in b) return pollBlock(b.poll, index, via, h, tap);
  const state = b.status.state;
  return el("div", { className: `block status s${state}`, role: "status" }, el("span", { className: "dot", textContent: STATE_ICONS[state] ?? "" }),
    el("span", { textContent: b.status.text || STATES[state] || "" }));
}

/**
 * A message as every Saltix draws it (22-grain-chats §5a): the blocks in a capsule, the actions in a bar attached under
 * it — rows by the labels' length and the card's width, the first `run` filled, destructive commands red, a choice as
 * one segmented control, an `open` the app's own row — and the state of the last tap.
 */
export function renderCard(m: ChatMessage, mark: string, h: Handlers, tap: TapState | null, widthDp: number): HTMLElement {
  const capsule = el("div", { className: `capsule${isWide(m) ? " wide" : ""}` },
    el("div", { className: "mark", textContent: mark }), ...m.blocks.map((b, i) => renderBlock(b, i, m.id, h, tap)),
    el("div", { className: "foot", textContent: new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
  const layout = cardLayout(m.actions, perRow(widthDp));
  const busy = tap?.phase === "waiting";
  const button = (i: number, extra = "") => {
    const a = m.actions[i]!;
    const key = `a${i}`;
    const b = el("button", { className: `btn ${layout.emphasis[i]}${extra}`, disabled: busy && tap?.key !== key });
    const state = tap?.key === key ? phaseMark(tap.phase) : "";
    b.append(layout.emphasis[i] === "app" ? el("span", { className: "appicon", textContent: "▣" }) : "", state + a.label, layout.emphasis[i] === "app" ? el("span", { className: "chev", textContent: "›" }) : "");
    if (tap?.key === key && tap.phase === "waiting") b.setAttribute("aria-busy", "true");
    b.title = "run" in a.kind ? "Right-click to edit before sending" : "";
    b.onclick = () => ("open" in a.kind ? h.open(a.kind.open.start) : h.tap(key, a.kind, m.id, false));
    b.oncontextmenu = (e) => {
      if (!("run" in a.kind)) return;
      e.preventDefault();
      h.tap(key, a.kind, m.id, true);
    };
    return b;
  };
  const rows = layout.rows.map((row) => {
    if ("app" in row) return el("div", { className: "barrow" }, button(row.app));
    if ("choices" in row) {
      const picked = tap && row.choices.some((i) => tap.key === `a${i}`) && tap.phase !== "late" ? tap.key : null;
      return el("div", { className: "barrow segmented", role: "radiogroup" }, ...row.choices.map((i) => button(i, picked === `a${i}` ? " picked" : "")));
    }
    return el("div", { className: "barrow" }, ...row.buttons.map((i) => button(i)));
  });
  // A publish is the owner's panel, in the wallet's own words: the simulator only says so.
  const proposals = m.actions.filter((a) => "publish" in a.kind).map((a) => {
    let version = "?";
    try {
      version = String(readPublishText((a.kind as { publish: { manifest: string } }).publish.manifest).version);
    } catch {
      // The card's bounds were checked before it was shown.
    }
    return el("div", { className: "block owner", textContent: `App update available: v${version}. The owner approves it in Saltix (Review and approve).` });
  });
  proposals.forEach((p) => capsule.insertBefore(p, capsule.lastChild));
  return el("div", { className: `card${isWide(m) ? " wide" : ""}` }, capsule, ...(rows.length ? [el("div", { className: "bar" }, ...rows)] : []));
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
