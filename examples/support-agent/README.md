# The support agent

An app's support answered by the app's own program, in the app's chat (Saltix 22-grain-chats): the app's notes first,
a language model next when one is configured, and a person's `@name` taking over when neither can answer, when the user
asks for a person, or once the model answered a user's daily share. The guide is [docs/support.md](../../docs/support.md).

| File | What it is |
|---|---|
| `support.mjs` | the logic: `createSupportAgent` (the handlers `text`, `topics`, `human`), `readFaq`, `matchNote`, `claudeAnswerer` (a model from an Anthropic client) |
| `server.mjs` | the agent as an app's program, from the app's key alone (`npm run support-agent` in the checkout) |
| `faq.json` | the app's notes: per language a button's label, the question, its answer and the words that find it |
| `chat.json` | the chat's spec: its intro, the commands `topics` and `human`, `keeps` 0, and `ai`, which says whether a model answers |
| `connect.json` | the example's Connect profile; `support` is `null` until you name the app's own username (below) |

## Run it

```sh
npx grain pair                                # in the checkout: pairs its key with your app in Saltix (app.key)
SUPPORT_HUMAN=@anna npm run support-agent     # the person who takes over, named on the hand-over cards
```

- **A language model**: `npm install --no-save @anthropic-ai/sdk` in the checkout (in your own project, `npm install
  @anthropic-ai/sdk`), `ANTHROPIC_API_KEY` in the environment (never in a file of the repository), and `"ai": true` in
  `chat.json` with its `version` raised: users read whether a model answers before they write, so the agent refuses to
  start when the spec says otherwise than what runs. `SUPPORT_MODEL` names another model than `claude-opus-5-5`. The request asks for a short
  answer from the notes alone or a hand-over, and lets the API answer one that a model's safeguards decline with the
  model Anthropic recommends (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
- `SUPPORT_FAQ` names other notes; `CHAT_SPEC`, `CHAT_STORE`, `NODE_RPC`, `SALTIX_APP_KEY` and `SALTIX_APP_KEY_FILE` are
  read as `examples/hello-grain/server.mjs` reads them. The store (`support.store.json`) goes in `STATE_DIRECTORY` when
  systemd sets it.
- **Name it as the app's support**: in the app's project, `npx grain bind --handle @name --slug <slug>` (a username you
  hold), then `npx grain support @name` and `npx grain profile`.

## In your app's own program

One app, one key, one program: mount the handlers on the app's own `ChatServer`, under commands its `chat.json` names
(`topics`, `human`; text needs none), and import the SDK as `@saltix/grain-server` there:

```js
const agent = createSupportAgent({ notes: readFaq(JSON.parse(readFileSync("faq.json", "utf8"))), human: process.env.SUPPORT_HUMAN, model, log });
chat.text(agent.text);
chat.command("topics", agent.topics);
chat.command("human", agent.human);
```

`packages/server/test/support-agent.test.mjs` runs it end to end on `testChat` with the model faked: every card to the
card standard, the hand-over, the daily share, and a log that holds no user's words, key or address.
