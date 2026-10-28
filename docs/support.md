# Support for your app

Who answers an app's users, and how they reach them. An app's Connect profile names its **support contact**
(`connect.json`'s `support`, Saltix 19-connect [§11.1](protocol/connect.md#111-the-format)): Saltix shows it on the
app's Connect sheet and its card, and opens it when a user taps it. It may be a person, or a program that answers and
hands over to a person when it cannot: this SDK's **support agent**.

## The four forms

| `support` | What a user's Saltix does | Who reaches it | Networks |
|---|---|---|---|
| `https://…` | opens the link outside Saltix | anyone | every |
| `mailto:help@…` | opens the user's e-mail app | anyone | every |
| `@name`, a Saltix username | opens a chat: the **app's chat** when the name is bound to the app (`grain bind --handle @name --slug <slug>`), where its program answers; else a chat with the person who holds the name | the app's chat: every user; a person: users whose messenger is activated | every |
| a Saltix address (`dsalt1…`) | opens a chat with that address | every user, before they activate their messenger too, while the app is live | from protocol version 9 |

- **An address is the owner's own, or carries its holder's consent** (format 2 of the profile, `support_consent`):
  nobody becomes an app's support without saying so. The relays let a user whose messenger is not activated write to
  that address alone, and only while the app is live (44-messenger-activation §5); the address answers by its own
  activation. A username, a link or an e-mail address never opens that way.
- **The text is canonical**: an address in lowercase Bech32m of the network's prefix (`dsalt`, `tsalt`, `salt`), of a
  kind people write from (personal or managed); a username as `@name`; a `mailto:` with one address and nothing after
  it. A link or an address of a host reserved for examples (`.example`) leads nowhere and is refused.
- **A username nobody holds is refused**: whoever minted it later would get the app's users' questions.

## Setting it

```sh
npx grain support @dice                     # a username bound to the app: its chat, where its program answers
npx grain support https://dice.app/help     # a link; help@dice.app reads as mailto:help@dice.app
npx grain support dsalt1q…                  # the owner's own address (protocol version 9 and later)
npx grain support dsalt1q… --consent support-consent.json   # another address, with its holder's consent
npx grain support                           # which one connect.json names
npx grain support --clear                   # none
npx grain profile                           # then set the profile in the registry, as for any change of it
```

`grain support` writes `connect.json` and checks the contact as the network will: what a username opens (and that
someone holds it), and for an address the network's protocol version, its prefix, the app's registered owner and the
consent's key, app, owner and signature on this network. A profile that names an address is format 2 (`"version": 2`);
every other contact keeps format 1, which every network takes. `grain lint` checks what holds whoever owns the app,
`grain profile` the rest against the registry, and refuses format 2 before the network runs protocol version 9 (saying
when it will). The owner may also set it in Saltix: My apps → the app → Connect profile.

From code: a profile of `version: 2` with `support` and `support_consent` (`signSupportConsent`), signed with
`signProfile`, checked with `supportProblem` (the contact and its consent alone) and `checkGrainProfile(s, slug, owner,
{ version, network, genesis })` as a block of that protocol version on that network reads it; `supportAccount` is the
account a wallet opens a chat with; `supportKind` says whether a contact opens a chat or a link.

## The consent

```text
SupportConsent { slug: String, owner: [u8; 32], key: [u8; 32], signature: [u8; 64] }
  signature: strict Ed25519 by key over derive("Saltix support consent v1", Borsh((genesis_hash, slug, owner)))
```

- **Who signs**: the address's holder, with the key the address is made of (a personal address's own key; a managed
  address's first root key). A person signs in their own Saltix and hands the consent to the owner. An agent whose key
  runs on a server signs with it from the environment, never a file:

  ```sh
  SALTIX_SUPPORT_KEY=<its secret, 64 hex digits> npx grain support consent --slug dice   # support-consent.json
  ```

  or `supportConsentFromEnvironment({ genesis, slug, owner })` from `@saltix/grain-server`. The consent is public: it
  goes into the profile. The owner runs `npx grain support <address> --consent support-consent.json`, then
  `npx grain profile`.
- **What it binds**: this app, this owner, this network. A new owner, or a reset network, needs a new consent; a site's
  profile names its operator's own address alone.
- **Refusals**, each for its reason: `consent_missing` (an address not the owner's, without one), `consent_unneeded`
  (one with a username, a link, an e-mail address or the owner's own address), `consent_key` (its key does not make
  the address), `consent_slug` (another app), `consent_owner` (another owner), `consent_signature` (it does not verify
  on this network), and `version` for format 2 before protocol version 9. `vectors/connect-profiles-v1.json` holds
  every one (`support_address`).

## The support agent: a program that answers

`examples/support-agent` is an app's support answered by **the app's own program, in the app's chat** (Saltix
22-grain-chats): every user reaches it, whether or not their messenger is activated, and its cards are signed by the
app's registered key, "from <slug>, verified".

- **Answers**: what a user writes goes first to the app's own notes (`faq.json`: a question, its answer and the words
  that find it, per language), then, when `ANTHROPIC_API_KEY` is set, to a language model that answers from those notes
  alone (`claudeAnswerer`; the key comes from the environment, never a file in a repository). A model's answer says so
  on its card, and `chat.json` says `"ai": true`, which users read before they write.
