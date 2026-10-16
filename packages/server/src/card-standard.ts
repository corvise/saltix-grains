// The card standard (Saltix 22-grain-chats §5a): how every Saltix lays a chat message out, so that an app designs its
// cards once. The rules here are the protocol's reference (`saltix_types::grain::chat::card`) in this SDK's form, and
// they reproduce its cases (`vectors/grain-chats-v1.json`, `cards`): the simulator draws by them, and `lintCard` checks
// a card against the guide built on them (docs/cards.md).
import type { Action, ChatMessage, PollOption } from "./chat.js";

/** A label of at most this many characters lets three actions share a row. */
export const SHORT_LABEL = 10;
/** At most this many, two a row; a longer label has a row of its own. */
export const MEDIUM_LABEL = 18;
/** A card at least this wide (dp) puts up to three actions in a row. */
export const THREE_FROM_DP = 320;
/** At least this wide (dp), up to two; narrower, one. */
export const TWO_FROM_DP = 220;
/** A choice: two or three `run` actions of one command, side by side. */
export const MAX_CHOICES = 3;
/** A poll without a tally of at most this many options, each label at most `SEGMENTED_LABEL` characters, is one
 *  segmented control. */
export const SEGMENTED_OPTIONS = 3;
export const SEGMENTED_LABEL = 12;
/** A field's value of one word this long or longer is drawn in monospace with Copy. */
export const TOKEN_CHARS = 20;
/** Lines of a `text` block before **More**. */
export const TEXT_LINES = 8;
/** Lines of a `code` block before **More**. */
export const CODE_LINES = 12;
/** File formats previewed as an image once downloaded. */
export const IMAGE_FORMATS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp"];
/** What a destructive command's name is, or starts with before its first `_`: its button is red and asks first. */
export const DESTRUCTIVE: readonly string[] = [
  "delete", "remove", "revoke", "cancel", "reset", "wipe", "erase", "destroy", "purge", "ban", "block", "kick", "reject",
  "deny", "disable", "unsubscribe", "unpublish", "leave",
];

/** How an action is drawn: the card's primary (filled), secondary (tinted), danger (red, asks first), a segment of a
 *  choice, the app's own button (`open`, with its icon), or the owner's panel (`publish`, never a button). */
export type Emphasis = "primary" | "secondary" | "danger" | "choice" | "app" | "owner";

/** A row of the action bar, by indices into the message's actions. */
export type ActionRow = { buttons: number[] } | { choices: number[] } | { app: number };

export interface CardLayout {
  emphasis: Emphasis[];
  rows: ActionRow[];
}

/** A label's length as the standard counts it: Unicode scalar values. */
export const labelLength = (label: string): number => [...label].length;

/** Whether `command` is destructive: its name, or its part before the first `_`, is one of `DESTRUCTIVE`. */
export const isDestructive = (command: string): boolean => DESTRUCTIVE.includes(command.split("_")[0] ?? "");

/** The most actions a row of a card `widthDp` wide holds. */
export const perRow = (widthDp: number): number => (widthDp >= THREE_FROM_DP ? 3 : widthDp >= TWO_FROM_DP ? 2 : 1);

/** The most actions a row may hold with `label` in it. */
export const capacity = (label: string): number => {
  const n = labelLength(label);
  return n <= SHORT_LABEL ? 3 : n <= MEDIUM_LABEL ? 2 : 1;
};

const plainRun = (a: Action): string | null => ("run" in a.kind && !isDestructive(a.kind.run.command) ? a.kind.run.command : null);

/** For each action, the first index of its choice, or -1: a whole run of 2–3 consecutive `run` actions of one command
 *  that is not destructive, whose labels all allow that many in a row, within `rowMax`. */
function choicesOf(actions: Action[], rowMax: number): number[] {
  const of = actions.map(() => -1);
  let i = 0;
  while (i < actions.length) {
    const command = plainRun(actions[i]!);
    if (command === null) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < actions.length && plainRun(actions[end]!) === command) end++;
    const len = end - i;
    const fits = actions.slice(i, end).every((a) => capacity(a.label) >= len);
    if (len >= 2 && len <= Math.min(MAX_CHOICES, rowMax) && fits) for (let j = i; j < end; j++) of[j] = i;
    i = end;
  }
  return of;
}

