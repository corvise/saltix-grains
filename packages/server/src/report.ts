// Error reports for a grain's team (Saltix 24-app-studio §4): a card made for an AI agent to read. The owner opens the
// app's console in Saltix, long-presses the report, copies it "for an AI agent" and pastes it into a coding agent. The
// card says what failed (a status line), the error's name, message and top frame, the context (the command, the
// request, the app's version, the time in UTC) as fields, and the stack as text, trimmed to fit a card. Nothing secret
// goes in: developer keys, hex of 64 characters or more (keys, secrets, and also hashes and accounts, which cannot be
// told apart by look) and whatever the server adds to remove are scrubbed first. Identical errors (the same name,
// message and top frame) fold within `REPORT_FOLD_MS`: `ChatServer.report` sends one card and counts the rest.
//
// No Node APIs here: the simulator runs it in a browser.
import { type StatusState } from "./chat.js";
import { Card } from "./chat-card.js";

/** How long identical errors fold into one report: an hour. The count goes in the next card. */
export const REPORT_FOLD_MS = 3_600_000;

/** What an error report says about where it happened. Values become fields: scrubbed, on one line, at most 200
 *  characters. Further keys are added as fields of their own, up to the card's 16 rows. */
export interface ReportContext {
  /** The command that failed (`/key`), or "(text)". */
  command?: string;
  /** The request's id, hex. */
  request?: string;
  /** Your app's version: by default `ChatServer.start`'s `version`. */
  version?: string;
  [field: string]: string | number | bigint | boolean | null | undefined;
}

/** An error as a report reads it, scrubbed: its name, message, top frame and stack (frames and causes). */
export interface ErrorFacts {
  name: string;
  message: string;
  /** The first frame of the stack, as `at fn (file:line:col)`, or "". */
  top: string;
  /** The frames, then each cause's line and frames; "" when the error has none. */
  stack: string;
  /** Whether it was a refusal (`ChatRefusal`): the card's status says refused rather than failed. */
  refusal: boolean;
}

