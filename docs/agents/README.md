# For coding agents

`AGENTS.md` at the repository's root (which `CLAUDE.md` points to) holds the rules every agent follows here, the
full-screen layout of an app's page among them. These pages go on from it:

- [Building an app](app.md): from a developer key to an app that runs, is tested and ships; the rules every app follows;
  how to act on an error report pasted from Saltix's console.
- [Working on the SDK](sdk.md): this repository's map, its commands and tests, the golden vectors, and how a change
  lands.
- [Cards](cards.md): the card design standard as rules: a status first, at most 6 actions, short labels, destructive
  names, choices and polls, answering every tap, and `assertCardStandard` in the app's tests.

The specifications are the source of truth: corvise/saltix `specs/` 12-grains (manifest, bridge, bundles, publishing),
22-grain-chats (specs, requests, cards, the console), 24-app-studio (developer keys, private apps, members), 19-connect
(the Connect profile and sheet, Sign in with Saltix), 09-relay (relays, files). When a page here and a spec disagree, the spec wins and the page is a bug.
