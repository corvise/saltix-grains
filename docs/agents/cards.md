# Cards: what an agent builds

The rules for every card an app's server sends. The full guide, with pictures, is [docs/cards.md](../cards.md); the
standard itself is Saltix 22-grain-chats §5a. Saltix draws every card by it, and so does the simulator.

## Rules

- **Status first, one line.** `card().status(state, text)` is the card's title: at most 60 characters, one a card.
  Build the card with it first even when its text depends on what comes after (an optional invoice, say): decide the
  text, then `card().status(…)`, then the rest. `examples/hello-grain` does, and its test holds every card to this.
  Details go under it, in a text or fields: the SDK's error report is titled `Error · TypeError` (cut at a word) and
  carries the error's name, its full message and the stack in its body.
- **At most 6 actions, 3 rows; labels at most 18 characters** (10 lets three share a row). An `open` takes a row.
- **At most 6 blocks**: a card is a glance; the rest goes as a file.
- **The first `run` is the primary button.** Order actions by what most users want.
- **Destructive commands are named so**: their name, or its part before the first `_`, is `delete`, `remove`, `revoke`,
  `cancel`, `reset`, `wipe`, `erase`, `destroy`, `purge`, `ban`, `block`, `kick`, `reject`, `deny`, `disable`,
  `unsubscribe`, `unpublish` or `leave`. They are drawn red and always ask; mark them `confirm` in the spec too.
- **Two or three `run`s of one command side by side are a choice** (a segmented control). For four or more values,
  or results, use `card().poll(...)`; for a primary and a danger button, use two commands.
- **A `run` sends at once** when its arguments fill the command's form; give all required arguments for one tap.
- **Answer every tap.** A poll's vote and a card whose buttons change: `ask.update(card)`, in place of the card tapped.
- **Fields** up to 8 rows; **text** up to 8 lines; more goes as a file (`chat.upload`, `.file(ref, {format})`).
- **Secrets** (keys, codes) in `secret`, never in `text` or `fields`. Commands to paste in `code`.
- **`code` and `poll` are dropped whole by Saltix 0.1.53 and older** (0.1.54 draws them). A card everyone must see
  keeps to the other blocks.

## Check

In the app's tests, for every card a handler returns:

```js
import { assertCardStandard } from "@saltix/grain-server";
assertCardStandard(card, spec);   // throws with each rule broken; { strict: true } for the info rules too
```

`lintCard(card, spec)` returns the list instead. A running `ChatServer` logs `card_standard` once per rule broken.
