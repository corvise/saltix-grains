// Grain chats (Saltix 22-grain-chats): a user and a grain's server talking in a 1:1 chat under the user's grain key.
// - `GrainChatSpec`: what the chat offers, signed by the manifest's owner key, or while every command is free by a
//   server key the grain's registry record names (§2, 24-app-studio §2);
// - `ChatRequest`: what the user sends, typed by the spec, signed by the user's grain key, with a member's proof for a
//   private grain (§3, 24-app-studio §2a) and the language the user reads;
// - `ChatMessage`: what the app answers, in blocks and actions, signed by a server key the owner certified or the
//   registry names (`ServerKey`, §4); an action may propose the grain's next manifest for its owner to approve
//   (`publish`);
// - `ChatFrame`: the plaintext of a sealed frame, "SGC1" ‖ Borsh: a request, a message, a newer spec, or the numbers the
//   app reports (24-app-studio §6a).
// Byte for byte the protocol's (vectors/grain-chats-v1.json), with every check its reference makes.
//
// No Node APIs here: the simulator runs it in a browser.
import { ed25519 } from "@noble/curves/ed25519";
import { type NetworkName, accountId, decodeAddress } from "./address.js";
import { Reader, Writer, compareUtf8, derive, fromHex, toHex } from "./bytes.js";
import { type FileRef, MAX_FILE_BYTES, fileRefProblem, readFileRef, writeFileRef } from "./file.js";
import { type InvoiceKeyCert, certMessage, decodeInvoice, readCertBody, readSignedInvoice, writeCertBody } from "./invoice.js";
import { type DeviceKey, verifyByDeviceKey } from "./keys.js";
import { type SignedMemberProof, readSignedMemberProof, writeSignedMemberProof } from "./member.js";
import { readPublishText } from "./publish.js";
import { type SignedGrainStats, readSignedGrainStats, writeSignedGrainStats } from "./stats.js";

export const CHAT_SPEC_DOMAIN = "Saltix grain chat spec v1";
export const CHAT_REQUEST_DOMAIN = "Saltix grain chat request v1";
export const CHAT_MESSAGE_DOMAIN = "Saltix grain chat message v1";
/** What a grain-chat frame's plaintext starts with (§4). */
export const CHAT_FRAME_MAGIC = new TextEncoder().encode("SGC1");
/** The longest server-key certificate a wallet takes for chat: 31 days, ms. */
export const CHAT_CERT_LIFE_MS = 31 * 86_400_000;
/** Borsh bytes of a chat spec at most. */
export const MAX_CHAT_SPEC = 32 * 1024;
/** Unasked messages, notifications included, a wallet shows per grain a day. */
export const CHAT_UNASKED_PER_DAY = 10;
/** The same to an account on the grain's team (its owner, developers and viewers, 22-grain-chats §4): error reports and
 *  feedback reach the people who build the app. */
export const CHAT_UNASKED_TEAM_PER_DAY = 100;
/** How long a request may live, ms. */
export const MAX_REQUEST_LIFE_MS = 7 * 86_400_000;
/** How old a message a wallet still shows may be, ms. */
export const MAX_MESSAGE_AGE_MS = 30 * 86_400_000;
/** How far ahead of the wallet's clock a message may be dated, ms. */
export const MESSAGE_AHEAD_MS = 5 * 60_000;
/** Plaintext bytes a frame may have (12-grains §5.4). */
export const MAX_FRAME_BYTES = 48_000;

/** The network a request or message is signed for: its genesis hash (hex) and its kind (for addresses). */
export interface ChainParams {
  genesis: string;
  network: NetworkName;
}

/** Texts by language code ("en" required where noted); Borsh writes them sorted by code. */
export type Texts = Record<string, string>;

export type ParamKind =
  | { text: { max: number } }
  | { number: { min: bigint; max: bigint; decimals: number } }
  | { choice: { options: Choice[] } }
  | { duration: { options: number[] } }
  | { date: Record<string, never> }
  | { file: { max: number; mimes: string[] } }
  | { flag: Record<string, never> };

export interface Choice {
  /** 1–32 of `[a-z0-9_-]`. */
  value: string;
  title: Texts;
}

export interface Param {
  /** 1–24 of `[a-z0-9_]`. */
  name: string;
  title: Texts;
  kind: ParamKind;
  required: boolean;
}

export interface Command {
  /** 1–24 of `[a-z0-9_]`, starting with a letter. */
  name: string;
  title: Texts;
  help: Texts;
  params: Param[];
  /** The wallet asks "Send?" before sending it. */
  confirm: boolean;
  /** µWORK the action costs: 0 in this version (§7). */
  price: bigint;
}

/** What a grain's chat offers (§2). */
export interface GrainChatSpec {
  slug: string;
  /** At least 1; a wallet keeps the highest it has seen and refuses lower. */
  version: number;
  /** What the chat does, shown before the user's first action. */
  intro: Texts;
  commands: Command[];
  /** Server keys (hex) a wallet no longer takes. */
  revoked: string[];
  /** Days the server keeps what users send it. */
  keeps: number;
  /** Whether answers come from a language model. */
  ai: boolean;
}

export interface SignedGrainChatSpec {
  spec: GrainChatSpec;
  /** Null: signed by the manifest's owner key. A key (hex): signed by that server key, one the grain's registry record
   *  names, which the spec may do only while every command's price is 0 (24-app-studio §2). */
  server: string | null;
  /** By the owner key (Ed25519, or a managed owner's phone's P-256) or by `server` (hex). */
  signature: string;
}

/** A value of a request's argument (§3). */
export type ChatValue =
  | { text: string }
  /** In units of `10^-decimals`. */
  | { number: bigint }
  | { choice: string }
  /** Seconds. */
  | { duration: number }
  /** Days since 1970-01-01. */
  | { date: number }
  | { file: FileRef }
  | { flag: boolean };

export type ChatArgs = Array<[string, ChatValue]>;

/** What the user sends (§3). Ids are 16 bytes of hex, times Unix ms. */
export interface ChatRequest {
  slug: string;
  id: string;
  at: number;
  /** After `at`, at most 7 days later: the server drops the request after that. */
  expires_at: number;
  /** The message whose action this request runs. */
  via: string | null;
  /** A command of the spec, or "" for text alone. */
  command: string;
  /** Sorted by name, each at most once. */
  args: ChatArgs;
  text: string;
  /** A private grain's member proof (24-app-studio §2a); null for a public grain. */
  member: SignedMemberProof | null;
  /** The language the user's Saltix shows, named as maps of texts name languages (2–8 of `[a-z-]`: "en", "ru",
   *  "pt-br"), or "" when the app does not say. Answer in it when you can, else in English; it says nothing else about
   *  the user. No reader takes another form (`requestLangOk`). */
  lang: string;
}

