// What a grain's server writes in its chat (Saltix 22-grain-chats §4): a card of blocks and actions, built here and
// signed by `ChatServer`; and arguments as handlers read them and `Run` actions fill them in.
import {
  type Action, type Block, type ChatArgs, type ChatValue, type Command, type ParamKind, STATUS, type StatusState, dayToIso, isoToDay,
  takesValue,
} from "./chat.js";
import { compareUtf8 } from "./bytes.js";
import type { FileRef } from "./file.js";

/** An argument as a handler reads it and a `Run` action takes it: text, choice → string; number → bigint in units of
 *  10^-decimals (a decimal string such as "12.50" is taken too); duration → seconds; date → "YYYY-MM-DD"; file →
 *  `FileRef`; flag → boolean. */
export type ArgValue = string | number | bigint | boolean | FileRef;
export type Args = Record<string, ArgValue>;

/** `value` of a handler's form as a value of `kind`, or null when it is not one. */
export function valueOf(kind: ParamKind, value: ArgValue): ChatValue | null {
  if ("text" in kind) return typeof value === "string" ? { text: value } : null;
  if ("choice" in kind) return typeof value === "string" ? { choice: value } : null;
  if ("flag" in kind) return typeof value === "boolean" ? { flag: value } : null;
  if ("duration" in kind) return typeof value === "number" ? { duration: value } : null;
  if ("file" in kind) return typeof value === "object" ? { file: value } : null;
  if ("date" in kind) {
    const day = typeof value === "string" ? isoToDay(value) : typeof value === "number" && Number.isInteger(value) ? value : null;
    return day === null ? null : { date: day };
  }
  if (typeof value === "bigint") return { number: value };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { number: BigInt(value) } : null;
  if (typeof value === "string") {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    const decimals = kind.number.decimals;
    if (!m || (m[3]?.length ?? 0) > decimals) return null;
    const units = BigInt(m[2]! + (m[3] ?? "").padEnd(decimals, "0"));
    return { number: m[1] ? -units : units };
  }
  return null;
}

/** A value as a handler reads it. */
export function argOf(value: ChatValue): ArgValue {
  if ("text" in value) return value.text;
  if ("choice" in value) return value.choice;
  if ("number" in value) return value.number;
  if ("duration" in value) return value.duration;
  if ("date" in value) return dayToIso(value.date);
  if ("file" in value) return value.file;
  return value.flag;
}

/** `args` for `command`, typed by its parameters and sorted by name: what a `Run` action carries. Every value must be
 *  of its parameter's kind and within its bounds; required ones may be left for the user to fill in. */
export function argsFor(command: Command, args: Args): ChatArgs {
  const out: ChatArgs = [];
  for (const [name, value] of Object.entries(args)) {
    const param = command.params.find((p) => p.name === name);
    if (!param) throw new TypeError(`${command.name}: no parameter ${name}`);
    const typed = valueOf(param.kind, value);
    if (typed === null || !takesValue(param.kind, typed)) throw new TypeError(`${command.name}.${name}: not a value this parameter takes`);
    out.push([name, typed]);
  }
  return out.sort((a, b) => compareUtf8(a[0], b[0]));
}

/** A run action before the spec types it. */
interface PendingRun {
  label: string;
  command: string;
  args: Args;
}

/**
 * A card: the blocks (1–16) and actions (0–8) of a message, in order. `ChatServer` signs it with the server key and
 * sends it. Each method checks nothing beyond its own shape; the message's bounds are checked when it is signed.
 *
 * ```ts
 * card().secret("Key", "7KQ2-M9XA-4F", { expiresAt }).fields({ Site: "saltix.io" }).status("done", "Opens the site once")
 *   .run("Revoke", "revoke", { id: "k-0042" }).open("All keys", "keys")
 * ```
 */
export class Card {
  readonly blocks: Block[] = [];
  private readonly items: Array<Action | PendingRun> = [];

  /** Text, line breaks kept, no markup: 1–4 000 characters. */
  text(text: string): this {
    this.blocks.push({ text: { text } });
    return this;
  }
  /** Rows of a label (1–40 characters) and a value (1–200): 1–16 of them. */
  fields(rows: Array<[string, string]> | Record<string, string>): this {
    this.blocks.push({ fields: { rows: Array.isArray(rows) ? rows : Object.entries(rows) } });
    return this;
  }
  /** A secret the wallet masks until tapped and never shows in notifications; hidden after `expiresAt` (Unix ms). */
  secret(label: string, value: string, options: { expiresAt?: number } = {}): this {
    this.blocks.push({ secret: { label, value, expires_at: options.expiresAt ?? 0 } });
    return this;
  }
  /** A file uploaded next to the relay (`ChatServer.upload`); `format` (1–16 of [a-z0-9]) says what it is: "csv",
   *  "json", "pdf", "md"… */
  file(file: FileRef, options: { title?: string; format: string }): this {
    this.blocks.push({ file: { file, title: options.title ?? "", format: options.format } });
    return this;
  }
  /** An invoice your server signed (`signInvoice`, hex): it opens the wallet's own payment sheet. */
  invoice(signedInvoice: string): this {
    this.blocks.push({ invoice: { invoice: signedInvoice } });
    return this;
  }
  /** Where a request stands: working, done, refused or failed, with up to 200 characters. */
  status(state: StatusState, text = ""): this {
    this.blocks.push({ status: { state: STATUS[state], text } });
    return this;
  }
  /** A button that opens `command`'s form filled with `args`, which the user may edit before sending. */
  run(label: string, command: string, args: Args = {}): this {
    this.items.push({ label, command, args });
    return this;
  }
  /** A button that opens the grain's screen with `start`. */
  open(label: string, start: string): this {
    this.items.push({ label, kind: { open: { start } } });
    return this;
  }
  /** A button that sends `text` (by default its label) as the user's reply. */
  reply(label: string, text = label): this {
    this.items.push({ label, kind: { reply: { text } } });
    return this;
  }
  /** The actions, `Run` arguments typed by `commandOf` (the spec's commands). */
  actions(commandOf: (name: string) => Command | undefined): Action[] {
    return this.items.map((item) => {
      if ("kind" in item) return item;
      const command = commandOf(item.command);
      if (!command) throw new TypeError(`run: the spec has no command ${item.command}`);
      return { label: item.label, kind: { run: { command: item.command, args: argsFor(command, item.args) } } };
    });
  }
}

export const card = (): Card => new Card();