/**
 * The action bar of `actions` on a card whose rows hold at most `rowMax` (`perRow`): each action's emphasis — a
 * destructive `run` is danger, a choice's `run` a choice, the first other `run` the primary, the rest secondary, an
 * `open` the app's, a `publish` the owner's — and the rows, in order: a choice is a row, an `open` is a row, and the
 * other buttons fill rows, a row taking the next while every label in it (`capacity`) and `rowMax` allow one more.
 */
export function cardLayout(actions: Action[], rowMax = 3): CardLayout {
  const max = Math.min(3, Math.max(1, Math.trunc(rowMax)));
  const choice = choicesOf(actions, max);
  let primary = false;
  const emphasis: Emphasis[] = actions.map((a, i) => {
    const k = a.kind;
    if ("open" in k) return "app";
    if ("publish" in k) return "owner";
    if ("run" in k && isDestructive(k.run.command)) return "danger";
    if ("run" in k && choice[i] !== -1) return "choice";
    if ("run" in k && !primary) {
      primary = true;
      return "primary";
    }
    return "secondary";
  });
  const rows: ActionRow[] = [];
  let row: number[] = [];
  let room = max;
  const flush = () => {
    if (row.length) rows.push({ buttons: row });
    row = [];
  };
  actions.forEach((a, i) => {
    const e = emphasis[i]!;
    if (e === "owner") return;
    if (e === "app") {
      flush();
      rows.push({ app: i });
      return;
    }
    if (e === "choice") {
      if (choice[i] !== i) return;
      flush();
      const members: number[] = [];
      for (let j = i; j < actions.length && choice[j] === i; j++) members.push(j);
      rows.push({ choices: members });
      return;
    }
    const fits = Math.min(capacity(a.label), max);
    if (row.length && row.length + 1 > Math.min(room, fits)) flush();
    room = row.length ? Math.min(room, fits) : fits;
    row.push(i);
  });
  flush();
  return { emphasis, rows };
}

/** How a poll is drawn: one segmented control (open, no tally, at most 3 options of at most 12 characters) or a list. */
export function pollLook(options: PollOption[], closed: boolean, tally: boolean): "segmented" | "list" {
  const short = options.every((o) => labelLength(o.label) <= SEGMENTED_LABEL);
  return !tally && !closed && options.length <= SEGMENTED_OPTIONS && short ? "segmented" : "list";
}

/** Each option's share of `votes` in whole percent, summing to 100 (all 0 without votes): the floors, then the points
 *  left to the largest remainders, an earlier option first among equal ones. */
export function shares(votes: number[]): number[] {
  const v = votes.map((n) => BigInt(n));
  const total = v.reduce((a, b) => a + b, 0n);
  if (total === 0n) return votes.map(() => 0);
  const out = v.map((n) => (n * 100n) / total);
  const rest = (i: number) => (v[i]! * 100n) % total;
  const order = votes.map((_, i) => i).sort((a, b) => (rest(b) > rest(a) ? 1 : rest(b) < rest(a) ? -1 : a - b));
  let left = 100n - out.reduce((a, b) => a + b, 0n);
  for (const i of order) {
    if (left === 0n) break;
    out[i]! += 1n;
    left--;
  }
  return out.map(Number);
}

/** Whether a field's value is one word of at least `TOKEN_CHARS` characters: drawn in monospace with Copy. */
export const isToken = (value: string): boolean => labelLength(value) >= TOKEN_CHARS && !/\p{White_Space}/u.test(value);

/** Whether a file of `format` is previewed as an image. */
export const isImage = (format: string): boolean => IMAGE_FORMATS.includes(format);

/** Whether the card takes the reading width: it has actions, or a block other than text and statuses. */
export const isWide = (m: Pick<ChatMessage, "blocks" | "actions">): boolean =>
  m.actions.length > 0 || m.blocks.some((b) => !("text" in b) && !("status" in b));