export interface SignedChatRequest {
  request: ChatRequest;
  /** The user's grain key (hex). */
  key: string;
  signature: string;
}

export const STATUS = { working: 0, done: 1, refused: 2, failed: 3 } as const;
export type StatusState = keyof typeof STATUS;

export type Block =
  | { text: { text: string } }
  | { fields: { rows: Array<[string, string]> } }
  /** `expires_at`: Unix ms, 0 for none. */
  | { secret: { label: string; value: string; expires_at: number } }
  | { file: { file: FileRef; title: string; format: string } }
  /** `invoice`: the hex of a signed invoice (`signInvoice`), 12-grains §5.2. */
  | { invoice: { invoice: string } }
  | { status: { state: number; text: string } };

export type ActionKind =
  /** A request the user may edit and send. */
  | { run: { command: string; args: ChatArgs } }
  /** Opens the grain's screen with `start` (12-grains §4). */
  | { open: { start: string } }
  /** Sends this text. */
  | { reply: { text: string } }
  /**
   * A new version of this grain's manifest for its owner to approve: the text of a publishing link (12-grains §10), its
   * slug the chat's, one a message. Wallets show it to the grain's team only, in their own words; the owner's tap opens
   * the publishing sheet (22-grain-chats §4).
   */
  | { publish: { manifest: string } };

export interface Action {
  label: string;
  kind: ActionKind;
}

/** What the app sends (§4). Ids are 16 bytes of hex, times Unix ms. */
export interface ChatMessage {
  slug: string;
  id: string;
  at: number;
  /** The request it answers; null: the app writes unasked. */
  answers: string | null;
  /** An earlier message of this chat it updates in place. */
  replaces: string | null;
  blocks: Block[];
  actions: Action[];
}

/** The server key a message is signed by (§1): one the owner key certified (12-grains §5.2), or one the grain's
 *  registry record names (24-app-studio §2), in hex. */
export type ServerKey = { certified: InvoiceKeyCert } | { registered: string };

/** The key of a `ServerKey`, hex. */
export const serverKeyOf = (server: ServerKey): string => ("certified" in server ? server.certified.key : server.registered);

export interface SignedChatMessage {
  message: ChatMessage;
  server: ServerKey;
  signature: string;
}

/** The plaintext of a grain-chat frame, after "SGC1" (§4). `spec` and `stats` go from the server to users only; a
 *  spec frame carries the server key's certificate when the grain's keys are certified rather than registered. */
export type ChatFrame =
  | { request: SignedChatRequest }
  | { message: SignedChatMessage }
  | { spec: { spec: SignedGrainChatSpec; cert: InvoiceKeyCert | null } }
  | { stats: SignedGrainStats };

/**
 * Why a check failed, as the reference names it: `slug`, `version`, `bounds:<what>` (`text`, `languages`, `intro`,
 * `choice`, `parameter kind`, `revoked`, `spec size`, `block`, `blocks and actions`, `action`), `language`, `name`,
 * `price`, `server_price` (a server key signed a spec with a price), `unknown_command`, `argument:<name>`, `time`,
 * `cert` (a key that does not speak for the grain), `signature`, `sender`.
 */
export type ChatProblem = string;

// ── text bounds ──

const chars = (text: string) => [...text].length;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** An unsigned integer of `bits` for Borsh, refused out of range (the `Writer` would wrap it). */
function uint(n: number, bits: 8 | 16 | 32, what: string): number {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** bits) throw new TypeError(`${what}: an integer from 0 to 2^${bits} - 1`);
  return n;
}

/** 1 Unicode scalar per character, as Rust counts them; a lone surrogate has no UTF-8 form and is never in bounds. */
function textOk(text: string, min: number, max: number): boolean {
  const n = chars(text);
  return n >= min && n <= max && !LONE_SURROGATE.test(text) && !/\p{Cc}/u.test(text);
}

/** Like `textOk`, with line breaks allowed. */
function longTextOk(text: string, min: number, max: number): boolean {
  const n = chars(text);
  return n >= min && n <= max && !LONE_SURROGATE.test(text) && !/[^\P{Cc}\n\r]/u.test(text);
}

const sortedKeys = (texts: Texts) => Object.keys(texts).sort(compareUtf8);

/** Whether `lang` names a language as maps of texts do: 2–8 of `[a-z-]`. */
const langOk = (lang: string) => /^[a-z-]{2,8}$/.test(lang);

/** Whether `lang` may be a request's language (§3): "", or 2–8 of `[a-z-]`. */
export const requestLangOk = (lang: string): boolean => lang === "" || langOk(lang);

function textsProblem(texts: Texts, maxChars: number, needsEn: boolean): ChatProblem | null {
  const keys = sortedKeys(texts);
  for (const lang of keys) {
    if (!langOk(lang)) return "language";
    if (!textOk(texts[lang]!, 1, maxChars)) return "bounds:text";
  }
  if (keys.length > 16 || (needsEn && !Object.hasOwn(texts, "en"))) return "bounds:languages";
  return null;
}

/** 1–24 of `[a-z0-9_]`, starting with a letter (`letterFirst`) or not. */
const nameOk = (name: string, letterFirst: boolean) => (letterFirst ? /^[a-z][a-z0-9_]{0,23}$/ : /^[a-z0-9_]{1,24}$/).test(name);
const choiceValueOk = (value: string) => /^[a-z0-9_-]{1,32}$/.test(value);
const unique = (names: string[]) => new Set(names).size === names.length;
const slugOk = (slug: string) => /^[a-z0-9][a-z0-9-]{2,31}$/.test(slug);
const ascending = (args: ChatArgs) => args.every((a, i) => i === 0 || compareUtf8(args[i - 1]![0], a[0]) < 0);
const utf8Length = (text: string) => new TextEncoder().encode(text).length;

function paramKindProblem(kind: ParamKind): ChatProblem | null {
  let ok: boolean;
  if ("text" in kind) ok = kind.text.max >= 1 && kind.text.max <= 2_000;
  else if ("number" in kind) ok = kind.number.min <= kind.number.max && kind.number.decimals <= 9;
  else if ("choice" in kind) {
    const options = kind.choice.options;
    if (options.length < 1 || options.length > 16 || !unique(options.map((o) => o.value))) ok = false;
    else {
      for (const option of options) {
        if (!choiceValueOk(option.value)) return "bounds:choice";
        const problem = textsProblem(option.title, 32, true);
        if (problem) return problem;
      }
      ok = true;
    }
  } else if ("duration" in kind) {
    const o = kind.duration.options;
    ok = o.length >= 1 && o.length <= 16 && o[0]! > 0 && o.every((d, i) => i === 0 || o[i - 1]! < d);
  } else if ("file" in kind) {
    const { max, mimes } = kind.file;
    ok = max >= 1 && max <= MAX_FILE_BYTES && mimes.length <= 8 && mimes.every((m) => m.length > 0 && utf8Length(m) <= 127 && m.includes("/"));
  } else ok = true; // date, flag
  return ok ? null : "bounds:parameter kind";
}

