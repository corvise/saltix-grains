# For coding agents

`AGENTS.md` at the repository's root (which `CLAUDE.md` points to) holds the rules every agent follows here: an app's
page (safe by default, full screen only with `viewport-fit=cover`), what a page gets from Saltix (no design tokens),
checking first and rendering after, naming apps and people, and how this repository works. These pages go on from it:

- [Building an app](app.md): from a developer key to an app that runs, is tested and ships; the Connect profile; the
  rules every app follows; how to act on an error report pasted from Saltix's console.
- [Working on the SDK](sdk.md): this repository's map, its commands and tests, the golden vectors, and how a change
  lands.
- [Cards](cards.md): the card design standard as rules: a status first, at most 6 actions, short labels, destructive
  names, choices and polls, answering every tap, and `assertCardStandard` in the app's tests.

The protocol is the source of truth, and [docs/protocol/](../protocol/README.md) holds what an app needs of it, under
the specifications' names and section numbers: [grains](../protocol/grains.md) (12-grains: manifest, bridge, bundles,
publishing), [grain chats](../protocol/grain-chats.md) (22-grain-chats: specs, requests, cards, the console),
[app studio](../protocol/app-studio.md) (24-app-studio: developer keys, private apps, members),
[connect](../protocol/connect.md) (19-connect: the Connect profile and sheet, Sign in with Saltix),
[relays](../protocol/relays.md) (09-relay: relays, files), [the wallet interface](../protocol/wallet-interface.md) and
[the basics](../protocol/basics.md) (addresses, amounts, keys, people's names). When a page here and a protocol page
disagree, the protocol page wins and this page is a bug; when a protocol page and a golden vector disagree, the vector
wins.
