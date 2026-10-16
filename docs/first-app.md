# Your first app in ten minutes

An app in Saltix can be a chat: users talk to it in the wallet, it answers with cards it signs. You make the app in
Saltix, take the **developer key** it gives you, and run a server with it. The key is the server's whole configuration:
it names the app, its network and the server key the registry trusts (Saltix
[24-app-studio](https://github.com/corvise/saltix/blob/main/specs/24-app-studio.md)). There is nothing to host, no
domain and no certificate.

What you need: Saltix on your phone with some SALT for the deposit (the test network's faucet gives it), Node 20 or
newer, and a checkout of this repository.

## 1. Make the app in Saltix (2 minutes)

In Saltix: **Apps → My apps → New app**.

1. **The name**, as people see it.
2. **The slug**, the app's address in the registry. Saltix proposes one and shows the deposit for its length: 100 SALT for
   3–5 characters, 30 for 6–7, 10 for 8 or more. The deposit comes back 30 days after you retire the app.
3. **A username** (optional): `@name` then opens the app's chat.
4. **A category and a description.**
5. **Create.** The phone makes a server key, registers the app, names the key in the registry and signs a starting chat
   spec (an intro, no commands yet).
6. **The developer key** is shown once: `saltix-app:1:dsalt:6f4c…:your-app:…`. Copy it.

The developer key is a secret: whoever holds it speaks for your app until you replace it. Never post it in a chat or a
repository. You can replace or revoke it at any time (My apps → your app → Developer key); a replaced key stops working
at the block that takes the change, and a server running with it stops.

Keep the app **private** while you develop it: only you and the members you add can use it (My apps → your app). It goes
public when it is ready (step 4).

## 2. Run the example with your key (3 minutes)

```sh
git clone git@github.com:corvise/saltix-grains.git && cd saltix-grains
npm install
(umask 077 && pbpaste > app.key)            # the key from the clipboard into an owner-only file (Linux: xclip -o)
npm run example
```

```text
starting AppKey(dsalt 6f4c9ce9ccbafc18 your-app, key 1476ff04a2885b87…)
the chat of your-app answers at dsalt1q… on devnet (spec v3)
```

`npm run example` runs [`examples/hello-grain/server.mjs`](../examples/hello-grain/server.mjs): it reads the key from
`app.key` (or `SALTIX_APP_KEY`), finds the network's public relays, checks that the registry names the key for your
app, signs [`chat.json`](../examples/hello-grain/chat.json) with the key and answers. The key never appears in its
output.

In Saltix, tap your app in **My apps**: with its program running, it opens its chat, which is your app's **console**
(long-press manages the app instead). Pick **Say hello**: the answer is a card marked "from your-app, verified", because
the registry names the key that signed it. Try **A key** (a secret, masked until you tap it), **A report** (a CSV file
next to the relay) and **Fail on purpose** (below).

## 3. Add a command (3 minutes)

Make a project of your own beside the checkout:

```sh
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npm install ../saltix-grains/packages/server     # the SDK, as npm run example built it
mv ../saltix-grains/app.key . && echo app.key >> .gitignore
```

`chat.json` declares what users can send; its `slug` is your app's. Each command has a title, help and typed parameters;
the wallet draws the form and checks it before anything leaves the phone ([docs/chats.md](chats.md#the-spec)):

```json
{
  "slug": "your-app",
  "version": 2,
  "intro": { "en": "Rolls dice for you." },
  "commands": [
    {
      "name": "roll", "title": { "en": "Roll" }, "help": { "en": "Roll some dice" },
      "params": [
        { "name": "sides", "title": { "en": "Sides" }, "required": true,
          "kind": { "choice": { "options": [{ "value": "d6", "title": { "en": "Six" } }, { "value": "d20", "title": { "en": "Twenty" } }] } } }
      ]
    }
  ],
  "keeps": 0,
  "ai": false
}
```

`server.mjs`:

```js
import { readFileSync } from "node:fs";
import { AppKey, ChatServer, card, chatSpecFromJson, fileChatStore } from "@saltix/grain-server";

const appKey = AppKey.parse(readFileSync("app.key", "utf8"));
const spec = chatSpecFromJson(JSON.parse(readFileSync("chat.json", "utf8")));
const chat = await ChatServer.start({ appKey, spec, store: fileChatStore("chat.store.json"), log: console.log });

chat.command("roll", (ask) => {
  const sides = ask.args.sides === "d20" ? 20 : 6;
  return card().fields({ Rolled: String(1 + Math.floor(Math.random() * sides)) }).run("Again", "roll", { sides: ask.args.sides });
});
chat.text(() => card().text("Pick Roll below."));
```

```sh
node server.mjs
```

Every request names the user's language (`ask.lang`: `en`, `ru`, …, or `""` when the app does not say): answer in it
when you can, and in English otherwise.

The spec is signed by your server key, which may sign a spec while every command is free. A wallet keeps the highest
version it has seen: start above the spec Saltix signed when it made the app, and raise `version` with every change.
Each user gets the new spec before their next answer.

## 4. Go public (1 minute)

Until now only you could use the app. To let testers in, add them as members: **My apps → your app → Members** (roles:
*user* uses it, *developer* gets a server key of their own, *viewer* reads the app's page). A member's wallet proves the
account with every request; your handler sees it as `ask.member`.

When it is ready: **My apps → your app → Make public**. A public app is in the marketplace, anyone can open its chat,
and it never learns who its users are: each user is a key of their own in your app.

The same from the command line in the checkout (`npx grain …`): signed with the owner's key file on test networks, or,
without one, done in Saltix while the tool waits for the registry. `--node URL` is a test-network node's wallet
interface over plain HTTP: one you run, or a tunnel to one (`ssh -N -L 30334:127.0.0.1:30334 you@server`, then
`--node http://127.0.0.1:30334`; [README](../README.md#networks-and-where---node-comes-from)). Without a node, do these
in Saltix; `grain app-key` needs none:

```sh
grain access --slug your-app --private --member dsalt1q…:user --node URL   # members, while private
grain access --slug your-app --public --node URL                            # anyone
grain bind --handle @your_app --slug your-app --node URL                    # a username you hold opens its chat
grain app-key --file app.key                                                # the key's public parts; is it registered?
```

## When something fails, you hear of it

Your chat with your own app is its console. When a handler throws, the user gets "failed", and you and your developers
get a report in the console: the error, where it happened, the command and request, your app's version, the time in UTC
and the stack. Try it with **Fail on purpose** in the example.

To fix it with a coding agent: long-press the report → **Copy for an AI agent** → paste it into Claude Code (or
another agent) in your app's folder, with "fix this". The copy carries the app, the message's id and the time, and never
a secret: the SDK scrubs keys out of every report.

```js
const chat = await ChatServer.start({ appKey, spec, store: fileChatStore("chat.store.json"), version: "1.0.3" });
await chat.notifyTeam(card().text("Someone asked for a feature: dark dice"));   // feedback, digests, alerts
await chat.report(error, { context: { command: "/roll" } });                    // an error you caught yourself
```

Your app reaches you once you have written to it: your wallet proves who you are with each of your requests to your own
app, and the server remembers where your chat is. The same error is reported once an hour, with a count; the team gets
at most 100 such messages a day. More in [docs/chats.md](chats.md#your-apps-console).

## What the server does for you

- **Checks every request** as the protocol says: from its key's address, signed, alive, fitting the spec; a private
  app's from its owner and members only, judged against the registry and the accounts' current keys.
- **Signs every card** with your key, answers each request once, keeps answers in the user's mailbox while the phone is
  offline, and takes requests that came while it was down.
- **Watches the registry**: it starts only when the registry names the key, and stops — saying so in its log — once the
  key is replaced or revoked.
- **Reports its numbers**: users of the last day and 30 days and the requests, signed hourly and handed to its relay,
  which gossips them to every node; the marketplace and the explorer show them as "reported by the app". A private
  app reports none (its log says `stats_not_reported`) until it is public. It keeps nothing about a user longer than 30
  days for them.
- **Tells your team** what goes wrong: handlers' errors as reports in the console, folded within an hour and scrubbed of
  secrets.

## When it does not start

| It says | Do |
|---|---|
| `the registry does not name this server key for your-app: …` | The key was replaced or revoked, or the app retired: make a new developer key in Saltix |
| `the developer key is for devnet 6f4c…, but the network answering is …: was the network reset?` | The test network was reset: make the app and its key again |
| `not a developer key` / `a malformed developer key` | Copy the whole key again (it starts with `saltix-app:1:`) |
| `no public relays are known for mainnet` | Pass `node` (your own node's wallet interface) to `ChatServer.start`, or `NODE_RPC` to the example |
| `wallets write to the first server key the registry names` (a warning) | Requests reach the first key's server: run that one, or make yours first in Saltix |