const DEVELOPER_KEY = /saltix-app:1:\S*/gi;
const LONG_HEX = /(?<![0-9a-f])[0-9a-f]{64,}(?![0-9a-f])/gi;
const MAX_CAUSES = 3;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` without secrets: each of `extra` (exact text, or a pattern) first, then anything that looks like a developer
 * key (`saltix-app:1:…`), then every run of 64 or more hex digits. A run of 63 survives: name keys and hashes in your
 * errors by their first 16 characters.
 */
export function scrubSecrets(text: string, extra: ReadonlyArray<string | RegExp> = []): string {
  let out = text;
  for (const e of extra) {
    if (typeof e === "string") {
      if (e.length >= 8) out = out.replace(new RegExp(escape(e), "g"), "[removed]");
    } else {
      out = out.replace(new RegExp(e.source, e.flags.includes("g") ? e.flags : e.flags + "g"), "[removed]");
    }
  }
  return out.replace(DEVELOPER_KEY, "[developer key removed]").replace(LONG_HEX, "[hex removed]");
}

/** One line: whitespace and control characters collapsed to single spaces, lone surrogates replaced. */
const oneLine = (text: string) => text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD").replace(/[\s\p{Cc}]+/gu, " ").trim();

/** Lines kept, other control characters (a tab, say) as spaces, lone surrogates replaced. */
const lines = (text: string) =>
  text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[^\P{Cc}\n]/gu, " ");

/** At most `max` characters (Unicode scalars), cut with "…". */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

const isFrame = (line: string) => /^\s*at\s/.test(line);

/** The frames of a V8 stack, each `at …`; any other engine's lines after the first. */
function framesOf(stack: string, message: string): string[] {
  const all = stack.split("\n");
  const frames = all.filter(isFrame).map((l) => l.trim());
  if (frames.length > 0) return frames;
  // Not V8: its lines, without the message it starts with.
  const skip = message.split("\n").length;
  return all.slice(stack.startsWith(message) || all[0]?.includes(message) ? skip : 0).map((l) => l.trim()).filter((l) => l.length > 0);
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return String(value);
  try {
    return cut(JSON.stringify(value) ?? String(value), 500);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** The facts of whatever was thrown, scrubbed with `extra` (see `scrubSecrets`). */
export function errorFacts(error: unknown, extra: ReadonlyArray<string | RegExp> = []): ErrorFacts {
  const scrub = (text: string) => scrubSecrets(text, extra);
  if (!(error instanceof Error)) {
    return { name: typeof error === "string" ? "Error" : `thrown ${error === null ? "null" : typeof error}`, message: scrub(describe(error)), top: "", stack: "", refusal: false };
  }
  const name = error.name || "Error";
  const message = String(error.message ?? "");
  const frames = typeof error.stack === "string" ? framesOf(error.stack, message) : [];
  const parts = [...frames];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; depth < MAX_CAUSES && cause !== undefined; depth++) {
    if (cause instanceof Error) {
      parts.push(`Caused by: ${cause.name || "Error"}: ${cause.message}`);
      if (typeof cause.stack === "string") parts.push(...framesOf(cause.stack, cause.message));
      cause = (cause as { cause?: unknown }).cause;
    } else {
      parts.push(`Caused by: ${describe(cause)}`);
      break;
    }
  }
  return {
    name: scrub(name), message: scrub(message), top: scrub(frames[0] ?? ""), stack: scrub(parts.join("\n")),
    refusal: error.name === "ChatRefusal",
  };
}

/** What makes two errors the same for folding: their name, message and top frame. */
export const errorFingerprint = (f: ErrorFacts): string => `${f.name}\u0000${f.message}\u0000${f.top}`;

const LABELS: Record<string, string> = { command: "Command", request: "Request", version: "App version" };
const TEXT_MAX = 4_000;
const VALUE_MAX = 200;

/** The text block: the full message when the field cut it, then the stack, cut at a line to fit a card. */
function textOf(f: ErrorFacts): string {
  const head: string[] = [];
  if ([...oneLine(f.message)].length > VALUE_MAX || f.message.includes("\n")) head.push("Message:", lines(f.message));
  if (f.stack) head.push("Stack:", lines(f.stack));
  const all = head.join("\n").split("\n");
  const kept: string[] = [];
  let size = 0;
  for (let i = 0; i < all.length; i++) {
    const line = cut(all[i]!, 1_000);
    const more = all.length - i;
    const tail = `… ${more} more line${more === 1 ? "" : "s"}`;
    // Room for this line, and for the tail should a later one not fit.
    if (size + [...line].length + 1 + (i + 1 < all.length ? tail.length + 1 : 0) > TEXT_MAX) {
      kept.push(tail);
      break;
    }
    kept.push(line);
    size += [...line].length + 1;
  }
  return kept.join("\n");
}

/**
 * The card a team gets for an error: a `failed` status (`refused` for a `ChatRefusal`) with the error's name and
 * message; fields for the app, the error, the message, where it happened, the context, the chat spec's version, the
 * time in UTC and, when folded errors came before it, how many and since when; the stack as text. Within a card's
 * bounds whatever the error says. `facts` are scrubbed already (`errorFacts`); the context is scrubbed here.
 */
export function reportCard(
  facts: ErrorFacts,
  about: {
    slug: string;
    at: number;
    context?: ReportContext;
    specVersion?: number;
    /** Occurrences this card covers, and since when (the last report's time), when errors were folded. */
    folded?: { times: number; since: number } | null;
    extra?: ReadonlyArray<string | RegExp>;
  },
): Card {
  const scrub = (text: string) => scrubSecrets(text, about.extra ?? []);
  const value = (text: string) => cut(oneLine(text) || "(empty)", VALUE_MAX);
  const state: StatusState = facts.refusal ? "refused" : "failed";
  const rows: Array<[string, string]> = [
    ["App", value(about.slug)],
    ["Error", value(facts.name)],
    ["Message", value(facts.message)],
  ];
  if (facts.top) rows.push(["Where", value(facts.top.replace(/^at\s+/, ""))]);
  const context = about.context ?? {};
  for (const key of ["command", "request", "version"]) {
    const v = context[key];
    if (v !== undefined && v !== null && String(v) !== "") rows.push([LABELS[key]!, value(scrub(String(v)))]);
  }
  if (about.specVersion !== undefined) rows.push(["Chat spec", `v${about.specVersion}`]);
  rows.push(["Time (UTC)", new Date(about.at).toISOString()]);
  if (about.folded) rows.push(["Occurrences", `×${about.folded.times} since the last report, ${new Date(about.folded.since).toISOString()}`]);
  for (const [key, v] of Object.entries(context)) {
    if (rows.length >= 16) break;
    if (key in LABELS || v === undefined || v === null || String(v) === "") continue;
    rows.push([cut(oneLine(scrub(key)) || "?", 40), value(scrub(String(v)))]);
  }
  const card = new Card().status(state, cut(oneLine(`${facts.name}: ${facts.message}`), VALUE_MAX)).fields(rows);
  const text = textOf(facts);
  if (text.trim()) card.text(text);
  return card;
}