/** Whether `value` is of `kind` and within its bounds. */
export function takesValue(kind: ParamKind, value: ChatValue): boolean {
  if ("text" in kind && "text" in value) return longTextOk(value.text, 1, kind.text.max);
  if ("number" in kind && "number" in value) return kind.number.min <= value.number && value.number <= kind.number.max;
  if ("choice" in kind && "choice" in value) return kind.choice.options.some((o) => o.value === value.choice);
  if ("duration" in kind && "duration" in value) return kind.duration.options.includes(value.duration);
  if ("date" in kind && "date" in value) return true;
  if ("flag" in kind && "flag" in value) return true;
  if ("file" in kind && "file" in value) {
    const f = value.file;
    return fileRefProblem(f) === null && f.size <= kind.file.max && (kind.file.mimes.length === 0 || kind.file.mimes.includes(f.mime));
  }
  return false;
}

// ── Borsh ──

function writeTexts(w: Writer, texts: Texts): Writer {
  const keys = sortedKeys(texts);
  w.u32(keys.length);
  for (const k of keys) w.string(k).string(texts[k]!);
  return w;
}

/** A map of texts: keys strictly ascending, as they are written. (Rust's decoder would also take them unsorted and
 *  keep a repeated key's last text, then sign the sorted form; no signer writes that, so it is refused here.) */
function readTexts(r: Reader): Texts {
  const out: Texts = {};
  let last: string | null = null;
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    const key = r.string();
    if (last !== null && compareUtf8(last, key) >= 0) throw new TypeError("borsh: texts not sorted by language");
    out[key] = r.string();
    last = key;
  }
  return out;
}

function u64Safe(w: Writer, n: number): Writer {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("a u64 that is a time, a size or seconds: an integer from 0 to 2^53 - 1");
  return w.u64(n);
}

function writeParamKind(w: Writer, kind: ParamKind): void {
  if ("text" in kind) w.u8(0).u16(uint(kind.text.max, 16, "text max"));
  else if ("number" in kind) w.u8(1).i64(kind.number.min).i64(kind.number.max).u8(uint(kind.number.decimals, 8, "decimals"));
  else if ("choice" in kind) {
    w.u8(2).u32(kind.choice.options.length);
    for (const o of kind.choice.options) writeTexts(w.string(o.value), o.title);
  } else if ("duration" in kind) {
    w.u8(3).u32(kind.duration.options.length);
    for (const d of kind.duration.options) u64Safe(w, d);
  } else if ("date" in kind) w.u8(4);
  else if ("file" in kind) {
    u64Safe(w.u8(5), kind.file.max).u32(kind.file.mimes.length);
    for (const m of kind.file.mimes) w.string(m);
  } else if ("flag" in kind) w.u8(6);
  else throw new TypeError("a parameter's kind");
}

function readParamKind(r: Reader): ParamKind {
  switch (r.u8()) {
    case 0: return { text: { max: r.u16() } };
    case 1: return { number: { min: r.i64(), max: r.i64(), decimals: r.u8() } };
    case 2: return { choice: { options: r.vec((r) => ({ value: r.string(), title: readTexts(r) })) } };
    case 3: return { duration: { options: r.vec((r) => r.u64n()) } };
    case 4: return { date: {} };
    case 5: return { file: { max: r.u64n(), mimes: r.vec((r) => r.string()) } };
    case 6: return { flag: {} };
    default: throw new TypeError("borsh: a parameter kind's tag");
  }
}

function writeSpec(w: Writer, s: GrainChatSpec): Writer {
  writeTexts(w.string(s.slug).u32(uint(s.version, 32, "version")), s.intro);
  w.u32(s.commands.length);
  for (const c of s.commands) {
    writeTexts(writeTexts(w.string(c.name), c.title), c.help);
    w.u32(c.params.length);
    for (const p of c.params) {
      writeTexts(w.string(p.name), p.title);
      writeParamKind(w, p.kind);
      w.bool(p.required);
    }
    w.bool(c.confirm).u64(c.price);
  }
  w.u32(s.revoked.length);
  for (const k of s.revoked) w.fixed(fromHex(k, 32), 32);
  return w.u16(uint(s.keeps, 16, "keeps")).bool(s.ai);
}

function readSpec(r: Reader): GrainChatSpec {
  const slug = r.string();
  const version = r.u32();
  const intro = readTexts(r);
  const commands = r.vec((r): Command => {
    const name = r.string();
    const title = readTexts(r);
    const help = readTexts(r);
    const params = r.vec((r): Param => ({ name: r.string(), title: readTexts(r), kind: readParamKind(r), required: r.bool() }));
    return { name, title, help, params, confirm: r.bool(), price: r.u64() };
  });
  const revoked = r.vec((r) => toHex(r.fixed(32)));
  return { slug, version, intro, commands, revoked, keeps: r.u16(), ai: r.bool() };
}

export const encodeChatSpec = (s: GrainChatSpec): Uint8Array => writeSpec(new Writer(), s).done();

const key32 = (w: Writer, hex: string) => w.fixed(fromHex(hex, 32), 32);

function writeSignedSpec(w: Writer, s: SignedGrainChatSpec): Writer {
  return writeSpec(w, s.spec).option(s.server, key32).fixed(fromHex(s.signature, 64), 64);
}

function readSignedSpec(r: Reader): SignedGrainChatSpec {
  return { spec: readSpec(r), server: r.option((r) => toHex(r.fixed(32))), signature: toHex(r.fixed(64)) };
}

export const encodeSignedChatSpec = (s: SignedGrainChatSpec): Uint8Array => writeSignedSpec(new Writer(), s).done();

/** The Borsh (bytes or hex, as `/.well-known/saltix-grain-chat` serves it) of a signed spec, read back. */
export function decodeSignedChatSpec(bytes: Uint8Array | string): SignedGrainChatSpec {
  const r = new Reader(typeof bytes === "string" ? fromHex(bytes) : bytes);
  const s = readSignedSpec(r);
  r.end();
  return s;
}

function writeValue(w: Writer, v: ChatValue): void {
  if ("text" in v) w.u8(0).string(v.text);
  else if ("number" in v) w.u8(1).i64(v.number);
  else if ("choice" in v) w.u8(2).string(v.choice);
  else if ("duration" in v) u64Safe(w.u8(3), v.duration);
  else if ("date" in v) w.u8(4).u32(uint(v.date, 32, "date"));
  else if ("file" in v) writeFileRef(w.u8(5), v.file);
  else if ("flag" in v) w.u8(6).bool(v.flag);
  else throw new TypeError("a value's kind");
}

