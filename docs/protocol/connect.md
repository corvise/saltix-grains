# Saltix Connect: an account on a web page

> Reflects Saltix 19-connect (basis for implementation 2026-10-12; the Connect profile, the Connect sheet and "Sign in
> with Saltix", 2026-10-16; connection feedback, 2026-10-21), as of corvise/saltix `a6d0de6b` (2026-10-21); the pool
> vocabulary (the miners' ratings on the sheet) as of corvise/saltix `e6448704` (2026-10-22); the profile's format 2, a
> support address with its holder's consent (protocol version 9, 2026-10-28), as of corvise/saltix `6671fabb`
> (2026-10-28); a server's login (§15, 2026-10-29) as of corvise/saltix `78618ec4` (2026-10-29), the amendment that
> wrote it, and its offer's 5 minutes (§15.4, §10) as the amendment of the same day sets them. Section numbers are the
> specification's.

A web page learns which account its visitor holds, proven by that account's key on the visitor's phone, and shows what
concerns the account. Nothing secret leaves the phone, and connecting grants the page nothing: everything it then shows
is public on the chain, and every action stays a transaction the phone signs. The same standard, with its **Connect
profile** and **Connect sheet**, is what Saltix shows the first time a mini-app opens.

The SDK: `@saltix/connect` is the page's side (the session, the offer, the grant's checks, the button and dialog, a
site's profile read as a wallet reads it) and, as `@saltix/connect/server`, a server's (§15: the keys made and kept at
the server, the login checked there, the page a courier); `@saltix/grain-server` and `grain profile` /
`grain connect-profile` make and sign profiles. [docs/connect.md](../connect.md) is the guide. The vectors: `vectors/connect-v1.json` (offers,
grants, logs) and `vectors/connect-profiles-v1.json` (profiles).

## 1. What it is

- **A page** shows a QR code (or, on the phone itself, a link that opens the wallet). The wallet shows which page asks
  and which account it would see; the user approves.
- **The wallet** answers with a login (the page's own session and origin, signed by a key of the account) through a
  relay's link slot, sealed to the page.
- **The page** checks the login against the chain, keeps it in the browser until the visitor disconnects, and reads the
  account's public data.
- Connecting is read only. A page that wants an action asks the wallet to do it, and the wallet shows and signs it like
  any other (§7).

## 2. The page's session

For each connection it offers the page makes:

- `sid`: 32 random bytes, its link slot at a relay;
- `Q`: an X25519 key pair, which the login is sealed to;
- `P`: an Ed25519 key pair, the session's identity (a non-extractable Web Crypto key where the browser offers Ed25519).
  The login names `P`, so it is good for this session only.

It connects to a relay over WebSocket and opens the slot (`link_open {sid}` → `link_opened {sid, relay}`,
[relays](relays.md#link-slots)), sending `link_open` again every few minutes to keep it, 30 minutes in all. A page that
shows a QR code for 2 minutes and then a new one, with a new slot and keys, leaves no valid QR code on a screen.

## 3. The offer

```text
saltix-connect:1:<relay node key>:<sid>:<Q>:<P>:<origin>:<name>
https://saltix.io/connect#saltix-connect:1:…        the same text after the #, for a page on the phone itself
```

- Every value is base64url without padding: the relay's node key, `sid`, `Q` and `P` are 32 bytes each; `origin` and
  `name` are UTF-8.
- `origin` is the page's as the browser serializes it (`location.origin`): `https://` or `http://`, a host of lowercase
  ASCII DNS labels (an internationalized name in its `xn--` form) or an IPv6 address in brackets, and `:port` only when
  the page has one (no leading zero, not the scheme's default); no path, no user, no trailing dot; at most 128 bytes.
- `name` is what the page calls itself, 1 to 40 bytes. Refused: Unicode's `Cc` and `Cf` characters (the bidirectional
  controls among them) and the line and paragraph separators (U+2028, U+2029). `vectors/connect-v1.json` lists the
  refused characters and an offer refused for each rule.
- The link is exactly `https://saltix.io/connect#` and the text: the fragment never reaches a server, so whoever serves
  that page learns nothing of the offer.
- The wallet takes an offer only from its scanner or from that link, never from a page's script.

## 4. The wallet

1. **It reads the offer** and refuses an origin that is not `https://` (a debug build also takes `http://localhost`,
   `http://127.0.0.1` and `http://[::1]`, any port).
2. **It says it saw the offer**: `ConnectSeen { tag: u8 = 0, at: u64 (Unix ms) }`, sealed like the login (§5). The page
   then shows "approve on your phone". Anyone who saw the QR could send one, so it moves nothing but the page's screen.
3. **It shows the request** on the Connect sheet (§12): the site's identity and profile, fetched from the offer's origin
   (§11.3), the origin's host in large type, and the account (its address) the page would see. A wallet with several
   accounts lets the user pick one. Cancelling sends nothing.
4. **It signs the login** with a key of the account (§5) and delivers the grant to the slot (`link_deliver`); it shows
   "connected" once the relay says the grant was delivered.
5. **It keeps a list** of the pages it connected (origin, time, account): Saltix's Settings → Connected apps and sites.

## 5. The login

```text
ConnectLogin {
  network:  [u8; 32]   the genesis hash
  account:  [u8; 32]   the account's id
  origin:   String     as in the offer
  sid:      [u8; 32]
  page:     [u8; 32]   P, the session's Ed25519 key
  at:       u64        Unix ms
}
message = derive("Saltix connect login v1", Borsh(ConnectLogin))

ConnectGrant {
  version:   u8          1
  login:     ConnectLogin
  signer:    DeviceKey   Ed25519 or P-256
  signature: [u8; 64]    over `message`: Ed25519, or P-256 over SHA-256 with a low s
}
```

- **A plain account** (kind 0) signs with its own key: `signer` is `Ed25519(account key)` and `account` that key's
  personal id.
- **A managed account** (kind 5, or an upgraded kind 0) signs with the phone's device key: a key the account's key event
  log lists as a current device.

**Sealing.** The grant (and `ConnectSeen`) is delivered as a link payload sealed to `Q`, bound to the slot and the
session:

```text
e = a fresh one-time X25519 secret;  E = X25519(e, 9);  S = X25519(e, Q)        an all-zero S is refused
key        = derive("Saltix link payload v1", S ‖ E ‖ Q)
ciphertext = XChaCha20-Poly1305(key, nonce = 24 zero bytes, aad = sid ‖ P, plaintext = Borsh(grant or ConnectSeen))
payload    = base64url(E ‖ ciphertext)
```

The plaintext's first byte tells the two apart: `0` a `ConnectSeen`, `1` a grant (its version); anything else is
refused. It is one Borsh value with nothing after it.

**The page takes a grant** when:

1. it opens for its own `Q` and its slot, and its version is 1;
2. `network` is the network the page reads, `origin` is the page's own, and `sid` and `page` are this session's;
3. `at` is within 10 minutes of the page's clock;
4. the signature verifies under `signer` (Ed25519 strictly, as the node does);
5. `signer` is the account's now. The page reads the account's key event log from a node (`account_log`) and:
   - for an Ed25519 signer whose personal id is `account`, the log is empty: the account has no controller. A kind 0 key
     authorizes nothing once its account upgraded, so its login is refused then;
   - otherwise the log is not empty, checks offline from the origin it starts from, and the controller it replays lists
     `signer` among the account's devices, not as a guardian. An address that has only received funds has no devices
     yet, so no login until its first transaction.

The address the page then shows is kind 0 for an empty log or a log whose origin is a key (an upgraded account), kind
5 for a log whose origin is a root. A payload that does not open for the slot, or decodes to neither a grant nor a
`ConnectSeen`, is ignored: anyone who saw the QR code can deliver to the slot.

The page keeps `{account, address, grant}` in the browser's storage for its origin until the visitor disconnects or
`CONNECT_LIFE` (30 days) passes. Anyone who saw the QR code could deliver a grant of their own account, so the page
always shows which account it now shows.

**A grant the page opened is for display, never a server's login.** It carries no key, no token and no authority
(§8), and no server's challenge: whoever holds its bytes holds all it proves, and a relayed QR code (§8) can carry a
real user's grant into someone else's session. A website's server signs its visitors in by the server-held mode (§15),
whose keys the server made and whose `sid` it spends; a mini-app's server by `grain_login`
([grains §5.1](grains.md#51-identity)). The SDK: `verifyGrant` (`checkGrant`, `checkAccount`), `openLinkPayload`,
`decodePayload`.

## 6. What the page shows

Through a node, with the account first: `account_get` (balances, channels, stake), `account_history` (moves of SALT and
WORK), and whatever else of the account is public ([wallet interface](wallet-interface.md#methods)). None of it needs
the grant; the grant only decides which account the page puts first, so a visitor does not type an address.

## 7. Actions

A page never signs. For an action it shows a button that opens the wallet on the same phone (a payment link,
[basics](basics.md#addresses)); the wallet shows the action like any other (what leaves the account, to whom and why)
and signs it. Saltix's own signing request QR serves an account's own linked browsers only, not a third-party page; an
action request for pages (`saltix-act:1:`, a QR code for a wallet on another phone) is specified for the operators'
console and not built for other sites yet.

## 8. Security and privacy

- **Secrets stay on the phone.** A grant proves the account to one page session; it carries no key, no token and no
  authority.
- **The relay sees an opaque payload** in a slot it cannot open.
- **A relayed QR.** A page could show another page's QR code (its own session at the real site); the user, seeing the
  origin, would connect the attacker's session there, which learns only the account's address, public anyway. The
  wallet shows the origin large so the user checks it.
- **No tracking.** The wallet reveals the address only to a page the user approved, never sends a login on its own, and
  a login names one session.

## 10. Parameters

| Parameter | Value | Meaning |
|---|---|---|
| `CONNECT_SKEW` | 10 minutes | how far a login's `at` may be from the page's clock |
| `CONNECT_LIFE` | 30 days | how long a page keeps a grant |
| `MAX_ORIGIN` | 128 bytes | an offer's origin |
| `MAX_NAME` | 40 bytes | an offer's name |
| QR life | 2 minutes | the page shows a new offer after it, by itself (policy: a page may choose 30 seconds to 10 minutes, and at most 3 for a server's offer, §15.4) |
| `MAX_PROFILE_BYTES` | 8 192 bytes | a Connect profile's Borsh form |
| Profile texts | tagline 1–80, about 0–600, highlights 0–4 of 1–60, privacy 0–300 characters; 1–8 languages | §11.1 |
| `MAX_LINK` | 256 bytes | a profile's website, support or terms |
| A site's profile | `/.well-known/saltix-connect`, 64 KiB, 5 s, kept a day | what a wallet fetches (§11.3) |
| A tap before asking again | 5 seconds | a mini-app asks for what the user declined on the sheet only after a tap (§12.2) |

## 11. The Connect profile

A service's own words about itself, structured so that every wallet lays them out the same way, and signed by a key
that speaks for the service's owner, so nobody else can put words in its mouth. One format for mini-apps and websites.

### 11.1. The format

```text
ConnectProfile {
  version:   u8                       the format: 1, or 2 (from protocol version 9)
  subject:   Subject
  owner:     [u8; 32]                 the service's owner: a grain's owner, a site's operator
  revision:  u32                      at least 1, raised with every change
  texts:     Map<lang, ProfileText>   1–8 languages, "en" among them
  website:   Option<String>           an https link
  support:   Option<String>           an https link, a mailto: address, a Saltix username "@name";
                                      in format 2 also a Saltix address
  terms:     Option<String>           an https link to its terms of use
  support_consent: Option<SupportConsent>   format 2 only, after terms: the support address's consent;
                                            format 1 encodes nothing here
}
SupportConsent {
  slug:      String                   the grain it answers for
  owner:     [u8; 32]                 the grain's owner it consents to
  key:       [u8; 32]                 the Ed25519 key the support address is Address v1 of
  signature: [u8; 64]                 strict Ed25519 by key over
             derive("Saltix support consent v1", Borsh((genesis_hash, slug, owner)))
}
Subject = 0 Grain { slug: String }                                a mini-app: its name, icon and category are its
                                                                  manifest's and registry record's
        | 1 Site  { origin: String, name: String, category: u8 }  a website: its origin as an offer's (§3), its name
                                                                  (1–32 characters), a category 0–9 (app-studio.md §6)
ProfileText {
  tagline:    String          what it is, in one line: 1–80 characters
  about:      String          what it does: 0–600 characters, line breaks allowed
  highlights: Vec<String>     what it is good at: 0–4 lines of 1–60 characters
  privacy:    String          what it keeps about a user: 0–300 characters
}
SignedConnectProfile { profile, key: DeviceKey, signature: [u8; 64] }
  by key over derive("Saltix connect profile v1", Borsh(profile)): Ed25519, or P-256 over SHA-256 with a low s
```

- **Texts.** Characters are Unicode scalar values. Refused everywhere: `Cc`, `Cf`, U+2028 and U+2029, as in an offer's
  name; a line feed (U+000A) only in `about`. No text starts or ends with a space or a line feed.
- **Languages.** Codes are 2–8 of `[a-z-]`. A reader shows its own language, else English.
- **Links.** `website` and `terms`: `https://`, an origin as a browser serializes it (a lowercase host, no user, no
  default port) and optionally a path, query or fragment, in printable ASCII without spaces (an internationalized name
  in its `xn--` form, the rest percent-encoded), at most 256 bytes. `support`: such a link; or `mailto:` with one
  address and nothing after it (a local part of 1–64 of ``[A-Za-z0-9.!#$%&'*+/=^_`{|}~-]`` with no leading, trailing or
  double dot, a lowercase domain of at least two labels); or a Saltix username in its canonical form (`@name`). Anything
  else (`http:`, `javascript:`, `data:`, `tel:`) is refused, so a wallet never opens a link a profile could turn
  against it.
- **A support address, with its holder's consent** (format 2, protocol version 9). An owner names who answers the
  app's users: a person, or an AI agent with an address of its own.
  - Format 2 is format 1's fields and, after `terms`, `support_consent`. A block of protocol version 8 or earlier
    refuses format 2 (`version`); from version 9 a block takes both. Format 1 keeps its bytes and never takes an
    address. A version above 2 is refused (`version`).
  - In format 2 `support` may also be a **Saltix address** of the network: its canonical text (lowercase Bech32m, the
    network's prefix `salt`, `tsalt` or `dsalt`; another spelling, another network's prefix or a broken checksum is
    refused, `support`), of a kind an account messages from (0 personal, 5 managed; a contract's or a system module's
    is refused).
  - **The address is the owner's own account, or it carries its holder's consent**, so an owner cannot name anyone's
    address to open a way to them. The consent's `key` is the key the address is Address v1 of (a personal address's
    own key, a managed address's first root key, whose root digest the address commits to); its `signature` covers
    the network's genesis hash, the grain's slug and the owner's account id, the Borsh of a 32-byte hash, a string (a
    `u32` length, then UTF-8) and a 32-byte id, in a domain of its own. Refused, each for its reason: no consent where
    one is needed (`consent_missing`), one where none is: a username, a link, an e-mail address, the owner's own
    address (`consent_unneeded`); a key that does not make the address (`consent_key`); another grain (`consent_slug`;
    a consent binds a grain, so a site's profile names its owner's own address alone); another owner
    (`consent_owner`); a signature that does not verify on the reader's network (`consent_signature`).
  - **Who checks.** A shard holds a `SetGrainProfile`'s profile to the block's version, its network's prefix and the
    consent's signature on its network; the registry does the same but the prefix. A reader that is not the chain
    takes format 2 whatever the version; a wallet checks the consent's signature on its own network and shows the
    address there.
  - **Wallets open a chat with it**, as they do for `@name`, and a user whose messenger is not activated reaches a live
    app's support address all the same, that address alone, when it is the owner's own or carries a consent; the
    address answers by its own activation. The holder signs its consent in its own wallet (an agent's in the app that
    holds it) and gives it to the owner, who puts it in the profile.
- **Size.** The Borsh form is at most 8 192 bytes: English and Russian in full fit, eight full languages do not.
- **One encoding.** A reader takes only the canonical Borsh of a signed profile: it re-encodes what it decoded and
  refuses any difference (keys out of order or repeated, trailing bytes).
- **The key** speaks for `owner`: the owner's own Ed25519 key while the account has no controller, else one of its
  devices, a guardian excepted. **A server key never signs a profile**: its links send users somewhere, so only the
  owner chooses them.
- **The reasons** a reader gives, checked in this order: encoding, version, subject, revision, languages, tagline,
  about, highlights, privacy, website, support, consent_missing or consent_unneeded, consent_key, consent_slug,
  consent_owner, terms, size, signature, consent_signature, then service, owner, key.
- **The JSON form** (a site's well-known document, `grain_get`, the SDK's files):

  ```json
  {
    "profile": {
      "version": 1,
      "subject": { "grain": { "slug": "split-bill" } },
      "owner": "<hex, 32 bytes>",
      "revision": 3,
      "texts": { "en": { "tagline": "…", "about": "…", "highlights": ["…"], "privacy": "…" } },
      "website": "https://splitbill.example/about", "support": "@splitbill_help", "terms": null
    },
    "key": { "ed25519": "<hex, 32 bytes>" },
    "signature": "<hex, 64 bytes>"
  }
  ```

  A site's subject is `{"site": {"origin", "name", "category"}}`; a phone's key is `{"p256": "<hex, 33 bytes, SEC1
  compressed>"}`; absent links are `null`; bytes in lowercase hex. Format 2 adds `"support_consent": {"slug", "owner":
  hex, "key": hex, "signature": hex} | null` to `profile`, and format 1's form has no such key. The
  signature covers the Borsh form, so a reader rebuilds it and checks; the order of keys does not matter. A mini-app's
  `connect.json` is the `profile` object without `owner` and `revision`.

The SDK: `signProfile`, `verifyProfile`, `profileProblem`, `checkGrainProfile`, `checkSiteProfile` (each with a
reading: the block's protocol version, the network, its genesis hash), `checkProfileOwner`, `profileToJson`,
`profileFromJson`; for a support address `supportAddress`, `supportProblem`, `supportAccount`, `signSupportConsent`,
`verifySupportConsent` and `supportConsentFromEnvironment`; `grain lint` checks every rule with the field and its limit,
and `grain support` writes a contact ([support](../support.md)). `vectors/connect-profiles-v1.json`'s `support_address`
holds format 2's cases as a block of version 8 and one of version 9 read them.

### 11.2. A mini-app's profile lives in the registry

A grain's profile is a document of its own beside the manifest, carried by the registry (`SetGrainProfile`,
[grains §3](grains.md#3-registry)): the owner sets it with a revision above the one the record holds, or clears it;
`grain_get` and `grain_list` show it (`profile`, its JSON form, and `profile_revision`); retiring the grain drops it.
The registry takes it only when it is the grain's (`slug`), its owner's (`owner`), in bounds, and signed by a key that
speaks for the owner when the call is taken and again when a pending one takes effect; the record keeps the highest
revision, so an older profile never comes back.

It is not in the manifest, because a wallet rebuilds a manifest's Borsh from its JSON to check its signature (a new
field there would make every older wallet refuse every grain with a profile), and it is not served by the app, because
a chat-only app has no origin and its program may be down when someone first opens it. A wallet takes a grain's profile
from the record, checks it (the grain's, the record's owner) and that its key still speaks for the owner; a profile
that fails is not shown, and the sheet says the app has none.

### 11.3. A website's profile lives at its origin

A site serves its signed profile, subject `Site` with its own origin, at:

```text
GET https://<origin>/.well-known/saltix-connect        the JSON form, application/json
```

Its offer stays as it is (§3). When a wallet reads an offer it fetches the profile from the offer's origin: no
cookies, no referrer, no redirect followed, at most 64 KiB, within 5 seconds. It takes the profile when it reads
strictly, its subject's origin is the offer's, and its key speaks for `owner` (by the owner's account at the wallet's
node; a reader that trusts no node checks the owner's key event log offline, as a page checks a grant). The origin
serves the profile, so the origin claims the account; the account's key signs the origin, so the account claims the
site.

- A wallet keeps a site's profile by origin for a day, and replaces it only with a higher revision.
- No profile, or one that fails: the sheet shows the origin and the name the offer gives, marked as the page's own
  words, and says that the site published no Connect profile.
- Fetching tells the site that a wallet read its offer, as `ConnectSeen` does; it reveals no account.

The SDK: `grain connect-profile` signs a site's profile with the operator's key file; `readSiteProfile`
(`@saltix/connect`) reads one as a wallet does.

## 12. The Connect sheet

One design in the wallet, the same for the first open of a mini-app and for a site's Connect request. It is the
wallet's own, never part of a page, and keeps to a page's frame inside the safe area.

### 12.1. What it shows, top to bottom

1. **Saltix Connect**, with Saltix's mark: whose sheet this is. A service's page can never draw it.
2. **The service's identity.** A mini-app: its icon, name, `@username` when one is bound, its mark (verified, in the
   registry, not listed), its owner (username or short address), its category, its rating with the miners' apart, its
   reported users labelled as reported by the app, and "on Saltix since" its registration. A site: its host in large
   type and its origin in full (what the user checks against the browser's address bar), its name, whether its profile
   checked, its owner when it did, its category, and whether this account connected to it before and when.
3. **About**: the profile's tagline, about text and highlights, attributed as the service's own words ("In its own
   words"). With no profile, a mini-app's manifest description stands in, said to be all its owner wrote.
4. **"To continue, sign in"**: what the service gets, as plain rows:
   - **Recognise you**, always: a pseudonymous ID for this service only, unlinkable to others; "it does not see your
     address". For a mini-app, its grain key.
   - **Your wallet address**, when asked (a mini-app's `address` permission; always for a site): "it can follow your
     activity on the blockchain: balances, transfers, names". Never called private data: what is on chain is public,
     and the address is what links it to the user.
   - **Notifications** (`notifications`): up to 10 a day, off at any time.
   - **Storage** (`storage`): up to 1 MiB, encrypted in the user's vault and synced across their devices.
   - **Messages through Saltix relays** (`relay`): under its ID for the user, never the address.
   - **Camera, microphone, location**: the phone asks the first time.
   - **Payments and contacts**, for every service: it can ask the user to pay or to pick a contact, and the user
     confirms each in the wallet's own sheet (or by quick pay within the user's daily limit).

   A mini-app's address and notifications rows have a switch, **off by default**; declining them still signs the user
   in. A site's address is what Connect gives, so its row has no switch.
5. The profile's **privacy summary**, as the service's words; its website, support and terms as links (opened outside
   the app; a support address or username opens a chat in the wallet, §11.1); for a hosted mini-app, that its owner
   can change its code at any time; and that Saltix never asks for the phrase or the PIN inside an app.
6. **Continue** and **Cancel**; **What is Saltix Connect?** explains that the service learns only what the rows say,
   nothing secret leaves the phone, every payment and transaction is confirmed in Saltix, and access is revoked in
   Settings at any time.

### 12.2. When it shows

- **A mini-app**: the first time the account opens it, whatever its form (a screen, or a chat-only app's home),
  verified or not. The app's team never sees it for its own app.
- **A site**: every offer read, since each is a new session; a site connected before says so and since when.
- **Later visits**: no sheet, unless the service asks for more. A new version of a mini-app that asks for permissions it
  never asked for shows the sheet again with the new rows only. A mini-app that asks the bridge for something the user
  switched off (`grain_requestAddress`, `grain_notifications_allow`) shows the sheet with that one row, only within 5
  seconds of the user's tap on the app; without a tap the request is refused (`4001`) and nothing shows.

### 12.3. What Continue does

- **A mini-app**: the wallet records, for this account and this grain, that the user agreed to open it, that it may
  sign in (`grain_login` asks nothing more), and the switches as set; then it opens the app. A switch left off is a
  refusal the app learns as `4001` when it asks.
- **A site**: it signs the login and delivers the grant (§4–§5).

### 12.4. Remembered and revoked

What the user agreed to is kept per service and account, on the phone, and revoked in a mini-app's ⋯ sheet →
Permissions and, for both kinds, in Settings → **Connected apps and sites**. Revoking a mini-app forgets its sign-in
and every switch, so its next open shows the sheet again (its stored data stays unless the user removes it too).
Revoking a site forgets the row on the phone; the page keeps the grant it holds until its visitor disconnects there or
30 days pass, and the grant never gave it more than the address.

### 12.5. Older wallets

Nothing breaks: an older wallet reads every manifest, offer and grant as before, shows its own screens, and never sees
a profile.

## 13. "Sign in with Saltix" on the web

A DEX or any DApp signs its users in with Saltix Connect:

1. The site publishes its profile at `/.well-known/saltix-connect` (§11.3), signed once with its operator's key.
2. It shows the **Sign in with Saltix** button: Saltix's mark and the words "Sign in with Saltix" ("Войти через
   Saltix"), on Saltix's navy with white text, or white with navy text on a dark page; at least 44 px tall, the mark at
   its left, corners rounded by a quarter of its height. Its look is fixed so that users recognise it everywhere.
3. A tap opens the session (§2): on a computer a QR code of the offer in a dialog titled "Saltix Connect" that says
   "Scan with Saltix to sign in"; on a phone the link (§3), which opens Saltix.
4. Saltix shows the Connect sheet with the site's profile; the user continues.
5. The page gets the grant through the relay, checks it (§5) and shows the account; it reads what is public through a
   node, and asks Saltix to sign every action (§7).

Relays use self-signed certificates that apps pin by their records ([relays](relays.md#relay-records-and-certificate-pinning));
a browser cannot pin, so a site reaches them through a WebSocket path of its own that pins them, or through a public
gateway once one exists. `@saltix/connect` does the page's side: `createConnect`, `signInButton`, `openConnectDialog`,
`verifyGrant`; a site with a session of its own signs in by §15 (`createConnect({server})`, `@saltix/connect/server`).

## 14. Connection feedback

The owner's rule (2026-10-21): the reference standard for every site, mini-app and developer. Three duties.

### 14.1. The page shows the connection the moment the login arrives

The page renders the connected state from the login itself, in the same browsing context, as soon as the grant checks
(§5): who (the address, shortened), since when, and how to disconnect. No reload, no polling, no Back. The code it
showed is gone with it: the slot is closed, and nothing offers the consumed offer again. **The link to Saltix must not
unload the page**: on Android an intent link (`intent:…#Intent;scheme=saltix-connect;package=io.saltix.app;
S.browser_fallback_url=<the https link>;end`), which the browser hands to the installed app as an external intent and
overrides the URL's loading instead of navigating the tab; elsewhere the https link, which iOS Safari hands to the app
without navigating. Never a new tab (the visitor comes back to a page still offering a consumed offer), never the https
link in an Android tab (the tab navigates, the page unloads, its slot dies). A page unloaded anyway and loaded again
within the slot's life opens the same slot with the same keys from `sessionStorage`, so the wallet's delivery, tried for
30 seconds, still lands. A page reached while its connection is kept shows it at once, and every tab of the origin
follows a connection made or forgotten in another. `@saltix/connect` does all of it; the page renders `connected`.

### 14.2. The page confirms to the wallet

The relay's `link_delivered` says a payload reached the slot's connection, not that a page took it. So the wallet shows
"connected" on the page's word, which travels the same way as the login, the other way round.

```text
ConnectReply {                       delivered to the page's slot right before the grant
  tag:    u8        2
  relay:  [u8; 32]  the node key of the wallet's relay, which holds the reply slot
  sid:    [u8; 32]  the reply slot
  key:    [u8; 32]  K: an X25519 key of this request, the confirmation is sealed to
  login:  [u8; 32]  the message of the login that follows (§5)
}
ConnectConfirm {                     the page's answer at the reply slot
  version: u8       1
  login:   [u8; 32] the message of the login the page took
  at:      u64      Unix ms
}
```

1. The wallet opens a reply slot on its own relay connection (`link_open`), makes `K`, and delivers `ConnectReply`
   to the page's slot sealed like a grant (first byte 2: an older page ignores it), then the grant. A relay that found
   no slot for the reply found none for the grant: both are delivered again; once the reply was delivered, the grant
   alone.
2. The page keeps the latest reply that opened for its slot and, when a grant checks, answers the reply whose `login`
   is that grant's login message — no other. `ConnectConfirm` is sealed to `K` as a link payload with
   `aad = reply sid ‖ P` and delivered with `link_deliver {relay, sid, payload}` on the page's own slot connection,
   which a relay takes from a connection holding a slot (09-relay §10.3 step 5); the page waits for `link_delivered`
   up to 5 seconds, then closes its slot. It carries no account and no address.
3. The wallet takes a confirmation that opens for `K`, its reply slot and the offer's `P`, of version 1, naming the
   login it sent, within 10 minutes of its clock. Then, and only then, "Connected".

Vectors: `reply`, `confirm` and `refused_confirms` in `vectors/connect-v1.json`.

### 14.3. The wallet's sheet ends, always

From Continue, within 40 seconds at most: **Connected** (the page's confirmation); **Login sent** (delivered, no
confirmation within 10 seconds: go back to the site; if it does not show you signed in, reload it and scan its new
code); **Not delivered** (30 seconds and the relay never found the slot: scan the code the page shows now);
**Failed** (could not sign, no relay, the relay refused). Delivery is tried again every 2.5 seconds while the relay
finds no slot, for 30 seconds in all. The wallet records the page in its list of connected sites once the grant was
delivered, confirmed or not.

### 14.4. The profile check has one reading

A site's profile is at `/.well-known/saltix-connect` and nowhere else; the registry holds mini-apps' profiles only. An
answer that is not a JSON object is **no profile** (the site's silence); a JSON document that is not a profile that
checks **did not check** (the site's mistake, with its reason). A single-page site that answers its page for every path
is never shown as a site whose profile failed.

## 15. A server's login

Everything above signs a visitor into a *page*: the grant is opened in the page, proves the account to that page's
session and is kept there for display. It is a bearer artefact — whoever holds its bytes within its ten minutes is the
visitor, and it names no challenge of any server — so a server must never take it as a login. The server-held mode
(2026-10-29) is normative for any site with a session: **the server holds the session, the page is a courier.** No
byte of any format changes; the wallet's part is §4, §5 and §14 unchanged, so every wallet that signs a login today
signs into a server that follows this section.

### 15.1. The mode

1. **The server makes the session** of §2 and keeps it: `sid` (32 random bytes), `Q` (an X25519 key pair, its secret
   kept) and `P` (an Ed25519 key pair, as a page makes one; nothing signs with it), with the origin it serves this page
   at and the moment it was made, for the offer's life (§15.4), bounded in number.
   It hands the page only `sid`, `Q`'s public key and `P`'s public key: **the page holds no secret**, and a page
   unloaded and loaded again (§14.1) keeps in its `sessionStorage` nothing a server did not already give it.
2. **The page opens the slot** at a relay with that `sid`, shows the offer of §3 — the relay's node key, `sid`, `Q`,
   `P`, its own origin and name — as the QR code and the link, and keeps the slot alive as any page does. **The origin
   in the offer is the page's own**, which the server knows and holds the login to; a server that serves several
   origins makes an offer per origin.
3. **The page forwards every payload** that reaches its slot to the server **sealed, as it came**, with its `sid`; it
   opens nothing and decodes nothing.
4. **The server opens** each payload with `Q`'s secret and `aad = sid ‖ P` (§5) and reads it as a page would: one that
   does not open or decode is ignored; a `ConnectSeen` is told to the page, which shows "Continue on your phone"; a
   `ConnectReply` (§14.2) is kept, the latest per offer; a grant goes through the checks of §15.2.
5. **The server opens the session** it grants — its own cookie or token, minted after the checks, never derived from
   `sid`, `P` or the grant, never chosen by the page — and answers the page with it and with the confirmation's sealed
   bytes (§15.3). The page renders the connected state the moment the answer comes (§14.1 holds).

### 15.2. The checks, in order

A grant opens a session only when every check holds, in this order; the server stops at the first that fails:

1. **The offer is live**: `sid` names an offer the server made, not spent, within its life.
2. **The payload opens** for this offer's `Q` with `aad = sid ‖ P`, decodes to one Borsh value with nothing after it,
   and its first byte is 1: a grant (§5).
3. **The login is this offer's** (§5 rules 2–3): `network` the server's, `origin` the one the offer was made for, `sid`
   and `page` this offer's, `|at − now| ≤ CONNECT_SKEW` by the server's clock.
4. **The signature verifies** under `signer` (§5 rule 4): Ed25519 strictly, as the node verifies, or P-256 with a low
   `s`.
5. **The signer is the account's** (§5 rule 5): the account's key event log from a node of the server's network
   (`node_status` first — its genesis the server's, its first account policy the one the log is replayed under; then
   `account_log`), checked offline as a page does: an empty log and the account's own Ed25519 key, or a current device
   of the controller the log replays, never a guardian, never the kind 0 key of an account that upgraded. A node that
   cannot answer leaves the grant **unchecked**, which is not a refusal: the server asks another node, or tells the page to have the login approved again; it never opens a
   session on a signature alone.
6. **The site's own rules** come after the protocol's — an allow-list, a time window, a role — and are the site's
   business.
7. **`sid` is spent** in the same step that takes the grant, so a second grant for the offer, or the first again, is
   refused as `spent`. A grant refused at any check **does not spend the offer**: the page keeps its code and the
   person it was shown to may still sign in; what a stranger who saw the QR delivers costs the offer nothing.

### 15.3. The confirmation

The page's confirmation to the wallet (§14.2) stays the page's duty, with the server doing what needs `Q` and `K`: once
the grant is taken, the server finds the kept reply whose `login` is the grant's login message, seals
`ConnectConfirm {version: 1, login, at}` to the reply's `K` with `aad = reply sid ‖ P`, and hands the sealed bytes and
the reply's `relay` and `sid` to the page with the session; the page delivers them on its own slot connection
(`link_deliver`, which the relay takes from a connection holding a slot), waits for `link_delivered` up to 5 seconds,
and closes its slot. The wallet then says **Connected**
(§14.3) on the server's word, carried by the page. Without a kept reply (an older wallet), or one for another login,
the page just closes its slot and the wallet ends in *Login sent*, as before.

### 15.4. Lifetimes and bounds

| What | Value | Rule |
|---|---|---|
| An offer at the server | `OFFER_LIFE`, 5 minutes | from its making; then dropped with its keys, whether or not its slot was ever opened. A code shown for a minute, then the scan, the sheet and the PIN fit in it; a code relayed or photographed off a screen dies with it, long before the slot's 30 minutes (amended 2026-10-29: it was `SLOT_LIFE`) |
| A code a page shows of it | at most 3 minutes unseen | then a fresh offer from the server, by itself, with no button to press: the page's policy (`qrLifeMs`, 2 minutes by default); never while the wallet's notice holds it or the visitor took it to Saltix on this phone (§14.1). The scan, the sheet and the PIN fit in what is left of `OFFER_LIFE` |
| A login's `at` | `CONNECT_SKEW`, 10 minutes | by the server's clock (§5 rule 3) |
| Grants per offer | one | `sid` spent with the grant taken (§15.2 step 7) |
| The confirmation's delivery | 5 seconds | the page's wait for `link_delivered` (§14.2) |
| Offers kept | bounded by the server | the oldest dropped first; the SDK keeps 10 000 at most, and the example site makes at most 10 a minute per client |
| The session's length | the site's policy | never longer than the site's own rule says |

### 15.5. What a site must never do

- **Take a page-held grant as a login**: a grant opened in a page (§5, §13) is for display there, and a server that
  exchanges one for a session, a token or an action signs in whoever copied its bytes. The server's login is the one
  whose keys the server made and whose `sid` it spends.
- **Hand the page a secret**: `Q`'s secret, a reply's `K`, a session's token before the checks; the page gets public
  keys, sealed bytes and the session the server minted.
- **Open a session on less than every check** of §15.2: a signature alone proves a key, not an account; a node of
  another network or genesis proves nothing; an unchecked grant is not a refusal and not a login.
- **Reuse an offer**, or keep one past its life; or make an offer whose origin is not the page's own.
- **Keep or log** the login's bytes, the account or the address beyond what the site needs to serve the person: a
  journal names outcomes, reasons and timings, as the wallet's telemetry does (§14.3).

The SDK: `createServerConnect({ node, network, genesis, origin, name })` with `offer()`, `take(forwarded, admit)`,
`confirm(sid)` and `drop(sid)` (`@saltix/connect/server`); `createConnect({ server: { offer, login } })` or a `Courier`
of the site's own (`@saltix/connect`); the JSON between them (`ServerOffer`, `Forwarded`, `Taken`, `Confirmation`) in
`courier.ts`; the whole site to copy in `packages/connect/example`. No new vectors: `vectors/connect-v1.json`'s grants,
reply and confirmation serve the server's path byte for byte ([docs/connect.md §5](../connect.md#5-the-two-modes-the-pages-own-and-the-server-held)).