- **Hand-over**: a person's `@name` (`SUPPORT_HUMAN`) takes over when neither can answer, when the user asks for a
  person (the `human` command, or words such as "talk to a person"), when the model declines or fails, and once the
  model answered a user's daily share (20 questions). The card names the person.
- **Common questions**: the `topics` command lists the notes as buttons; a tap asks the note's question.
- **Logs** carry event names and numbers: where an answer came from (`rules`, `model`, `person`), the language, the
  time it took, a note's id. Never what a user wrote, an answer, a user's key or address.
- **One app, one key, one program**: mount it on the app's own `ChatServer`, under commands its `chat.json` names:

  ```js
  import { createSupportAgent, readFaq, claudeAnswerer } from "./support.mjs";
  const notes = readFaq(JSON.parse(readFileSync("faq.json", "utf8")));
  const agent = createSupportAgent({ notes, human: process.env.SUPPORT_HUMAN, model: null, log });
  chat.text(agent.text);
  chat.command("topics", agent.topics);
  chat.command("human", agent.human);
  ```

  Run alone, as an app of its own: `SUPPORT_HUMAN=@anna npm run support-agent` in the checkout (its key from
  `grain pair`'s `app.key` or `SALTIX_APP_KEY`, as `examples/hello-grain`'s).
- **Name it as the support**: bind a username you hold to the app (`npx grain bind --handle @name --slug <slug>`), then
  `npx grain support @name` and `npx grain profile`.

An agent with a Saltix address of its own, which users open in the messenger rather than the app's chat, is what the
protocol allows too; what the SDK still lacks for it is in [the design note](support-agent-address.md).

## What a user sees

1. The app's **Connect sheet** and card show its support: a link or an e-mail address opens outside Saltix; a
   username or an address opens a chat.
2. In the **app's chat**: its intro, and before the first message whether a language model answers (`ai`) and how long
   it keeps what users send (`keeps`: 0 for the agent). Answers are cards "from <slug>, verified"; a model's says so.
3. **The hand-over** names the person's `@name`: the user writes to them in Saltix's messenger, once it is activated.
4. A user who has **not activated their messenger** reaches the app's chat and a support address; a person's `@name`
   waits until they do.

## Privacy

What the agent keeps and where questions go are the app's own words, in `connect.json`'s privacy line and
`chat.json`'s `keeps` and `ai`: the agent keeps nothing past its answer, and a question its notes do not answer goes to
the language model's provider when one is configured, nothing about the user with it (no key, no address). A support
address and a username are public in the profile, as the app's.