function readValue(r: Reader): ChatValue {
  switch (r.u8()) {
    case 0: return { text: r.string() };
    case 1: return { number: r.i64() };
    case 2: return { choice: r.string() };
    case 3: return { duration: r.u64n() };
    case 4: return { date: r.u32() };
    case 5: return { file: readFileRef(r) };
    case 6: return { flag: r.bool() };
    default: throw new TypeError("borsh: a value's tag");
  }
}

function writeArgs(w: Writer, args: ChatArgs): Writer {
  w.u32(args.length);
  for (const [name, value] of args) writeValue(w.string(name), value);
  return w;
}

const readArgs = (r: Reader): ChatArgs => r.vec((r) => [r.string(), readValue(r)]);
const id16 = (w: Writer, hex: string) => w.fixed(fromHex(hex, 16), 16);

function writeRequest(w: Writer, q: ChatRequest): Writer {
  u64Safe(u64Safe(id16(w.string(q.slug), q.id), q.at), q.expires_at).option(q.via, id16);
  return writeArgs(w.string(q.command), q.args).string(q.text).option(q.member, writeSignedMemberProof).string(q.lang);
}

/** A request's language, refused unless `requestLangOk`: no reader takes another, as none takes bytes that are not
 *  canonical. */
function readRequestLang(r: Reader): string {
  const lang = r.string();
  if (!requestLangOk(lang)) throw new TypeError("borsh: a request's language: \"\" or 2–8 of [a-z-]");
  return lang;
}

function readRequest(r: Reader): ChatRequest {
  return {
    slug: r.string(), id: toHex(r.fixed(16)), at: r.u64n(), expires_at: r.u64n(), via: r.option((r) => toHex(r.fixed(16))),
    command: r.string(), args: readArgs(r), text: r.string(), member: r.option(readSignedMemberProof), lang: readRequestLang(r),
  };
}

export const encodeChatRequest = (q: ChatRequest): Uint8Array => writeRequest(new Writer(), q).done();

function writeSignedRequest(w: Writer, s: SignedChatRequest): Writer {
  return writeRequest(w, s.request).fixed(fromHex(s.key, 32), 32).fixed(fromHex(s.signature, 64), 64);
}

function readSignedRequest(r: Reader): SignedChatRequest {
  return { request: readRequest(r), key: toHex(r.fixed(32)), signature: toHex(r.fixed(64)) };
}

export const encodeSignedChatRequest = (s: SignedChatRequest): Uint8Array => writeSignedRequest(new Writer(), s).done();

export function decodeSignedChatRequest(bytes: Uint8Array): SignedChatRequest {
  const r = new Reader(bytes);
  const s = readSignedRequest(r);
  r.end();
  return s;
}

function writeBlock(w: Writer, b: Block): void {
  if ("text" in b) w.u8(0).string(b.text.text);
  else if ("fields" in b) {
    w.u8(1).u32(b.fields.rows.length);
    for (const [label, value] of b.fields.rows) w.string(label).string(value);
  } else if ("secret" in b) u64Safe(w.u8(2).string(b.secret.label).string(b.secret.value), b.secret.expires_at);
  else if ("file" in b) writeFileRef(w.u8(3), b.file.file).string(b.file.title).string(b.file.format);
  else if ("invoice" in b) w.u8(4).raw(fromHex(b.invoice.invoice));
  else if ("status" in b) w.u8(5).u8(uint(b.status.state, 8, "state")).string(b.status.text);
  else throw new TypeError("a block's kind");
}

function readBlock(r: Reader): Block {
  switch (r.u8()) {
    case 0: return { text: { text: r.string() } };
    case 1: return { fields: { rows: r.vec((r): [string, string] => [r.string(), r.string()]) } };
    case 2: return { secret: { label: r.string(), value: r.string(), expires_at: r.u64n() } };
    case 3: return { file: { file: readFileRef(r), title: r.string(), format: r.string() } };
    case 4: {
      const start = r.position;
      readSignedInvoice(r);
      return { invoice: { invoice: toHex(r.since(start)) } };
    }
    case 5: return { status: { state: r.u8(), text: r.string() } };
    default: throw new TypeError("borsh: a block's tag");
  }
}

function writeAction(w: Writer, a: Action): void {
  w.string(a.label);
  const k = a.kind;
  if ("run" in k) writeArgs(w.u8(0).string(k.run.command), k.run.args);
  else if ("open" in k) w.u8(1).string(k.open.start);
  else if ("reply" in k) w.u8(2).string(k.reply.text);
  else if ("publish" in k) w.u8(3).string(k.publish.manifest);
  else throw new TypeError("an action's kind");
}

function readAction(r: Reader): Action {
  const label = r.string();
  switch (r.u8()) {
    case 0: return { label, kind: { run: { command: r.string(), args: readArgs(r) } } };
    case 1: return { label, kind: { open: { start: r.string() } } };
    case 2: return { label, kind: { reply: { text: r.string() } } };
    case 3: return { label, kind: { publish: { manifest: r.string() } } };
    default: throw new TypeError("borsh: an action's tag");
  }
}

function writeMessage(w: Writer, m: ChatMessage): Writer {
  u64Safe(id16(w.string(m.slug), m.id), m.at).option(m.answers, id16).option(m.replaces, id16);
  w.u32(m.blocks.length);
  m.blocks.forEach((b) => writeBlock(w, b));
  w.u32(m.actions.length);
  m.actions.forEach((a) => writeAction(w, a));
  return w;
}

function readMessage(r: Reader): ChatMessage {
  return {
    slug: r.string(), id: toHex(r.fixed(16)), at: r.u64n(), answers: r.option((r) => toHex(r.fixed(16))),
    replaces: r.option((r) => toHex(r.fixed(16))), blocks: r.vec(readBlock), actions: r.vec(readAction),
  };
}

export const encodeChatMessage = (m: ChatMessage): Uint8Array => writeMessage(new Writer(), m).done();

function writeServerKey(w: Writer, server: ServerKey): Writer {
  if ("certified" in server) return writeCertBody(w.u8(0), server.certified);
  if ("registered" in server) return key32(w.u8(1), server.registered);
  throw new TypeError("a server key: certified or registered");
}

function readServerKey(r: Reader): ServerKey {
  switch (r.u8()) {
    case 0: return { certified: readCertBody(r) };
    case 1: return { registered: toHex(r.fixed(32)) };
    default: throw new TypeError("borsh: a server key's tag");
  }
}

function writeSignedMessage(w: Writer, s: SignedChatMessage): Writer {
  return writeServerKey(writeMessage(w, s.message), s.server).fixed(fromHex(s.signature, 64), 64);
}

