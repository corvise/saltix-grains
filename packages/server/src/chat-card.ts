// What a grain's server writes in its chat (Saltix 22-grain-chats §4): a card of blocks and actions, built here and
// signed by `ChatServer`; and arguments as handlers read them and `Run` actions fill them in.
import {
  type Action, type Block, type ChatArgs, type ChatValue, type Command, type ParamKind, STATUS, type StatusState, dayToIso, isoToDay,
  takesValue,
} from "./chat.js";
import { compareUtf8 } from "./bytes.js";
import type { FileRef } from "./file.js";
import type { Manifest } from "./manifest.js";
import { publishTextOf } from "./publish.js";

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

/** A publish action before its manifest is packed (`ChatServer` packs it with Node's zlib). */
interface PendingPublish {
  label: string;
  update: Manifest;
}

/** A poll's option as `Card.poll` takes it: its label (1–60 characters), the command's arguments for it, its votes. */
export interface PollChoice {
  label: string;
  args?: Args;
  votes?: number;
}

/** A poll before the spec types its options' arguments. */
interface PendingPoll {
  command: string;
  options: PollChoice[];
}

/**
 * A card: the blocks (1–16) and actions (0–8) of a message, in order. `ChatServer` signs it with the server key and
 * sends it. Each method checks nothing beyond its own shape; the message's bounds are checked when it is signed, and
 * `lintCard` checks it against the card standard (docs/cards.md): how every Saltix draws it.
 *
 * ```ts
 * card().status("done", "Your key is ready").secret("Key", "7KQ2-M9XA-4F", { expiresAt }).fields({ Site: "saltix.io" })
 *   .run("Renew", "renew", { id: "k-0042" }).run("Revoke", "revoke", { id: "k-0042" }).open("All keys", "keys")
 * card().poll("Lunch on Friday?", "vote", [{ label: "Pizza", args: { pick: "pizza" } }, { label: "Sushi", args: { pick: "sushi" } }])
 * card().text("Notes has a new version: its own screen. The owner approves it here.").publish("Review", nextManifest)
 * ```
 */
export class Card {
  /** The blocks as built; a poll's options get their arguments typed when the card is sent (`typedBlocks`). */
  readonly blocks: Block[] = [];
  private readonly items: Array<Action | PendingRun | PendingPublish> = [];
  private readonly polls = new Map<number, PendingPoll>();

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
  /** An invoice your server signed (`chat.invoice`, or `signInvoice`'s hex): it opens the wallet's own payment sheet. */
  invoice(signedInvoice: string | { hex: string }): this {
    this.blocks.push({ invoice: { invoice: typeof signedInvoice === "string" ? signedInvoice : signedInvoice.hex } });
    return this;
  }
  /** Where a request stands: working, done, refused or failed, with up to 200 characters. */
  status(state: StatusState, text = ""): this {
    this.blocks.push({ status: { state: STATUS[state], text } });
    return this;
  }
  /**
   * Text drawn as it is, in monospace with Copy: a command to paste, a log, a configuration (1–4 000 characters, line
   * breaks kept, tabs become 4 spaces). Never run. Saltix 0.1.53 and older drop a message with a code block.
   */
  code(text: string): this {
    this.blocks.push({ code: { text: text.replace(/\t/g, "    ") } });
    return this;
  }
  /**
   * A poll, or a choice without `tally` (22-grain-chats §4, §5a): `question` (1–200 characters) and 2–10 options, each
   * running `command` with its `args` (typed by the spec's parameters, as `run`'s) when tapped. Count the votes yourself
   * and answer a vote with `ask.update(card)`: this card again with the new `votes` and the user's `chosen` (an index).
   * `closed` takes no more votes. Saltix 0.1.53 and older drop a message with a poll.
   */
  poll(question: string, command: string, options: PollChoice[], settings: { chosen?: number | null; closed?: boolean; tally?: boolean } = {}): this {
    this.polls.set(this.blocks.length, { command, options });
    this.blocks.push({
      poll: {
        question, command, options: options.map((o) => ({ label: o.label, args: [], votes: o.votes ?? 0 })),
        chosen: settings.chosen ?? null, closed: settings.closed ?? false, tally: settings.tally ?? options.some((o) => o.votes !== undefined),
      },
    });
    return this;
  }
  /** The blocks, a poll's options' arguments typed by `commandOf` (the spec's commands), as `actions` types `run`'s. */
  typedBlocks(commandOf: (name: string) => Command | undefined): Block[] {
    return this.blocks.map((b, i) => {
      const pending = this.polls.get(i);
      if (!pending || !("poll" in b)) return b;
      const command = commandOf(pending.command);
      if (!command) throw new TypeError(`poll: the spec has no command ${pending.command}`);
      return { poll: { ...b.poll, options: b.poll.options.map((o, j) => ({ ...o, args: argsFor(command, pending.options[j]!.args ?? {}) })) } };
    });
  }
  /** The card's blocks and actions as the card standard reads them (`lintCard`, `cardLayout`): `run` arguments and a
   *  proposed manifest are left out. */
  shape(): { blocks: Block[]; actions: Action[] } {
    return {
      blocks: this.blocks,
      actions: this.items.map((item): Action => {
        if ("kind" in item) return item;
        if ("update" in item) return { label: item.label, kind: { publish: { manifest: "" } } };
        return { label: item.label, kind: { run: { command: item.command, args: [] } } };
      }),
    };
  }
  /**
   * A button that sends `command` with `args` at once when they fill its form (after "Send?" when the command is
   * `confirm` or destructive by name), and otherwise opens the form filled with them; a long press always opens the form.
   * The first `run` is the card's primary button; one whose command is named `delete`, `revoke`, `remove`… is red.
   */
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
  /**
   * A proposal of the grain's next manifest for its owner to approve (22-grain-chats §4): `update` is the manifest (this
   * grain's, a version above the registry's), its publishing link (`salt:grain-publish?m=…`), or the link's text after
   * `m=`. Send it to the team (`ChatServer.proposeUpdate` does both): wallets show it to the team only, and the owner's
   * Saltix draws **Review and approve** in its own words — `label` is for readers that list actions (at most 32
   * characters). One a message.
   */
  publish(label: string, update: Manifest | string): this {
    if (typeof update === "string") this.items.push({ label, kind: { publish: { manifest: publishTextOf(update) } } });
    else this.items.push({ label, update });
    return this;
  }
  /** The actions, `Run` arguments typed by `commandOf` (the spec's commands) and a proposed manifest packed by `pack`
   *  (`publishText`; `ChatServer` passes it). */
  actions(commandOf: (name: string) => Command | undefined, pack?: (m: Manifest) => string): Action[] {
    return this.items.map((item) => {
      if ("kind" in item) return item;
      if ("update" in item) {
        if (!pack) throw new TypeError("publish: pass the manifest's link, or send the card through ChatServer, which packs the manifest");
        return { label: item.label, kind: { publish: { manifest: pack(item.update) } } };
      }
      const command = commandOf(item.command);
      if (!command) throw new TypeError(`run: the spec has no command ${item.command}`);
      return { label: item.label, kind: { run: { command: item.command, args: argsFor(command, item.args) } } };
    });
  }
}

export const card = (): Card => new Card();
