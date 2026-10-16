// The card design standard's lint (docs/cards.md): what a card does that Saltix draws badly, or that older wallets
// drop. Nothing here refuses a card: the bounds of the format (`chatMessageBoundsProblem`) do that. `ChatServer` logs
// each rule a card breaks once, and tests call `assertCardStandard`.
import { CODE_LINES, TEXT_LINES, cardLayout, isDestructive, labelLength } from "./card-standard.js";
import type { Card } from "./chat-card.js";
import type { Action, Block, GrainChatSpec } from "./chat.js";

/** The standard's numbers: a card is a glance. */
export const CARD_LIMITS = {
  /** Actions in the bar (a `publish` is the owner's panel and not counted). */
  actions: 6,
  /** Rows the bar takes on a phone. */
  rows: 3,
  /** A label's characters: longer has a row of its own (at most 10 lets three share a row). */
  label: 18,
  /** Blocks in a card. */
  blocks: 6,
  /** A status's characters: it reads as the card's one-line title. */
  status: 60,
  /** Rows of fields: more reads as a table, which goes as a file. */
  fields: 8,
  /** A text's characters before it should be a file; Saltix collapses it past `TEXT_LINES` lines anyway. */
  text: 600,
  /** A poll's options people read at a glance. */
  pollOptions: 6,
  /** A poll's question's characters. */
  question: 100,
  /** A code block's lines before it should be a file; Saltix collapses it past `CODE_LINES`. */
  code: 40,
} as const;

export type CardRule =
  | "actions" | "rows" | "label" | "choice" | "danger-confirm" | "unknown-command" | "blocks" | "status-first" | "statuses"
  | "status-length" | "fields" | "text-length" | "code-length" | "poll-options" | "polls" | "question" | "new-blocks";

export interface CardWarning {
  rule: CardRule;
  /** `warning`: Saltix draws it worse than it could be; `info`: worth knowing (older wallets, collapsing). */
  level: "warning" | "info";
  message: string;
}

const lines = (text: string) => text.split("\n").length;

/**
 * What `card` (a `Card`, or a message's blocks and actions) does against the card standard, in order of the card: an
 * empty list when it follows it. With `spec`, commands are checked too: one the spec does not have cannot be sent, and
 * a destructive one should be marked `confirm`.
 */
export function lintCard(card: Card | { blocks: Block[]; actions: Action[] }, spec?: GrainChatSpec): CardWarning[] {
  const { blocks, actions } = "shape" in card ? card.shape() : card;
  const out: CardWarning[] = [];
  const warn = (rule: CardRule, message: string) => out.push({ rule, level: "warning", message });
  const info = (rule: CardRule, message: string) => out.push({ rule, level: "info", message });

  if (blocks.length > CARD_LIMITS.blocks) warn("blocks", `${blocks.length} blocks: a card is a glance, at most ${CARD_LIMITS.blocks}; send the rest as a file`);
  const statuses = blocks.flatMap((b, i) => ("status" in b ? [i] : []));
  if (statuses.length > 1) warn("statuses", `${statuses.length} statuses: one is the card's title; update it in place (replace) instead`);
  if (statuses.length && statuses[0] !== 0) warn("status-first", "a status is the card's title: put it first");
  const polls = blocks.filter((b) => "poll" in b).length;
  if (polls > 1) warn("polls", `${polls} polls in one card: one question a card`);
  if (blocks.some((b) => "poll" in b || "code" in b)) {
    info("new-blocks", "poll and code blocks need a Saltix that draws them: 0.1.53 and older drop this whole message");
  }
  for (const b of blocks) {
    if ("status" in b && labelLength(b.status.text) > CARD_LIMITS.status) {
      warn("status-length", `a status of ${labelLength(b.status.text)} characters: it reads as one line (at most ${CARD_LIMITS.status}); details go in a text block`);
    }
    if ("fields" in b && b.fields.rows.length > CARD_LIMITS.fields) {
      warn("fields", `${b.fields.rows.length} rows of fields: more than ${CARD_LIMITS.fields} reads as a table; send a file (csv)`);
    }
    if ("text" in b && (labelLength(b.text.text) > CARD_LIMITS.text || lines(b.text.text) > TEXT_LINES)) {
      info("text-length", `a text past ${TEXT_LINES} lines is collapsed behind More; a long report goes as a file`);
    }
    if ("code" in b && lines(b.code.text) > CARD_LIMITS.code) {
      info("code-length", `${lines(b.code.text)} lines of code: Saltix shows ${CODE_LINES} before More; send a file`);
    }
    if ("poll" in b) {
      if (b.poll.options.length > CARD_LIMITS.pollOptions) {
        warn("poll-options", `${b.poll.options.length} options: people read at most ${CARD_LIMITS.pollOptions} at a glance; a long list belongs in a form`);
      }
      if (labelLength(b.poll.question) > CARD_LIMITS.question) warn("question", `a question of ${labelLength(b.poll.question)} characters: at most ${CARD_LIMITS.question}`);
    }
  }

  const bar = actions.filter((a) => !("publish" in a.kind));
  if (bar.length > CARD_LIMITS.actions) warn("actions", `${bar.length} actions: at most ${CARD_LIMITS.actions}; put the rest in the chat's commands or the app's screen`);
  const rows = cardLayout(actions, 3).rows.length;
  if (rows > CARD_LIMITS.rows) warn("rows", `the actions take ${rows} rows on a phone: at most ${CARD_LIMITS.rows}; shorten labels or drop actions`);
  for (const a of bar) {
    if (labelLength(a.label) > CARD_LIMITS.label) {
      warn("label", `"${a.label}" has ${labelLength(a.label)} characters and a row of its own: at most ${CARD_LIMITS.label} (10 lets three share a row)`);
    }
  }
  for (let i = 0; i < actions.length; ) {
    const k = actions[i]!.kind;
    let end = i + 1;
    if ("run" in k) while (end < actions.length && "run" in actions[end]!.kind && (actions[end]!.kind as { run: { command: string } }).run.command === k.run.command) end++;
    if (end - i > 3) warn("choice", `${end - i} buttons run ${(k as { run: { command: string } }).run.command}: a choice takes two or three; use a poll for more`);
    i = end;
  }
  if (spec) {
    const commands = [
      ...actions.flatMap((a) => ("run" in a.kind ? [a.kind.run.command] : [])),
      ...blocks.flatMap((b) => ("poll" in b ? [b.poll.command] : [])),
    ];
    for (const name of new Set(commands)) {
      const command = spec.commands.find((c) => c.name === name);
      if (!command) warn("unknown-command", `the spec has no command ${name}: the wallet cannot send it`);
      else if (isDestructive(name) && !command.confirm) {
        info("danger-confirm", `${name} is destructive: Saltix asks before it anyway; mark it confirm so every reader asks`);
      }
    }
  }
  return out;
}

/** Throw when `card` breaks the card standard (its warnings; `info` too with `strict`): for a grain's own tests. */
export function assertCardStandard(card: Card | { blocks: Block[]; actions: Action[] }, spec?: GrainChatSpec, options: { strict?: boolean } = {}): void {
  const found = lintCard(card, spec).filter((w) => options.strict || w.level === "warning");
  if (found.length) throw new Error(`the card breaks the card standard (docs/cards.md):\n${found.map((w) => `- ${w.rule}: ${w.message}`).join("\n")}`);
}