function readSignedMessage(r: Reader): SignedChatMessage {
  return { message: readMessage(r), server: readServerKey(r), signature: toHex(r.fixed(64)) };
}

export const encodeSignedChatMessage = (s: SignedChatMessage): Uint8Array => writeSignedMessage(new Writer(), s).done();

export function decodeSignedChatMessage(bytes: Uint8Array): SignedChatMessage {
  const r = new Reader(bytes);
  const s = readSignedMessage(r);
  r.end();
  return s;
}

/** The frame's plaintext: "SGC1" then its Borsh. */
export function encodeChatFrame(frame: ChatFrame): Uint8Array {
  const w = new Writer().raw(CHAT_FRAME_MAGIC);
  if ("request" in frame) writeSignedRequest(w.u8(0), frame.request);
  else if ("message" in frame) writeSignedMessage(w.u8(1), frame.message);
  else if ("spec" in frame) writeSignedSpec(w.u8(2), frame.spec.spec).option(frame.spec.cert, writeCertBody);
  else if ("stats" in frame) writeSignedGrainStats(w.u8(3), frame.stats);
  else throw new TypeError("a frame's kind");
  return w.done();
}

/** Read a frame's plaintext, at most `MAX_FRAME_BYTES`; throws a `TypeError` for anything that is not a grain-chat
 *  frame. */
export function decodeChatFrame(bytes: Uint8Array): ChatFrame {
  if (bytes.length > MAX_FRAME_BYTES || bytes.length < 4 || !CHAT_FRAME_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new TypeError("not a grain-chat frame");
  }
  const r = new Reader(bytes.subarray(4));
  let frame: ChatFrame;
  switch (r.u8()) {
    case 0: frame = { request: readSignedRequest(r) }; break;
    case 1: frame = { message: readSignedMessage(r) }; break;
    case 2: frame = { spec: { spec: readSignedSpec(r), cert: r.option(readCertBody) } }; break;
    case 3: frame = { stats: readSignedGrainStats(r) }; break;
    default: throw new TypeError("not a grain-chat frame");
  }
  r.end();
  return frame;
}

// ── the spec (§2) ──

/** What is out of bounds in `s` (§2), or null; in the reference's order. */
export function chatSpecProblem(s: GrainChatSpec): ChatProblem | null {
  if (!slugOk(s.slug)) return "slug";
  if (!Number.isInteger(s.version) || s.version < 1 || s.version > 0xffffffff) return "version";
  const intro = textsProblem(s.intro, 300, true);
  if (intro) return intro;
  if (Object.keys(s.intro).length === 0) return "bounds:intro";
  if (s.commands.length > 32 || !unique(s.commands.map((c) => c.name))) return "name";
  for (const c of s.commands) {
    if (!nameOk(c.name, true)) return "name";
    const texts = textsProblem(c.title, 32, true) ?? textsProblem(c.help, 120, false);
    if (texts) return texts;
    if (c.params.length > 8 || !unique(c.params.map((p) => p.name))) return "name";
    for (const p of c.params) {
      if (!nameOk(p.name, false)) return "name";
      const problem = textsProblem(p.title, 32, true) ?? paramKindProblem(p.kind);
      if (problem) return problem;
    }
    if (c.price !== 0n) return "price";
  }
  if (s.revoked.length > 16) return "bounds:revoked";
  if (encodeChatSpec(s).length > MAX_CHAT_SPEC) return "bounds:spec size";
  return null;
}

/** What the owner key or a server key signs: the spec's Borsh under its domain (no genesis hash: a spec is the
 *  grain's, on every network it is registered in). */
export const chatSpecToSign = (s: GrainChatSpec): Uint8Array => derive(CHAT_SPEC_DOMAIN, encodeChatSpec(s));

/** `s`, checked, signed with the owner key's Ed25519 secret (`grain chat-spec`). A managed owner's phone signs with
 *  P-256 in its wallet. */
export function signChatSpec(s: GrainChatSpec, ownerSecret: Uint8Array): SignedGrainChatSpec {
  const problem = chatSpecProblem(s);
  if (problem) throw new TypeError(`chat spec: ${problem}`);
  return { spec: s, server: null, signature: toHex(ed25519.sign(chatSpecToSign(s), ownerSecret)) };
}

/** `s`, checked, signed with a server key the grain's registry record names (24-app-studio §2): a spec whose commands
 *  are all free, which a developer changes without the owner's phone. */
export function signChatSpecAsServer(s: GrainChatSpec, serverSecret: Uint8Array): SignedGrainChatSpec {
  if (s.commands.some((c) => c.price !== 0n)) throw new TypeError("chat spec: a server key signs a spec whose commands are all free; a price needs the owner key");
  const problem = chatSpecProblem(s);
  if (problem) throw new TypeError(`chat spec: ${problem}`);
  return { spec: s, server: toHex(ed25519.getPublicKey(serverSecret)), signature: toHex(ed25519.sign(chatSpecToSign(s), serverSecret)) };
}

/**
 * Why a wallet would refuse `signed` as `slug`'s chat spec (§2), or null, in the reference's order: for `slug`; signed
 * by the manifest's `ownerKey`, or by a key of `servers` (the grain's registry record's, hex) that the spec does not
 * revoke while every command is free (`cert` otherwise, `server_price` for a price); in bounds; and the signature holds.
 * Whether the owner key still speaks for the owner, and whether the version is new enough, are the wallet's to check
 * against the registry and what it holds.
 */
export function signedChatSpecProblem(signed: SignedGrainChatSpec, slug: string, ownerKey: DeviceKey, servers: readonly string[] = []): ChatProblem | null {
  if (signed.spec.slug !== slug) return "slug";
  const message = chatSpecToSign(signed.spec);
  let ok: boolean;
  if (signed.server === null) ok = verifyByDeviceKey(ownerKey, message, signed.signature);
  else {
    if (!servers.includes(signed.server) || signed.spec.revoked.includes(signed.server)) return "cert";
    if (signed.spec.commands.some((c) => c.price !== 0n)) return "server_price";
    ok = verifies(signed.server, message, signed.signature);
  }
  const problem = chatSpecProblem(signed.spec);
  if (problem) return problem;
  return ok ? null : "signature";
}

/** Whether `server` may speak in `slug`'s chat at `now` (§1): a certificate that holds (`chatCertHolds`), or a key of
 *  `servers`, the grain's registry record's at the wallet's canonical beacon block; either not revoked by `spec`. */
export function serverKeyHolds(server: ServerKey, slug: string, ownerKey: DeviceKey, servers: readonly string[], spec: GrainChatSpec, now: number): boolean {
  if ("certified" in server) return chatCertHolds(server.certified, slug, ownerKey, spec, now);
  return servers.includes(server.registered) && !spec.revoked.includes(server.registered);
}

