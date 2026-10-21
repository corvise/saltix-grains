# Saltix Connect: an account on a web page

> Reflects Saltix 19-connect (basis for implementation 2026-10-12; the Connect profile, the Connect sheet and "Sign in
> with Saltix", 2026-10-16; connection feedback, 2026-10-21), as of corvise/saltix `a6d0de6b` (2026-10-21). Section
> numbers are the specification's.

A web page learns which account its visitor holds, proven by that account's key on the visitor's phone, and shows what
concerns the account. Nothing secret leaves the phone, and connecting grants the page nothing: everything it then shows
is public on the chain, and every action stays a transaction the phone signs. The same standard, with its **Connect
profile** and **Connect sheet**, is what Saltix shows the first time a mini-app opens.

The SDK: `@saltix/connect` is the page's side (the session, the offer, the grant's checks, the button and dialog, a
site's profile read as a wallet reads it); `@saltix/grain-server` and `grain profile` / `grain connect-profile` make
and sign profiles. [docs/connect.md](../connect.md) is the guide. The vectors: `vectors/connect-v1.json` (offers,
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

**A grant is for display, never a server's login.** It carries no key, no token and no authority (§8), and no
server's challenge: whoever holds its bytes holds all it proves, and a relayed QR code (§8) can carry a real user's
grant into someone else's session, even one a server made. Saltix Connect signs nobody in to a website's server, and a
grant authenticates no one; a mini-app's server signs its users in with `grain_login` ([grains §5.1](grains.md#51-identity)). The SDK: `verifyGrant` (`checkGrant`,
`checkAccount`), `openLinkPayload`, `decodePayload`.

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
| QR life | 2 minutes | the page shows a new offer after it (policy) |
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
  version:   u8                       1
  subject:   Subject
  owner:     [u8; 32]                 the service's owner: a grain's owner, a site's operator
  revision:  u32                      at least 1, raised with every change
  texts:     Map<lang, ProfileText>   1–8 languages, "en" among them
  website:   Option<String>           an https link
  support:   Option<String>           an https link, a mailto: address, or a Saltix username "@name"
  terms:     Option<String>           an https link to its terms of use
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
- **Size.** The Borsh form is at most 8 192 bytes: English and Russian in full fit, eight full languages do not.
- **One encoding.** A reader takes only the canonical Borsh of a signed profile: it re-encodes what it decoded and
  refuses any difference (keys out of order or repeated, trailing bytes).
- **The key** speaks for `owner`: the owner's own Ed25519 key while the account has no controller, else one of its
  devices, a guardian excepted. **A server key never signs a profile**: its links send users somewhere, so only the
  owner chooses them.
- **The reasons** a reader gives, checked in this order: encoding, version, subject, revision, languages, tagline,
  about, highlights, privacy, website, support, terms, size, signature, then service, owner, key.
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
  compressed>"}`; absent links are `null`; bytes in lowercase hex. The
  signature covers the Borsh form, so a reader rebuilds it and checks; the order of keys does not matter. A mini-app's
  `connect.json` is the `profile` object without `owner` and `revision`.

The SDK: `signProfile`, `verifyProfile`, `profileProblem`, `checkGrainProfile`, `checkSiteProfile`,
`checkProfileOwner`, `profileToJson`, `profileFromJson`; `grain lint` checks every rule with the field and its limit.

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
   registry, not listed), its owner (username or short address), its category, its rating with the citizens' apart, its
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
   the app); for a hosted mini-app, that its owner can change its code at any time; and that Saltix never asks for the
   phrase or the PIN inside an app.
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
`verifyGrant`.

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
