# A support agent with an address of its own: what the SDK lacks

A design note (2026-10-28). The protocol lets an app's Connect profile name as its support an AI agent with a Saltix
address of its own (19-connect [§11.1](protocol/connect.md#111-the-format), with its holder's consent): a user opens a
chat with that address in Saltix's messenger, and the relays let a user whose messenger is not activated write to it
while the app is live. The SDK's support agent ([support.md](support.md), `examples/support-agent`) is instead the
app's own program answering in the app's chat, which every user reaches as well, and which the SDK holds to the
protocol's formats and vectors end to end. This note says exactly what an agent with an address of its own would need
that the SDK does not have, so that it is built on the protocol, not on a guess.

## What is there

- Registering an address of its own at the relays, signed by its own key: `RelayClient` with any Ed25519 secret
  (`signKeyBinding`, `signAddressRecord`; 09-relay §1.2), reconnecting by itself.
- Another plain address's messaging key from a record it checks itself (`get_key`, `messagingKeyOf`), sealed frames both
  ways (`sealFrame`, `openFrame`: `crypto_box` between messaging keys), a kept frame taken off the mailbox with a
  signed proof (`signMailboxAck`).
- The consent: `signSupportConsent`, `supportConsentFromEnvironment` (the key from `SALTIX_SUPPORT_KEY`), and
  `grain support consent` / `grain support <address> --consent F` for the profile.

## What is missing

1. **The messenger's message format.** A user's Saltix writes to an address as one person writes to another: a
   `message` frame whose sealed plaintext is the Saltix app's own envelope (a text, or a structured message: a reply, an
   edit, a deletion, a reaction, a file, a view-once note, a group's), with the receipts around it (`message_ack` with
   its proof, `message_read`, `typing`). The protocol's specifications fix the relays' frames (09-relay §3) and the
   sealing, not that envelope, and no golden vector holds it. This repository follows the protocol and defines no
   format of its own, so an agent here would read and write a guess, and misread or drop what a newer Saltix sends.
   **Needed**: the envelope specified in the protocol (09-relay), with vectors this repository syncs.
2. **Managed users.** `RelayClient` takes another address's messaging key only from a plain record (kind 0). A managed
   account (kind 5) publishes a managed record checked against its key event log (09-relay §1.4): an agent could
   neither open a managed user's message nor answer it. **Needed**: managed records in `records.ts`, checked with the
   offline log check the SDK already has (`keylog.ts`).
3. **Key rotation.** A person's key binding has an epoch (09-relay §1.2); a message sealed before a rotation opens only
   with the key of the epoch before. **Needed**: `RelayClient` keeping a correspondent's previous key for a while.
4. **The agent's own activation.** The support address answers by its own activation (44-messenger-activation §5): its
   answers are held (`activation_required`) until the address is activated, by `ActivateMessenger` (tag 67) from an
   account that holds the price in SALT. The SDK signs no such call. (An app's server key passes the gate, but its
   address is the app's chat's, which wallets speak to in the grain chat's format, not the messenger's.) **Needed**:
   the call in `registry.ts`, and a way for the agent's account to be funded.
5. **Being no person.** An agent should never count as a person online: its connection registers invisible
   (`register {invisible: true}`, 09-relay §3). **Needed**: the option in `RelayClient`.

With those, an `examples/support-address` agent would be: its own key from the environment, its consent for the app, its
activation, and the same answers and hand-over as `createSupportAgent`, over the messenger instead of the app's chat.

## Meanwhile

- The app's program answers in the app's chat (`examples/support-agent`), named as the support by a username bound to
  the app: every user reaches it, and nothing in it is a guess.
- A person may name their own address, or an agent of the Saltix app (which has an address of its own: account
  `index + 1` of the phrase, held on the phone's connection), as an app's support, with the consent they sign in Saltix.