/** Whether `cert` lets its key speak in `slug`'s chat at `now` (§1): signed by `ownerKey`, unexpired, ending within
 *  `CHAT_CERT_LIFE_MS`, not revoked by `spec`. */
export function chatCertHolds(cert: InvoiceKeyCert, slug: string, ownerKey: DeviceKey, spec: GrainChatSpec, now: number): boolean {
  return cert.slug === slug &&
    cert.expires_at > now &&
    cert.expires_at <= now + CHAT_CERT_LIFE_MS &&
    !spec.revoked.includes(cert.key) &&
    verifyByDeviceKey(ownerKey, certMessage(cert.slug, fromHex(cert.key, 32), cert.expires_at), cert.signature);
}

/** The command of `spec` named `name`. */
export const commandOf = (spec: GrainChatSpec, name: string): Command | undefined => spec.commands.find((c) => c.name === name);

// ── requests (§3) ──

function argsProblem(command: Command, args: ChatArgs): ChatProblem | null {
  if (!ascending(args)) return `argument:${args[0]?.[0] ?? ""}`;
  for (const [name, value] of args) {
    const param = command.params.find((p) => p.name === name);
    if (!param || !takesValue(param.kind, value)) return `argument:${name}`;
  }
  for (const p of command.params) if (p.required && !args.some(([name]) => name === p.name)) return `argument:${p.name}`;
  return null;
}

/** Whether `q` fits `spec` (§3): a command it has, with every required argument and nothing else, each of its kind
 *  and within its bounds; or text alone. Its language is "" or a language code. The problem, or null. */
export function requestFitProblem(q: ChatRequest, spec: GrainChatSpec): ChatProblem | null {
  if (q.slug !== spec.slug) return "slug";
  if (typeof q.lang !== "string" || !requestLangOk(q.lang)) return "language";
  if (q.command === "") return q.args.length > 0 || !longTextOk(q.text, 1, 2_000) ? "bounds:text" : null;
  const command = commandOf(spec, q.command);
  if (!command) return "unknown_command";
  if (!longTextOk(q.text, 0, 2_000)) return "bounds:text";
  return argsProblem(command, q.args);
}

/** Whether `now` is within `q`'s life: after `at` (5 minutes of skew taken), before `expires_at`, at most 7 days long. */
export function requestLive(q: ChatRequest, now: number): boolean {
  return q.expires_at > q.at && q.expires_at - q.at <= MAX_REQUEST_LIFE_MS && now < q.expires_at && q.at <= now + MESSAGE_AHEAD_MS;
}

/** What the user's grain key signs: the request on the network of `genesis` (hex). */
export const chatRequestToSign = (q: ChatRequest, genesis: string): Uint8Array =>
  derive(CHAT_REQUEST_DOMAIN, fromHex(genesis, 32), encodeChatRequest(q));

/** `q` signed by the user's grain key (`grainSecret`, Ed25519): what a wallet sends. For tests and TypeScript clients. */
export function signChatRequest(q: ChatRequest, grainSecret: Uint8Array, genesis: string): SignedChatRequest {
  return { request: q, key: toHex(ed25519.getPublicKey(grainSecret)), signature: toHex(ed25519.sign(chatRequestToSign(q, genesis), grainSecret)) };
}

/** Whether `address` is the personal address (kind 0) of `key` (hex) on `network`. */
export function isPersonalAddressOf(address: string, key: string, network: NetworkName): boolean {
  const decoded = decodeAddress(address);
  if (!decoded || decoded.kind !== 0 || decoded.network !== network) return false;
  const id = accountId(fromHex(key, 32));
  return id.every((b, i) => b === decoded.id[i]);
}

function verifies(key: string, message: Uint8Array, signature: string): boolean {
  try {
    return ed25519.verify(fromHex(signature, 64), message, fromHex(key, 32));
  } catch {
    return false;
  }
}

/**
 * What a server checks of a request before it takes it (§3), in the reference's order: the frame came from the
 * signing key's personal address `from` (the relay's word, which sealing backs: the frame opened with that address's
 * key), the signature holds on this chain, the request lives at `now`, and it fits `spec`. The problem, or null.
 */
export function chatRequestProblem(
  s: SignedChatRequest,
  check: { chain: ChainParams; spec: GrainChatSpec; from: string; now: number },
): ChatProblem | null {
  if (!isPersonalAddressOf(check.from, s.key, check.chain.network)) return "sender";
  if (!verifies(s.key, chatRequestToSign(s.request, check.chain.genesis), s.signature)) return "signature";
  if (!requestLive(s.request, check.now)) return "time";
  return requestFitProblem(s.request, check.spec);
}

// ── messages (§4) ──

function blockOk(b: Block, slug: string): boolean {
  if ("text" in b) return longTextOk(b.text.text, 1, 4_000);
  if ("fields" in b) {
    const rows = b.fields.rows;
    return rows.length >= 1 && rows.length <= 16 && rows.every(([label, value]) => textOk(label, 1, 40) && textOk(value, 1, 200));
  }
  if ("secret" in b) return textOk(b.secret.label, 0, 40) && textOk(b.secret.value, 1, 256);
  if ("file" in b) return fileRefProblem(b.file.file) === null && textOk(b.file.title, 0, 80) && /^[a-z0-9]{1,16}$/.test(b.file.format);
  if ("invoice" in b) {
    try {
      return decodeInvoice(b.invoice.invoice).invoice.slug === slug;
    } catch {
      return false;
    }
  }
  if ("status" in b) return b.status.state <= STATUS.failed && textOk(b.status.text, 0, 200);
  return false;
}

function actionOk(a: Action): boolean {
  if (!textOk(a.label, 1, 32)) return false;
  const k = a.kind;
  if ("run" in k) return nameOk(k.run.command, true) && ascending(k.run.args);
  if ("open" in k) return /^[A-Za-z0-9_-]{1,64}$/.test(k.open.start);
  if ("reply" in k) return textOk(k.reply.text, 1, 200);
  // Read whole, with the message's slug, by `chatMessageBoundsProblem`.
  if ("publish" in k) return typeof k.publish.manifest === "string";
  return false;
}

/** The manifest text `m` proposes for the owner to approve (its `publish` action's), or null. */
export const proposedManifest = (m: ChatMessage): string | null => {
  for (const a of m.actions) if ("publish" in a.kind) return a.kind.publish.manifest;
  return null;
};

/** Whether wallets show `m` only to an account on the grain's team: it proposes an update (§4). */
export const teamOnly = (m: ChatMessage): boolean => proposedManifest(m) !== null;

/** What is out of bounds in `m` (§4), or null. An invoice must be this grain's; its signature is the payment sheet's to
 *  check (12-grains §5.2). A `publish` action, one at most, carries a manifest that reads (`readPublishText`) and is
 *  this grain's (`slug` otherwise): the whole message is refused, never shown without it. */
export function chatMessageBoundsProblem(m: ChatMessage): ChatProblem | null {
  if (!slugOk(m.slug)) return "slug";
  if (m.blocks.length < 1 || m.blocks.length > 16 || m.actions.length > 8) return "bounds:blocks and actions";
  if (!m.blocks.every((b) => blockOk(b, m.slug))) return "bounds:block";
  const proposals = m.actions.filter((a) => "publish" in a.kind);
  if (proposals.length > 1) return "bounds:action";
  for (const a of proposals) {
    let slug: string;
    try {
      slug = readPublishText((a.kind as { publish: { manifest: string } }).publish.manifest).slug;
    } catch {
      return "bounds:action";
    }
    // An update of another grain is never proposed in this chat: its owner would approve what the card's sender does
    // not speak for.
    if (slug !== m.slug) return "slug";
  }
  if (!m.actions.every(actionOk)) return "bounds:action";
  return null;
}

/** Whether a wallet whose clock reads `now` shows `m`: at most 5 minutes ahead, at most 30 days old. */
export const messageTimely = (m: ChatMessage, now: number): boolean => m.at <= now + MESSAGE_AHEAD_MS && now - m.at <= MAX_MESSAGE_AGE_MS;

/** What the server key signs: the message on the network of `genesis` (hex). */
export const chatMessageToSign = (m: ChatMessage, genesis: string): Uint8Array =>
  derive(CHAT_MESSAGE_DOMAIN, fromHex(genesis, 32), encodeChatMessage(m));

/** `m`, checked, signed with the server key `serverSecret` for the network of `genesis`: under the certificate `cert`
 *  for that key, or without one as a key the grain's registry record names (`ServerKey::Registered`). */
export function signChatMessage(m: ChatMessage, serverSecret: Uint8Array, genesis: string, cert?: InvoiceKeyCert | null): SignedChatMessage {
  const problem = chatMessageBoundsProblem(m);
  if (problem) throw new TypeError(`chat message: ${problem}`);
  const key = toHex(ed25519.getPublicKey(serverSecret));
  if (cert && key !== cert.key) throw new TypeError("the certificate is not the server key's");
  const server: ServerKey = cert ? { certified: cert } : { registered: key };
  return { message: m, server, signature: toHex(ed25519.sign(chatMessageToSign(m, genesis), serverSecret)) };
}

/**
 * What a wallet checks before it shows a message (§4), in the reference's order: the grain's slug, it came from the
 * server key's personal address `from`, the key speaks for the grain (`serverKeyHolds`: a certificate of the owner key,
 * unexpired, within 31 days; or one of `servers`, the registry record's server keys at the wallet's canonical beacon
 * block; either not revoked by the spec), the message is in bounds, timely at `now`, and signed. Whether it answers a
 * request or counts as unasked is the wallet's to judge. The problem, or null.
 */
export function chatMessageProblem(
  s: SignedChatMessage,
  check: { chain: ChainParams; ownerKey: DeviceKey; servers?: readonly string[]; spec: GrainChatSpec; from: string; now: number },
): ChatProblem | null {
  if (s.message.slug !== check.spec.slug) return "slug";
  const key = serverKeyOf(s.server);
  if (!isPersonalAddressOf(check.from, key, check.chain.network)) return "sender";
  if (!serverKeyHolds(s.server, check.spec.slug, check.ownerKey, check.servers ?? [], check.spec, check.now)) return "cert";
  const bounds = chatMessageBoundsProblem(s.message);
  if (bounds) return bounds;
  if (!messageTimely(s.message, check.now)) return "time";
  return verifies(key, chatMessageToSign(s.message, check.chain.genesis), s.signature) ? null : "signature";
}

/** 16 random bytes in hex: a request's or a message's id. */
export function newChatId(): string {
  return toHex((globalThis as { crypto: Crypto }).crypto.getRandomValues(new Uint8Array(16)));
}

/** The calendar day (UTC) `days` after 1970-01-01, as `YYYY-MM-DD`: how a `Date` argument reads. */
export function dayToIso(days: number): string {
  return new Date(days * 86_400_000).toISOString().slice(0, 10);
}

/** The days since 1970-01-01 of a `YYYY-MM-DD` day, or null. */
export function isoToDay(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(ms) || ms < 0 || new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  const days = ms / 86_400_000;
  return days <= 0xffffffff ? days : null;
}

/** The `/.well-known/saltix-grain-chat` document (§2): `{spec, cert?, stats?}` in hex of their Borsh. `cert`, the
 *  current server key's certificate when it has one; `stats`, the numbers the app reports (24-app-studio §6a). */
export interface ChatDocument {
  spec: string;
  cert?: string;
  stats?: string;
}

export function chatDocumentOf(spec: SignedGrainChatSpec, cert?: InvoiceKeyCert | null, stats?: SignedGrainStats | null): ChatDocument {
  const doc: ChatDocument = { spec: toHex(encodeSignedChatSpec(spec)) };
  if (cert) doc.cert = toHex(writeCertBody(new Writer(), cert).done());
  if (stats) doc.stats = toHex(writeSignedGrainStats(new Writer(), stats).done());
  return doc;
}

/** The document read back as a wallet reads it: `cert` and `stats` absent or null when there are none. Throws a
 *  `TypeError` for anything else. */
export function decodeChatDocument(value: unknown): { spec: SignedGrainChatSpec; cert: InvoiceKeyCert | null; stats: SignedGrainStats | null } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("a chat document is an object");
  const doc = value as Record<string, unknown>;
  const hex = (name: string, required: boolean): string | null => {
    const v = doc[name];
    if (v === undefined || v === null) {
      if (required) throw new TypeError(`a chat document's ${name}: missing`);
      return null;
    }
    if (typeof v !== "string") throw new TypeError(`a chat document's ${name}: hex expected`);
    return v;
  };
  const spec = decodeSignedChatSpec(hex("spec", true)!);
  const cert = hex("cert", false);
  const stats = hex("stats", false);
  const certOf = (h: string) => {
    const r = new Reader(fromHex(h));
    const c = readCertBody(r);
    r.end();
    return c;
  };
  const statsOf = (h: string) => {
    const r = new Reader(fromHex(h));
    const s = readSignedGrainStats(r);
    r.end();
    return s;
  };
  return { spec, cert: cert === null ? null : certOf(cert), stats: stats === null ? null : statsOf(stats) };
}

// ── the JSON form a developer writes a spec in (`grain chat-spec`) ──

type Json = Record<string, unknown>;

function object(value: unknown, at: string, keys: { required: string[]; optional?: string[] }): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${at}: an object expected`);
  const o = value as Json;
  const known = new Set([...keys.required, ...(keys.optional ?? [])]);
  for (const k of Object.keys(o)) if (!known.has(k)) throw new TypeError(`${at}.${k}: not a field of the chat spec`);
  for (const k of keys.required) if (o[k] === undefined) throw new TypeError(`${at}.${k}: missing`);
  return o;
}

const jsonText = (v: unknown, at: string): string => {
  if (typeof v !== "string") throw new TypeError(`${at}: a string expected`);
  return v;
};
const jsonInt = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new TypeError(`${at}: an integer expected`);
  return v;
};
const jsonBool = (v: unknown, at: string, fallback?: boolean): boolean => {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "boolean") throw new TypeError(`${at}: true or false expected`);
  return v;
};
const jsonBig = (v: unknown, at: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new TypeError(`${at}: an integer (or a string of one) expected`);
};
const jsonList = (v: unknown, at: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new TypeError(`${at}: a list expected`);
  return v;
};
function jsonTexts(v: unknown, at: string): Texts {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError(`${at}: texts by language expected`);
  const out: Texts = {};
  for (const [lang, text] of Object.entries(v)) out[lang] = jsonText(text, `${at}.${lang}`);
  return out;
}

function kindFromJson(v: unknown, at: string): ParamKind {
  if (v === "date" || v === "flag") return v === "date" ? { date: {} } : { flag: {} };
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).length !== 1) {
    throw new TypeError(`${at}: one of text, number, choice, duration, date, file, flag`);
  }
  const [name, body] = Object.entries(v)[0]!;
  const k = `${at}.${name}`;
  switch (name) {
    case "text": return { text: { max: jsonInt(object(body, k, { required: ["max"] }).max, `${k}.max`) } };
    case "number": {
      const o = object(body, k, { required: ["min", "max"], optional: ["decimals"] });
      return { number: { min: jsonBig(o.min, `${k}.min`), max: jsonBig(o.max, `${k}.max`), decimals: o.decimals === undefined ? 0 : jsonInt(o.decimals, `${k}.decimals`) } };
    }
    case "choice": {
      const o = object(body, k, { required: ["options"] });
      return {
        choice: {
          options: jsonList(o.options, `${k}.options`).map((c, i) => {
            const co = object(c, `${k}.options[${i}]`, { required: ["value", "title"] });
            return { value: jsonText(co.value, `${k}.options[${i}].value`), title: jsonTexts(co.title, `${k}.options[${i}].title`) };
          }),
        },
      };
    }
    case "duration": {
      const o = object(body, k, { required: ["options"] });
      return { duration: { options: jsonList(o.options, `${k}.options`).map((d, i) => jsonInt(d, `${k}.options[${i}]`)) } };
    }
    case "date": object(body, k, { required: [] }); return { date: {} };
    case "flag": object(body, k, { required: [] }); return { flag: {} };
    case "file": {
      const o = object(body, k, { required: ["max"], optional: ["mimes"] });
      return { file: { max: jsonInt(o.max, `${k}.max`), mimes: jsonList(o.mimes, `${k}.mimes`).map((m, i) => jsonText(m, `${k}.mimes[${i}]`)) } };
    }
    default: throw new TypeError(`${at}: one of text, number, choice, duration, date, file, flag`);
  }
}

/**
 * A spec from its JSON form: the fields of `GrainChatSpec`, with `help`, `params`, `confirm`, `price`, `required` and
 * `revoked` optional (empty, false, 0); `keeps` and `ai` stated always, since the wallet shows them before the first
 * action. A kind is `{"text": {"max": 40}}`, `{"number": {"min": 1, "max": 100, "decimals": 0}}`,
 * `{"choice": {"options": [{"value", "title"}]}}`, `{"duration": {"options": [600, 86400]}}`, `"date"`,
 * `{"file": {"max": 1048576, "mimes": ["text/csv"]}}` or `"flag"`. Unknown fields are refused, so a typo is not
 * silently a default. Bounds are `chatSpecProblem`'s to check.
 */
export function chatSpecFromJson(value: unknown): GrainChatSpec {
  const o = object(value, "spec", { required: ["slug", "version", "intro", "commands", "keeps", "ai"], optional: ["revoked"] });
  return {
    slug: jsonText(o.slug, "slug"),
    version: jsonInt(o.version, "version"),
    intro: jsonTexts(o.intro, "intro"),
    commands: jsonList(o.commands, "commands").map((c, i) => {
      const at = `commands[${i}]`;
      const co = object(c, at, { required: ["name", "title"], optional: ["help", "params", "confirm", "price"] });
      return {
        name: jsonText(co.name, `${at}.name`),
        title: jsonTexts(co.title, `${at}.title`),
        help: jsonTexts(co.help, `${at}.help`),
        params: jsonList(co.params, `${at}.params`).map((p, j) => {
          const pat = `${at}.params[${j}]`;
          const po = object(p, pat, { required: ["name", "title", "kind"], optional: ["required"] });
          return { name: jsonText(po.name, `${pat}.name`), title: jsonTexts(po.title, `${pat}.title`), kind: kindFromJson(po.kind, `${pat}.kind`), required: jsonBool(po.required, `${pat}.required`, false) };
        }),
        confirm: jsonBool(co.confirm, `${at}.confirm`, false),
        price: co.price === undefined ? 0n : jsonBig(co.price, `${at}.price`),
      };
    }),
    revoked: jsonList(o.revoked, "revoked").map((k, i) => {
      const key = jsonText(k, `revoked[${i}]`);
      if (!/^[0-9a-f]{64}$/.test(key)) throw new TypeError(`revoked[${i}]: a server key in lowercase hex expected`);
      return key;
    }),
    keeps: jsonInt(o.keeps, "keeps"),
    ai: jsonBool(o.ai, "ai"),
  };
}

/** The JSON form of `spec` (integers of 64 bits as strings): what `chatSpecFromJson` reads back. */
export function chatSpecToJson(spec: GrainChatSpec): Json {
  const kind = (k: ParamKind): unknown => {
    if ("number" in k) return { number: { min: k.number.min.toString(), max: k.number.max.toString(), decimals: k.number.decimals } };
    if ("date" in k) return "date";
    if ("flag" in k) return "flag";
    return k;
  };
  return {
    slug: spec.slug,
    version: spec.version,
    intro: spec.intro,
    commands: spec.commands.map((c) => ({
      name: c.name, title: c.title, help: c.help,
      params: c.params.map((p) => ({ name: p.name, title: p.title, kind: kind(p.kind), required: p.required })),
      confirm: c.confirm, price: c.price.toString(),
    })),
    revoked: spec.revoked,
    keeps: spec.keeps,
    ai: spec.ai,
  };
}
